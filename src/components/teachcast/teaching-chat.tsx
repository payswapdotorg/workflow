"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Camera, CircleStop, Eraser, Loader2, SendHorizontal, Sparkles, TerminalSquare, Video, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useAppStore } from "@/lib/store";
import { captureFrame, createToolCollector, imagePart, streamChat, textPart } from "@/lib/screen";
import { captureSnapshotStep } from "@/lib/session-actions";
import { sessionWatchdog } from "@/lib/session-watchdog";
import { EXECUTE_SYSTEM_WITH_TOOLS, TEACH_SYSTEM_WITH_TOOLS } from "@/lib/prompts";
import { parseTeachCommand, synthesizeSteps } from "@/lib/teach-capture";
import { teachCapture } from "@/lib/teach-capture-live";
import { cursorBus } from "@/lib/llm-cursor";
import { abortExecRun, startExecRun } from "@/lib/exec-client";
import { uid, type LLMMessage } from "@/lib/types";
import { SaveWorkflowDialog } from "./save-workflow-dialog";
import { DraftReviewDialog } from "./draft-review-dialog";
import { ToolActivity } from "./tool-activity";
import { toast } from "sonner";

export function TeachingChat() {
  const messages = useAppStore((s) => s.sessionMessages);
  const steps = useAppStore((s) => s.sessionSteps);
  const thinking = useAppStore((s) => s.sessionThinking);
  const pushMessage = useAppStore((s) => s.pushSessionMessage);
  const patchMessage = useAppStore((s) => s.patchSessionMessage);
  const pushStep = useAppStore((s) => s.pushSessionStep);
  const setThinking = useAppStore((s) => s.setSessionThinking);
  const resetSession = useAppStore((s) => s.resetSession);
  /* M7 dual-cursor teaching */
  const chatMode = useAppStore((s) => s.chatMode);
  const setChatMode = useAppStore((s) => s.setChatMode);
  const captureArmed = useAppStore((s) => s.captureArmed);
  const captureEventCount = useAppStore((s) => s.captureEventCount);
  const execRun = useAppStore((s) => s.execRun);

  const [input, setInput] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking, execRun?.log.length]);

  /** Deterministic lesson protocol (M7): "watch this" arms capture, "learn
   *  this" folds the recording into a draft workflow. Handled LOCALLY — no
   *  LLM round-trip — so the protocol is exact and always available. */
  const handleTeachCommand = (cmd: "watch" | "learn"): boolean => {
    if (cmd === "watch") {
      if (!teachCapture.arm()) {
        pushMessage({ id: uid(), role: "assistant", text: "Nothing to watch yet — the stage is not mounted. Open the studio stage and try again.", ts: Date.now(), error: true });
        return true;
      }
      pushMessage({
        id: uid(),
        role: "assistant",
        text: "Recording. Demonstrate the actions on your shared screen now — every click and keystroke (with a frame of the screen at that instant) is being captured. Say “learn this” when you're done and I'll assemble the lesson into a draft workflow for your review.",
        ts: Date.now(),
      });
      return true;
    }
    /* learn */
    if (!teachCapture.isArmed() && teachCapture.getEvents().length === 0) {
      pushMessage({ id: uid(), role: "assistant", text: "Nothing is being recorded. Say “watch this” first, then demonstrate.", ts: Date.now() });
      return true;
    }
    const events = teachCapture.disarm();
    const draft = synthesizeSteps(events);
    if (draft.length === 0) {
      pushMessage({ id: uid(), role: "assistant", text: "I watched, but captured no clicks or typing — moves alone don't form steps. Demonstrate a click or some typing and say “learn this” again.", ts: Date.now() });
      return true;
    }
    useAppStore.getState().setDraftSteps(draft);
    pushMessage({
      id: uid(),
      role: "assistant",
      text: `Lesson captured: ${draft.length} step${draft.length === 1 ? "" : "s"}. Review the draft — coordinates are stored as hints and are re-grounded against a fresh snapshot every time the workflow runs.`,
      ts: Date.now(),
    });
    return true;
  };

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || thinking) return;

    /* 0. the deterministic lesson protocol never reaches the LLM */
    const cmd = parseTeachCommand(text);
    if (cmd) {
      const frame = captureFrame();
      if (!override) setInput("");
      sessionWatchdog.clearDraft("session");
      pushMessage({ id: uid(), role: "user", text, image: frame ?? undefined, ts: Date.now() });
      handleTeachCommand(cmd);
      return;
    }

    /* 1. capture the live frame at the exact moment of the message */
    const frame = captureFrame();
    if (!override) setInput("");
    sessionWatchdog.clearDraft("session");

    /* 2. record the teaching event (message step carries text + frame) */
    pushMessage({ id: uid(), role: "user", text, image: frame ?? undefined, ts: Date.now() });
    pushStep("message", frame ? { text, image: frame } : { text });

    /* 3. stream the LLM reply with the frame attached */
    setThinking(true);
    const asstId = uid();
    pushMessage({ id: asstId, role: "assistant", text: "", ts: Date.now(), streaming: true });
    sessionWatchdog.beginTurn("session", text);
    try {
      const history: LLMMessage[] = messages
        .filter((m) => !m.error && m.text.trim())
        .slice(-16)
        .map((m) => ({ role: m.role, content: m.text }));
      history.push({
        role: "user",
        content: frame ? [textPart(text), imagePart(frame)] : text,
      });
      await streamChat({
        /* M7 act mode: the LLM acts on the DEDICATED managed browser while its
           cursor is watched live on the stage mirror. */
        system: chatMode === "act" ? EXECUTE_SYSTEM_WITH_TOOLS : TEACH_SYSTEM_WITH_TOOLS,
        messages: history,
        enableTools: true,
        browserTarget: chatMode === "act" ? "managed" : undefined,
        onActivity: () => sessionWatchdog.activity(),
        onDelta: (d) => useAppStore.getState().patchSessionMessage(asstId, (m) => ({ text: m.text + d })),
        onTool: createToolCollector((toolCalls) =>
          useAppStore.getState().patchSessionMessage(asstId, { toolCalls })
        ),
        onCursor: (ev) => cursorBus.dispatch(ev),
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

  /* draft persistence + boot recovery (reload -> restore -> resubmit).
     page.tsx mounts this component as a child, so child effects run BEFORE the
     page effect that consumes the recovery record — the recovery consumer must
     therefore REACT to the store field rather than read it once on mount. */
  const sendRef = useRef(send);
  sendRef.current = send;
  const pendingRecovery = useAppStore((s) => s.pendingRecovery);
  useEffect(() => {
    if (!pendingRecovery || pendingRecovery.kind !== "session") return;
    const text = pendingRecovery.text;
    const resubmit = pendingRecovery.resubmit;
    const t = setTimeout(() => {
      /* consume AFTER acting: nulling synchronously would re-render, run this
         effect's cleanup, and cancel the resubmit before it fires */
      useAppStore.getState().setPendingRecovery(null);
      if (text) setInput(text);
      if (resubmit && text.trim()) void sendRef.current(text);
    }, 60);
    return () => clearTimeout(t);
  }, [pendingRecovery]);

  /* restore an unsent draft typed before a reload (no recovery involved) */
  useEffect(() => {
    const draft = sessionWatchdog.loadDraft("session");
    if (!draft) return;
    const t = setTimeout(() => setInput(draft), 0);
    return () => clearTimeout(t);
  }, []);

  const manualSnapshot = () => captureSnapshotStep();

  const hasSteps = steps.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* panel header */}
      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-4 py-2.5">
        <Bot className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-semibold text-zinc-100">Teaching chat</span>
        {/* M7 mode toggle: teach (demonstrate on YOUR screen) / act (LLM acts on the managed browser) */}
        <div className="flex overflow-hidden rounded-md border border-zinc-700" role="tablist" aria-label="Chat mode">
          <button
            role="tab"
            aria-selected={chatMode === "teach"}
            onClick={() => setChatMode("teach")}
            className={`flex h-6 items-center gap-1 px-2 text-[11px] font-medium transition-colors ${
              chatMode === "teach" ? "bg-amber-500 text-black" : "bg-transparent text-zinc-400 hover:bg-zinc-800"
            }`}
            title="Teach: you demonstrate on your shared screen — your cursor, your surface"
          >
            <Video className="h-3 w-3" />
            Teach
          </button>
          <button
            role="tab"
            aria-selected={chatMode === "act"}
            onClick={() => setChatMode("act")}
            className={`flex h-6 items-center gap-1 px-2 text-[11px] font-medium transition-colors ${
              chatMode === "act" ? "bg-sky-600 text-white" : "bg-transparent text-zinc-400 hover:bg-zinc-800"
            }`}
            title="Act: the LLM acts on the managed browser — its amber cursor moves on the stage mirror"
          >
            <Sparkles className="h-3 w-3" />
            Act
          </button>
        </div>
        {captureArmed && (
          <Badge className="h-5 gap-1 border-red-500/40 bg-red-500/15 px-1.5 text-[10px] font-semibold text-red-300" variant="outline">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-400" />
            </span>
            REC · {captureEventCount} event{captureEventCount === 1 ? "" : "s"}
          </Badge>
        )}
        <Badge
          variant="outline"
          className="hidden h-5 gap-1 border-zinc-700 px-1.5 text-[10px] text-zinc-400 lg:inline-flex"
          title="The LLM can act on the computer: read/write files, run shell commands and code, control a browser"
        >
          <TerminalSquare className="h-2.5 w-2.5" />
          Agent tools on
        </Badge>
        <Badge variant="secondary" className="ml-auto h-5 border-zinc-700 bg-zinc-800/70 text-[11px] font-medium text-zinc-300">
          {steps.length} event{steps.length === 1 ? "" : "s"} recorded
        </Badge>
        {chatMode === "teach" && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 border-zinc-700 px-2 text-xs text-zinc-300 hover:bg-zinc-800"
            onClick={manualSnapshot}
          >
            <Camera className="h-3 w-3" />
            Snapshot step
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              disabled={(!hasSteps && messages.length === 0) || thinking}
              className="h-7 w-7 p-0 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              aria-label="Clear session"
            >
              <Eraser className="h-3.5 w-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="border-zinc-800 bg-zinc-900">
            <AlertDialogHeader>
              <AlertDialogTitle>Clear this teaching session?</AlertDialogTitle>
              <AlertDialogDescription>
                All chat messages and {steps.length} recorded event{steps.length === 1 ? "" : "s"} will be discarded.
                Saved workflows in the Library are not affected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-red-600 text-white hover:bg-red-500"
                onClick={() => {
                  resetSession();
                  toast.info("Session cleared");
                }}
              >
                Clear session
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* message list */}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4 teachcast-scroll">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900">
              <Workflow className="h-6 w-6 text-amber-400" />
            </div>
            <div className="max-w-xs">
              <p className="text-sm font-medium text-zinc-200">Teach the LLM a workflow</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                Share your screen, then narrate each action while you perform it — e.g. “Now I click Export in the
                toolbar to open the export dialog”. Every message snapshots the screen, and the assistant follows
                along live.
              </p>
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5">
                {m.image && (
                   
                  <img
                    src={m.image}
                    alt="Screen frame captured with this message"
                    className="mb-2 max-h-40 w-full rounded-lg border border-amber-500/20 object-cover"
                  />
                )}
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-amber-50">{m.text}</p>
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex justify-start">
              <div
                className={`max-w-[92%] rounded-2xl rounded-bl-md border px-3.5 py-2.5 ${
                  m.error ? "border-red-500/30 bg-red-500/10" : "border-zinc-800 bg-zinc-900"
                }`}
              >
                <ToolActivity calls={m.toolCalls ?? []} />
                {m.text ? (
                  <p className={`whitespace-pre-wrap text-sm leading-relaxed ${m.error ? "text-red-200" : "text-zinc-200"}`}>
                    {m.text}
                  </p>
                ) : (
                  <span className="flex items-center gap-1.5 text-sm text-zinc-500">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> thinking…
                  </span>
                )}
                {m.streaming && m.text && (
                  <span className="mt-1 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-amber-400" />
                )}
              </div>
            </div>
          )
        )}
        {/* M7 execution run log — the honest record of what ran on the managed browser */}
        {execRun && <ExecRunBlock />}
      </div>

      {/* composer */}
      <div className="border-t border-zinc-800/80 p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              sessionWatchdog.saveDraft("session", e.target.value);
            }}
            onKeyDown={(e) => {
              /* Enter sends; Shift+Enter newline. Skip while an IME composition
                 is in progress so confirming candidates doesn't misfire. */
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              thinking
                ? "Waiting for the assistant…"
                : chatMode === "act"
                  ? "Instruct the LLM — it acts on the managed browser and its cursor moves on the stage. Enter to send."
                  : "Narrate what you are doing on screen — Enter to send, Shift+Enter for a new line. Say “watch this” to record a lesson."
            }
            rows={2}
            className="max-h-36 min-h-[52px] resize-none border-zinc-800 bg-zinc-900 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-amber-500/50"
          />
          <Button
            onClick={() => void send()}
            disabled={!input.trim() || thinking}
            size="icon"
            className="h-[52px] w-[52px] shrink-0 rounded-xl bg-amber-500 text-black hover:bg-amber-400"
            aria-label="Send message"
          >
            {thinking ? <Loader2 className="h-5 w-5 animate-spin" /> : <SendHorizontal className="h-5 w-5" />}
          </Button>
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <p className="text-[11px] leading-none text-zinc-600">
            {steps.length > 0
              ? `${steps.length} step${steps.length === 1 ? "" : "s"} will be compiled into the workflow.`
              : "Steps are recorded from your messages and snapshots."}
          </p>
          <Button
            onClick={() => setSaveOpen(true)}
            disabled={!hasSteps || thinking}
            size="sm"
            className="h-8 gap-1.5 bg-amber-500 text-black hover:bg-amber-400"
          >
            <Workflow className="h-3.5 w-3.5" />
            Save as workflow
          </Button>
        </div>
      </div>

      <SaveWorkflowDialog open={saveOpen} onOpenChange={setSaveOpen} />
      <DraftReviewDialog />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* M7 execution run block — live, honest log of the managed-browser run */
/* ------------------------------------------------------------------ */

function ExecRunBlock() {
  const execRun = useAppStore((s) => s.execRun);
  if (!execRun) return null;
  return (
    <div className="flex justify-start">
      <div className="w-[92%] rounded-2xl rounded-bl-md border border-sky-500/25 bg-sky-500/5 px-3.5 py-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-sky-400" />
          <span className="text-xs font-semibold text-sky-200">Execution · managed browser</span>
          {execRun.status === "running" && (
            <span className="flex items-center gap-1 text-[10px] text-sky-300/80">
              <Loader2 className="h-3 w-3 animate-spin" /> running
            </span>
          )}
          {execRun.status !== "running" && (
            <Badge
              variant="outline"
              className={`h-4 px-1 text-[9px] ${
                execRun.status === "finished"
                  ? "border-emerald-500/40 text-emerald-300"
                  : execRun.status === "aborted"
                    ? "border-zinc-600 text-zinc-400"
                    : "border-red-500/40 text-red-300"
              }`}
            >
              {execRun.status}
            </Badge>
          )}
          {execRun.status === "running" && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-6 gap-1 border-red-500/40 px-1.5 text-[10px] text-red-300 hover:bg-red-500/10"
              onClick={() => abortExecRun()}
            >
              <CircleStop className="h-3 w-3" />
              Stop run
            </Button>
          )}
        </div>
        <ol className="space-y-1">
          {execRun.log.map((entry) =>
            entry.type === "msg" ? (
              <li key={entry.id} className="text-[12px] leading-relaxed text-zinc-300">
                {entry.text}
              </li>
            ) : (
              <li key={entry.id} className="flex items-start gap-2 rounded-md px-1.5 py-1">
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold ${
                    entry.status === "done"
                      ? "bg-emerald-500/20 text-emerald-300"
                      : entry.status === "failed"
                        ? "bg-red-500/20 text-red-300"
                        : entry.status === "skipped"
                          ? "bg-zinc-700/60 text-zinc-400"
                          : "bg-sky-500/20 text-sky-300"
                  }`}
                >
                  {entry.index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] leading-snug text-zinc-200">
                    {entry.label}
                    {entry.status === "running" && <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin text-sky-400" />}
                  </p>
                  {entry.detail && (
                    <p
                      className={`mt-0.5 text-[10px] leading-snug ${
                        entry.status === "failed" ? "text-red-300/90" : entry.status === "skipped" ? "text-zinc-500" : "text-zinc-500"
                      }`}
                    >
                      {entry.detail}
                    </p>
                  )}
                </div>
                <Badge
                  variant="outline"
                  className={`h-4 shrink-0 px-1 text-[9px] ${
                    entry.status === "done"
                      ? "border-emerald-500/40 text-emerald-300"
                      : entry.status === "failed"
                        ? "border-red-500/40 text-red-300"
                        : entry.status === "skipped"
                          ? "border-zinc-700 text-zinc-500"
                          : "border-sky-500/40 text-sky-300"
                  }`}
                >
                  {entry.status}
                </Badge>
              </li>
            )
          )}
        </ol>
      </div>
    </div>
  );
}
