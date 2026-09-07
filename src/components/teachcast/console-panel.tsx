"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Ban,
  Camera,
  Globe,
  Loader2,
  MonitorPlay,
  Play,
  Plug,
  PlugZap,
  SendHorizontal,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useAppStore } from "@/lib/store";
import { captureFrame, createToolCollector, getActiveVideoEl, imagePart, streamChat, textPart } from "@/lib/screen";
import { sessionWatchdog } from "@/lib/session-watchdog";
import { OPERATOR_SYSTEM_WITH_TOOLS } from "@/lib/prompts";
import { uid, type LLMMessage, type ManagedSessionStatus } from "@/lib/types";
import { ToolActivity } from "./tool-activity";
import { toast } from "sonner";

const EMPTY_MGMT: ManagedSessionStatus = { active: false, url: null, snapshot: null, snapshotAt: null, error: null };

/**
 * Managed-session console — the operator's side panel for long-running sessions:
 *  1. Live mirror of the shared screen with a real frame counter (2 fps sampler).
 *  2. Message-only operator -> LLM chat (no workflow steps recorded).
 *  3. Managed external session groundwork: a dedicated agent-browser session
 *     (teachcast-managed) whose lifecycle the operator controls here; the LLM
 *     will manage it through tools in an upcoming milestone.
 */
export function ConsolePanel() {
  const setConsoleOpen = useAppStore((s) => s.setConsoleOpen);

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-zinc-950/40" aria-label="Managed-session console">
      {/* header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800/80 px-3 py-2.5">
        <TerminalSquare className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-semibold text-zinc-100">Console</span>
        <Badge variant="outline" className="h-5 border-zinc-700 px-1.5 text-[10px] text-zinc-400">
          operator
        </Badge>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto h-7 w-7 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          onClick={() => setConsoleOpen(false)}
          aria-label="Close console"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 teachcast-scroll">
        <LiveMirror />
        <ManagedSession />
      </div>

      <OperatorChat />
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* 1. Live mirror + frame counter                                      */
/* ------------------------------------------------------------------ */

function LiveMirror() {
  const stream = useAppStore((s) => s.stream);
  const consoleStreaming = useAppStore((s) => s.consoleStreaming);
  const setConsoleStreaming = useAppStore((s) => s.setConsoleStreaming);
  const consoleFrames = useAppStore((s) => s.consoleFrames);
  const bumpFrames = useAppStore((s) => s.bumpConsoleFrames);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!consoleStreaming) return;
    const sampler = setInterval(() => {
      const v = getActiveVideoEl();
      const c = canvasRef.current;
      if (!v || !c || v.readyState < 2 || !v.videoWidth) return;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const scale = Math.min(c.width / v.videoWidth, c.height / v.videoHeight);
      const w = Math.round(v.videoWidth * scale);
      const h = Math.round(v.videoHeight * scale);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(v, (c.width - w) / 2, (c.height - h) / 2, w, h);
      bumpFrames();
    }, 500); /* 2 fps real sampling of the live stream */
    return () => clearInterval(sampler);
  }, [consoleStreaming, bumpFrames]);

  return (
    <section className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="mb-2 flex items-center gap-2">
        <MonitorPlay className="h-3.5 w-3.5 text-amber-400" />
        <span className="text-xs font-semibold text-zinc-200">Live replay mirror</span>
        <Badge variant="outline" className="ml-auto h-5 border-zinc-700 px-1.5 text-[10px] font-mono text-zinc-300">
          {consoleFrames} frame{consoleFrames === 1 ? "" : "s"}
        </Badge>
      </div>
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-black">
        <canvas ref={canvasRef} width={480} height={270} className="aspect-video w-full" />
      </div>
      <div className="mt-2 flex items-center gap-2">
        {!consoleStreaming ? (
          <Button
            size="sm"
            className="h-7 gap-1.5 bg-amber-500 text-black hover:bg-amber-400"
            disabled={!stream}
            onClick={() => {
              if (!stream) {
                toast.error("No live screen to mirror", { description: "Share your screen in the studio first." });
                return;
              }
              setConsoleStreaming(true);
            }}
          >
            <Play className="h-3 w-3" />
            Play
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 border-zinc-700 text-zinc-200 hover:bg-zinc-800"
            onClick={() => setConsoleStreaming(false)}
          >
            <Square className="h-3 w-3" />
            Stop
          </Button>
        )}
        <span className="text-[11px] text-zinc-500">
          {!stream
            ? "Share your screen in the studio to mirror it here."
            : consoleStreaming
              ? "Sampling the live stream at 2 fps."
              : "Mirror is stopped."}
        </span>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Managed external session (groundwork)                            */
/* ------------------------------------------------------------------ */

function ManagedSession() {
  const [mgmt, setMgmt] = useState<ManagedSessionStatus>(EMPTY_MGMT);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/managed-session", { cache: "no-store" });
      if (res.ok) {
        const s = await res.json();
        setMgmt((prev) => ({ ...prev, active: !!s.active, url: s.url ?? null, error: s.error ?? null }));
      }
    } catch {
      /* status check is best-effort */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (action: "open" | "snapshot" | "close") => {
    setBusy(action);
    try {
      const res = await fetch("/api/managed-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      if (action === "open") {
        setMgmt((prev) => ({ ...prev, active: true, url: data.url ?? prev.url, error: null }));
        toast.success("Managed session opened", { description: "chat.z.ai is up in the managed browser." });
      } else if (action === "snapshot") {
        setMgmt((prev) => ({ ...prev, snapshot: data.snapshot ?? "", snapshotAt: data.snapshotAt ?? null, error: null }));
      } else {
        setMgmt({ ...EMPTY_MGMT });
        toast.info("Managed session closed");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Managed session action failed";
      setMgmt((prev) => ({ ...prev, error: message }));
      toast.error("Managed session", { description: message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Globe className="h-3.5 w-3.5 text-amber-400" />
        <span className="text-xs font-semibold text-zinc-200">Managed session</span>
        <span
          className={`ml-auto h-2 w-2 rounded-full ${mgmt.active ? "bg-emerald-500" : "bg-zinc-700"}`}
          aria-label={mgmt.active ? "session active" : "session inactive"}
        />
      </div>
      <p className="truncate font-mono text-[11px] text-zinc-400" title={mgmt.url ?? undefined}>
        {mgmt.active && mgmt.url ? mgmt.url : "not connected"}
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          className="h-7 gap-1.5 bg-amber-500 text-black hover:bg-amber-400"
          disabled={busy !== null}
          onClick={() => act("open")}
        >
          {busy === "open" ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlugZap className="h-3 w-3" />}
          Connect chat.z.ai
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 border-zinc-700 text-zinc-200 hover:bg-zinc-800"
          disabled={busy !== null || !mgmt.active}
          onClick={() => act("snapshot")}
        >
          {busy === "snapshot" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />}
          Snapshot now
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 border-zinc-700 text-zinc-400 hover:bg-zinc-800"
          disabled={busy !== null || !mgmt.active}
          onClick={() => act("close")}
        >
          {busy === "close" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />}
          Disconnect
        </Button>
      </div>

      {mgmt.snapshot && (
        <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950 p-2 text-[10px] leading-relaxed text-zinc-400 teachcast-scroll">
          {mgmt.snapshot}
        </pre>
      )}
      {mgmt.snapshotAt && (
        <p className="mt-1 text-[10px] text-zinc-600">Snapshot from {new Date(mgmt.snapshotAt).toLocaleTimeString()}</p>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
        Groundwork: a dedicated agent-browser session (<span className="font-mono">teachcast-managed</span>) the LLM will
        supervise from this panel in an upcoming milestone.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Operator -> LLM chat (message-only)                              */
/* ------------------------------------------------------------------ */

function OperatorChat() {
  const messages = useAppStore((s) => s.consoleMessages);
  const thinking = useAppStore((s) => s.consoleThinking);
  const pushMessage = useAppStore((s) => s.pushConsoleMessage);
  const patchMessage = useAppStore((s) => s.patchConsoleMessage);
  const setThinking = useAppStore((s) => s.setConsoleThinking);
  const stream = useAppStore((s) => s.stream);

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  /* restore draft (including watchdog recovery) — message-only, no auto-resend */
  useEffect(() => {
    const rec = useAppStore.getState().pendingRecovery;
    if (rec?.kind === "console") {
      useAppStore.getState().setPendingRecovery(null);
      if (rec.text) setInput(rec.text);
      return;
    }
    const d = sessionWatchdog.loadDraft("console");
    if (d) setInput(d);
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || thinking) return;
    setInput("");
    sessionWatchdog.clearDraft("console");

    /* the operator's current view of the screen travels with the message */
    const frame = captureFrame();
    pushMessage({ id: uid(), role: "user", text, image: frame ?? undefined, ts: Date.now() });

    setThinking(true);
    sessionWatchdog.beginTurn("console");
    const asstId = uid();
    pushMessage({ id: asstId, role: "assistant", text: "", ts: Date.now(), streaming: true });
    try {
      const history: LLMMessage[] = messages
        .filter((m) => !m.error && m.text.trim())
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.text }));
      history.push({
        role: "user",
        content: frame ? [textPart(text), imagePart(frame)] : text,
      });
      await streamChat({
        system: OPERATOR_SYSTEM_WITH_TOOLS,
        messages: history,
        enableTools: true,
        onActivity: () => sessionWatchdog.activity(),
        onDelta: (d) => useAppStore.getState().patchConsoleMessage(asstId, (m) => ({ text: m.text + d })),
        onTool: createToolCollector((toolCalls) =>
          useAppStore.getState().patchConsoleMessage(asstId, { toolCalls })
        ),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "LLM call failed";
      patchMessage(asstId, { text: `LLM call failed: ${message}`, error: true });
      toast.error("The LLM call failed", { description: message });
    } finally {
      patchMessage(asstId, { streaming: false });
      setThinking(false);
      sessionWatchdog.endTurn();
    }
  };

  return (
    <div className="flex min-h-0 shrink-0 flex-col border-t border-zinc-800/80 pt-1" style={{ height: "46%" }}>
      <div className="flex items-center gap-2 px-1 py-1.5">
        <Plug className="h-3 w-3 text-zinc-500" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Operator → LLM</span>
        {stream && <span className="text-[10px] text-zinc-600">· current frame attached</span>}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-1 pb-2 teachcast-scroll">
        {messages.length === 0 && (
          <p className="px-1 text-[11px] leading-relaxed text-zinc-600">
            Short line to the LLM — e.g. “open the settings page and tell me what you see”. Messages are not recorded as
            workflow steps.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`max-w-[92%] rounded-xl border px-2.5 py-1.5 ${
                m.role === "user"
                  ? "rounded-br-sm border-amber-500/25 bg-amber-500/10"
                  : m.error
                    ? "rounded-bl-sm border-red-500/30 bg-red-500/10"
                    : "rounded-bl-sm border-zinc-800 bg-zinc-900"
              }`}
            >
              {m.role === "assistant" && <ToolActivity calls={m.toolCalls ?? []} />}
              <p
                className={`whitespace-pre-wrap text-[12px] leading-relaxed ${
                  m.role === "user" ? "text-amber-50" : m.error ? "text-red-200" : "text-zinc-200"
                }`}
              >
                {m.text}
                {m.streaming && !m.text && <span className="text-zinc-500">thinking…</span>}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-end gap-2 border-t border-zinc-800/60 p-2">
        <Textarea
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            sessionWatchdog.saveDraft("console", e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={thinking ? "The LLM is working…" : "Message the LLM — Enter to send"}
          rows={2}
          className="max-h-28 min-h-[44px] resize-none border-zinc-800 bg-zinc-900 text-xs text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-amber-500/50"
          aria-label="Operator message to the LLM"
        />
        <Button
          onClick={() => void send()}
          disabled={!input.trim() || thinking}
          size="icon"
          className="h-[44px] w-[44px] shrink-0 rounded-lg bg-amber-500 text-black hover:bg-amber-400"
          aria-label="Send operator message"
        >
          {thinking ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
