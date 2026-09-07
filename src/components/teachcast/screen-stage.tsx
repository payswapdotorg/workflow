"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Camera, ExternalLink, Globe, MonitorUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAppStore } from "@/lib/store";
import {
  clearActiveVideoEl,
  setActiveVideoEl,
  startScreenShare,
  supportsScreenCapture,
} from "@/lib/screen";
import { cursorBus } from "@/lib/llm-cursor";
import { teachCapture } from "@/lib/teach-capture-live";
import { LlmCursorOverlay } from "./llm-cursor-overlay";
import { LiveBrowserSurface } from "./live-browser-surface";
import { toast } from "sonner";

const emptySubscribe = () => () => {};
const getEmbedded = () => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
};
const getEmbeddedServer = () => false;

interface ScreenStageProps {
  mode: "session" | "replay";
  onSnapshot?: () => void;
}

export function ScreenStage({ mode, onSnapshot }: ScreenStageProps) {
  const stream = useAppStore((s) => s.stream);
  const setStream = useAppStore((s) => s.setStream);
  /* The stage surface — "replay" ALWAYS shows the managed browser (the
     workflow runs there and the operator watches it live), "act" shows the
     managed-browser mirror (the LLM cursor acts HERE, and the label says so
     honestly), "teach" shows the operator's shared screen (their real
     cursor). Operator directive 2026-09-07: the replay shows the browser. */
  const chatMode = useAppStore((s) => s.chatMode);
  const managedFrame = useAppStore((s) => s.managedFrame);
  const managedUrl = useAppStore((s) => s.managedUrl);
  const setManagedFrame = useAppStore((s) => s.setManagedFrame);
  const setManagedUrl = useAppStore((s) => s.setManagedUrl);
  /* live = the SSE screencast owns the mirror; !live = snapshot-poll fallback */
  const [liveOk, setLiveOk] = useState(false);
  const handleLiveChange = useCallback((live: boolean) => setLiveOk(live), []);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const embedded = useSyncExternalStore(emptySubscribe, getEmbedded, getEmbeddedServer);
  const supported = useSyncExternalStore(emptySubscribe, supportsScreenCapture, () => true);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const browserSurface = mode === "replay" || (mode === "session" && chatMode === "act");

  /* register the demonstration surface with the learning-mode capture (M7):
     the stage container — capture normalizes against the media box it finds
     inside (the shared video when streaming, the container otherwise). */
  useEffect(() => {
    teachCapture.registerSurface(stageRef.current);
    return () => teachCapture.registerSurface(null);
  }, []);

  /* browser-surface mirror FALLBACK: the CDP live stream (SSE screencast)
     owns the stage while frames flow; when it does not (managed browser
     absent, proxy buffering, relaunch in flight) this heavier snapshot poll
     keeps a static mirror alive — on entry, after cursor activity (debounced)
     and on a slow poll. */
  useEffect(() => {
    if (!browserSurface || liveOk) return;
    let alive = true;
    let lastAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      if (Date.now() - lastAt < 1_500) return;
      lastAt = Date.now();
      try {
        const res = await fetch("/api/managed-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "snapshot" }),
        });
        if (!res.ok || !alive) return;
        const data = await res.json();
        if (data?.frame) setManagedFrame(data.frame, data.url ?? undefined);
      } catch {
        /* mirror refresh is best-effort; the console shows connection errors */
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 600);
    };
    void refresh();
    const unsub = cursorBus.subscribe((ev) => {
      if (ev.type === "move" || ev.type === "click" || ev.type === "type_done") schedule();
    });
    const poll = setInterval(() => void refresh(), 8_000);
    return () => {
      alive = false;
      unsub();
      clearInterval(poll);
      if (timer) clearTimeout(timer);
    };
  }, [browserSurface, setManagedFrame, liveOk]);

  /* register the active video so captureFrame() reads this element.
     Re-runs on `stream` changes because the <video> is conditionally rendered. */
  useEffect(() => {
    const el = videoRef.current;
    setActiveVideoEl(el ?? null);
    return () => clearActiveVideoEl(el ?? null);
  }, [stream]);

  const handleEnded = useCallback(() => {
    /* the browser (or OS) ended the share — reset every piece of state */
    setStream(null);
    toast.info("Screen sharing ended", { description: "The stream was closed outside the app. Share again whenever you're ready." });
  }, [setStream]);

  /* attach/detach the shared stream; the ONLY place the 'ended' listener is
     registered, with proper cleanup, so it can never double-fire or leak */
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream ?? null;
    if (!stream) {
      setDimensions(null);
      return;
    }
    el.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    track?.addEventListener("ended", handleEnded);
    const readDimensions = () => {
      const s = track?.getSettings?.();
      if (s?.width && s?.height) setDimensions({ w: s.width, h: s.height });
      else if (el.videoWidth && el.videoHeight) setDimensions({ w: el.videoWidth, h: el.videoHeight });
    };
    readDimensions();
    track?.addEventListener("resize", readDimensions);
    el.addEventListener("loadedmetadata", readDimensions);
    return () => {
      track?.removeEventListener("ended", handleEnded);
      track?.removeEventListener("resize", readDimensions);
      el.removeEventListener("loadedmetadata", readDimensions);
    };
  }, [stream, handleEnded]);

  const share = async () => {
    setError(null);
    setRequesting(true);
    /* Watchdog: some contexts (embedded frames, extension blocks, headless
       shells) never settle the getDisplayMedia promise, which used to leave
       the button disabled on "Waiting for permission…" forever. Race the
       request against a timeout so the UI always recovers. */
    let timedOut = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const pending = startScreenShare();
    const timeout = new Promise<MediaStream>((_, reject) => {
      watchdog = setTimeout(() => {
        timedOut = true;
        reject(new DOMException("Screen share request timed out", "NotAllowedError"));
      }, 45_000);
    });
    try {
      const s = await Promise.race([pending, timeout]);
      setStream(s);
      toast.success("Screen shared — live frames are being captured at every event");
    } catch (err) {
      const e = err as DOMException;
      /* if the original request resolves after we gave up, kill the stray stream */
      pending.then(
        (stray) => timedOut && stray.getTracks().forEach((t) => t.stop()),
        () => {}
      );
      let msg: string;
      switch (e?.name) {
        case "NotAllowedError":
          msg = timedOut
            ? "The screen-share request timed out without a response. Try again — and if TeachCast is embedded, open it in its own tab first."
            : "Screen share was blocked or dismissed. If TeachCast is embedded in a preview frame, open it in its own tab and try again.";
          break;
        case "NotFoundError":
          msg = "No screen source was available to share.";
          break;
        case "NotSupportedError":
        case "TypeError":
          msg = "Screen capture is not supported in this browser/context. Use desktop Chrome, Edge or Firefox in a top-level tab.";
          break;
        default:
          msg = e?.message || "Failed to start screen sharing.";
      }
      setError(msg);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      setRequesting(false);
    }
  };

  const stop = () => {
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
    toast.info("Screen sharing stopped");
  };

  /* keep the badge accurate when track settings report late */
  const syncDimensions = useCallback(() => {
    const el = videoRef.current;
    if (!el?.videoWidth) return;
    setDimensions((d) => (d?.w === el.videoWidth && d?.h === el.videoHeight ? d : { w: el.videoWidth, h: el.videoHeight }));
  }, []);

  const takeSnapshot = () => {
    onSnapshot?.();
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash(Date.now().toString());
    flashTimer.current = setTimeout(() => setFlash(null), 450);
  };

  return (
    <div
      ref={stageRef}
      className={`relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden bg-black ${
        flash ? "ring-2 ring-amber-400/70" : ""
      } transition-shadow`}
    >
      {browserSurface ? (
        <>
          {/* the live, OPERABLE managed browser — CDP screencast downstream,
              operator mouse/keyboard upstream (operator directive 2026-09-07) */}
          <LiveBrowserSurface
            mode={mode}
            imgRef={mirrorRef}
            fallbackFrame={managedFrame}
            onLiveChange={handleLiveChange}
            onUrl={setManagedUrl}
          />
          {/* honest surface label: the run happens here, not on the operator's screen */}
          <div className="absolute left-3 top-3 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-600/90 px-2.5 py-1 text-xs font-semibold text-white shadow-lg">
              <Globe className="h-3 w-3" />
              {mode === "replay" ? "replaying: managed browser" : "acting: managed browser"}
            </span>
            {managedUrl && (
              <span className="hidden max-w-[280px] truncate rounded-full bg-black/60 px-2.5 py-1 font-mono text-xs text-zinc-300 backdrop-blur sm:inline" title={managedUrl}>
                {managedUrl}
              </span>
            )}
          </div>
          {/* the second cursor — server-driven, real-geometry-backed (M7) */}
          <LlmCursorOverlay getMedia={() => mirrorRef.current} />
        </>
      ) : stream ? (
        <>
          { }
          <video ref={videoRef} onLoadedMetadata={syncDimensions} onResize={syncDimensions} autoPlay muted playsInline className="h-full w-full object-contain" />
          {/* top-left live badge */}
          <div className="absolute left-3 top-3 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-600/90 px-2.5 py-1 text-xs font-semibold text-white shadow-lg">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
              </span>
              LIVE
            </span>
            {dimensions && (
              <span className="rounded-full bg-black/60 px-2.5 py-1 text-xs text-zinc-300 backdrop-blur">
                {dimensions.w}×{dimensions.h}
              </span>
            )}
            <span className="hidden rounded-full bg-black/60 px-2.5 py-1 text-xs text-zinc-300 backdrop-blur sm:inline">
              {mode === "session" ? "teaching: your screen" : "replay target"}
            </span>
          </div>
          {/* top-right controls */}
          <div className="absolute right-3 top-3 flex items-center gap-2">
            {mode === "session" && onSnapshot && (
              <Button size="sm" variant="secondary" className="h-8 gap-1.5 bg-black/60 text-zinc-100 backdrop-blur hover:bg-black/80" onClick={takeSnapshot}>
                <Camera className="h-3.5 w-3.5" />
                Snapshot
              </Button>
            )}
            <Button size="sm" variant="destructive" className="h-8 gap-1.5" onClick={stop}>
              <Square className="h-3 w-3" />
              Stop
            </Button>
          </div>
        </>
      ) : (
        <div className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
            <MonitorUp className="h-8 w-8 text-amber-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Share your screen to start teaching</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
              Your screen is streamed locally in the browser — the teaching surface. Say “watch this” in the chat, demonstrate, then “learn this” to save the lesson.
            </p>
          </div>
          <Button onClick={share} disabled={requesting || !supported} className="gap-2 bg-amber-500 text-black hover:bg-amber-400">
            <MonitorUp className="h-4 w-4" />
            {requesting ? "Waiting for permission…" : "Share your screen"}
          </Button>
          {embedded && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-left text-xs text-amber-200/90">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                TeachCast is running inside an embedded preview frame. Screen sharing requires a top-level tab —
                use the <strong>Open in new tab</strong> button in the header.
              </span>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-left text-xs text-red-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                <p>{error}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 h-7 gap-1.5 border-red-400/40 text-red-100 hover:bg-red-500/20"
                  onClick={() => window.open(window.location.href, "_blank")}
                >
                  <ExternalLink className="h-3 w-3" />
                  Open in new tab
                </Button>
              </div>
            </div>
          )}
          {!supported && !error && (
            <Badge variant="outline" className="border-zinc-700 text-zinc-400">
              getDisplayMedia unavailable in this context
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}
