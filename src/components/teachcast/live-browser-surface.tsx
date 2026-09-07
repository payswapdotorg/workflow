"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, MousePointerClick, Wifi } from "lucide-react";
import { mapPointerToPage, keyEventToWire, modifierMask, virtualKeyCode, type RectLike } from "@/lib/browser-input-map";

/**
 * The live, OPERABLE managed-browser surface (operator directive 2026-09-07:
 * "you had to connect through a websocket to the browser … I can't operate
 * any browser since it doesn't show").
 *
 * Downstream: SSE frames of the CDP screencast (/api/browser-live) — the
 * remote viewport, live. Upstream: the operator's mouse and keyboard are
 * forwarded onto the remote page (/api/browser-input) with real-geometry
 * coordinate mapping — click, drag, wheel, full key events, text. This is
 * how captchas get resolved and logins happen from inside the Replay view.
 *
 * Graceful degradation: if the SSE stream stalls (proxy buffering, managed
 * browser relaunching) the parent's snapshot poll keeps a static mirror, and
 * the status chip tells the truth about what the operator is looking at.
 */

export interface LiveBrowserSurfaceProps {
  mode: "session" | "replay";
  /** The stage's mirror ref — the LLM cursor overlay reads geometry from it. */
  imgRef?: React.RefObject<HTMLImageElement | null>;
  /** Static snapshot frame (the poll fallback) shown until live frames flow. */
  fallbackFrame?: string | null;
  /** Parent gating for the snapshot-poll fallback: true while frames flow. */
  onLiveChange?: (live: boolean) => void;
  /** Live navigation events (main-frame URL) push the stage's URL label. */
  onUrl?: (url: string | null) => void;
}

interface FrameMeta {
  w: number;
  h: number;
  psf: number;
}

const DEFAULT_META: FrameMeta = { w: 1280, h: 720, psf: 1 };

export function LiveBrowserSurface({ mode, imgRef, fallbackFrame, onLiveChange, onUrl }: LiveBrowserSurfaceProps) {
  const [frame, setFrame] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState<string>("idle");
  const [fresh, setFresh] = useState(false);
  const [focused, setFocused] = useState(false);
  const [inputDown, setInputDown] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const metaRef = useRef<FrameMeta>(DEFAULT_META);
  const lastFrameAt = useRef(0);
  const lastMoveAt = useRef(0);
  const lastMovePos = useRef<{ x: number; y: number } | null>(null);
  const pressRef = useRef<{ t: number; x: number; y: number; count: number } | null>(null);
  const pointerDownRef = useRef<{ button: number; count: number } | null>(null);

  const liveChangeRef = useRef(onLiveChange);
  liveChangeRef.current = onLiveChange;
  const onUrlRef = useRef(onUrl);
  onUrlRef.current = onUrl;

  /* ---------------- SSE downstream ---------------- */

  useEffect(() => {
    const es = new EventSource("/api/browser-live");
    es.addEventListener("state", (ev) => {
      try {
        const s = JSON.parse((ev as MessageEvent<string>).data) as { phase?: string; url?: string | null };
        setPhase(s.phase ?? "idle");
        setConnected(s.phase === "connected");
        if (s.url !== null && s.url !== undefined) onUrlRef.current?.(s.url);
      } catch {
        /* malformed state event — the next one will land */
      }
    });
    es.addEventListener("frame", (ev) => {
      try {
        const f = JSON.parse((ev as MessageEvent<string>).data) as { frame?: string; w?: number; h?: number; psf?: number };
        if (!f.frame) return;
        setFrame(f.frame);
        metaRef.current = { w: f.w || DEFAULT_META.w, h: f.h || DEFAULT_META.h, psf: f.psf || 1 };
        lastFrameAt.current = Date.now();
      } catch {
        /* malformed frame event — dropped */
      }
    });
    return () => es.close();
  }, []);

  /* staleness ticker: frames must keep arriving for "live" to be honest */
  useEffect(() => {
    const t = setInterval(() => {
      setFresh(lastFrameAt.current > 0 && Date.now() - lastFrameAt.current < 3_500);
    }, 1_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    liveChangeRef.current?.(connected && fresh);
  }, [connected, fresh]);

  /* ---------------- upstream input ---------------- */

  const postInput = useCallback(async (payload: Record<string, unknown>) => {
    try {
      const res = await fetch("/api/browser-input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setInputError(data?.error ?? `HTTP ${res.status}`);
        setInputDown(false);
      } else {
        setInputError(null);
        setInputDown(true);
      }
    } catch {
      setInputError("network unreachable");
      setInputDown(false);
    }
  }, []);

  /** Map a pointer position over the rendered mirror to remote page coords. */
  const toPage = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const img = imgElRef.current;
    if (!img) return null;
    const dom = img.getBoundingClientRect();
    const rect: RectLike = { left: dom.left, top: dom.top, width: dom.width, height: dom.height };
    const m = metaRef.current;
    return mapPointerToPage(
      { rect, naturalW: img.naturalWidth || m.w, naturalH: img.naturalHeight || m.h, frameW: m.w, frameH: m.h, pageScaleFactor: m.psf },
      clientX,
      clientY
    );
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      wrapRef.current?.focus();
      const p = toPage(e.clientX, e.clientY);
      if (!p) return;
      /* clickCount: a second rapid press at the same spot becomes 2 (native dblclick) */
      const last = pressRef.current;
      const now = Date.now();
      const count = last && now - last.t < 450 && Math.abs(p.x - last.x) <= 6 && Math.abs(p.y - last.y) <= 6 ? Math.min(3, last.count + 1) : 1;
      pressRef.current = { t: now, x: p.x, y: p.y, count };
      pointerDownRef.current = { button: e.button, count };
      void postInput({ kind: "down", x: p.x, y: p.y, button: e.button === 2 ? "right" : "left", count });
      e.preventDefault();
    },
    [postInput, toPage]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const p = toPage(e.clientX, e.clientY);
      const pd = pointerDownRef.current;
      if (!p || !pd) return;
      pointerDownRef.current = null;
      void postInput({ kind: "up", x: p.x, y: p.y, button: pd.button === 2 ? "right" : "left", count: pd.count });
    },
    [postInput, toPage]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const now = Date.now();
      if (now - lastMoveAt.current < 60) return;
      const p = toPage(e.clientX, e.clientY);
      if (!p) return;
      const lastPos = lastMovePos.current;
      if (lastPos && Math.abs(p.x - lastPos.x) < 2 && Math.abs(p.y - lastPos.y) < 2) return;
      lastMoveAt.current = now;
      lastMovePos.current = { x: p.x, y: p.y };
      /* buttons mask: left=1 right=2 middle=4 — keeps remote drags alive */
      const buttons = pointerDownRef.current ? (pointerDownRef.current.button === 2 ? 2 : 1) : 0;
      void postInput({ kind: "move", x: p.x, y: p.y, buttons });
    },
    [postInput, toPage]
  );

  /* wheel must be a native non-passive listener to preventDefault page scroll */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toPage(e.clientX, e.clientY);
      if (!p) return;
      void postInput({ kind: "scroll", x: p.x, y: p.y, deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [postInput, toPage]);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    /* the remote context menu shows in the mirror; the local one must not */
    e.preventDefault();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]")) return;
      const wire = keyEventToWire({
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
      });
      if (!wire) return; /* browser-reserved or unmapped — stays local */
      e.preventDefault();
      if (wire.kind === "text") {
        void postInput({ kind: "text", text: wire.text });
      } else if (wire.kind === "key") {
        void postInput({
          kind: "key",
          key: wire.key,
          code: wire.code,
          vk: wire.vk ?? virtualKeyCode({ key: wire.key, code: wire.code }),
          modifiers: wire.modifiers,
          text: wire.text,
        });
      } else {
        void postInput({
          kind: "keycombo",
          key: wire.key,
          code: wire.code,
          vk: wire.vk ?? virtualKeyCode({ key: wire.key, code: wire.code }),
          modifiers: modifierMask({ key: wire.key, code: wire.code, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, shiftKey: e.shiftKey }),
        });
      }
    },
    [postInput]
  );

  /* ---------------- render ---------------- */

  const src = frame ?? fallbackFrame ?? null;

  return (
    <div
      ref={wrapRef}
      role="application"
      aria-label={mode === "replay" ? "Live managed browser — replay surface, click to drive it" : "Live managed browser — acting surface, click to drive it"}
      tabIndex={0}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerMove={handlePointerMove}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      className={`relative flex h-full w-full select-none items-center justify-center overflow-hidden outline-none transition-shadow ${
        focused ? "ring-2 ring-amber-400/50" : connected && fresh ? "ring-1 ring-zinc-700/60" : ""
      } ${inputDown && !inputError ? "cursor-default" : "cursor-default"}`}
    >
      {src ? (
        <img
          ref={(el) => {
            imgElRef.current = el;
            if (imgRef) imgRef.current = el;
          }}
          src={src}
          alt="Managed browser — live view; your mouse and keyboard drive this browser"
          draggable={false}
          className="pointer-events-none h-full w-full object-contain"
        />
      ) : (
        <div className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
            <Wifi className="h-8 w-8 text-sky-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">
              {mode === "replay" ? "Replay surface: managed browser" : "Acting surface: managed browser"}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
              {phase === "retrying" && inputError
                ? inputError
                : "The workflow runs on the dedicated managed browser and this stage shows that browser live — and you can drive it: click into it and your mouse and keyboard land on the real page (this is how you solve a captcha or log in mid-run). Connect the managed session from the console panel to bring it up."}
            </p>
          </div>
        </div>
      )}

      {/* status chip — the honest state of the live surface */}
      <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2">
        {connected && fresh ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600/90 px-2.5 py-1 text-xs font-semibold text-white shadow-lg">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
            </span>
            live · operable
          </span>
        ) : phase === "connecting" || phase === "retrying" ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-800/90 px-2.5 py-1 text-xs font-medium text-zinc-300 shadow-lg">
            <Loader2 className="h-3 w-3 animate-spin" />
            {phase === "connecting" ? "connecting…" : "waiting for the managed browser…"}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-800/90 px-2.5 py-1 text-xs font-medium text-zinc-400 shadow-lg">
            <MousePointerClick className="h-3 w-3" />
            click the browser to drive it
          </span>
        )}
        {focused && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-600/90 px-2.5 py-1 text-xs font-semibold text-white shadow-lg">
            <MousePointerClick className="h-3 w-3" />
            keyboard driving
          </span>
        )}
      </div>

      {inputError && (
        <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-200">
          <AlertTriangle className="h-3 w-3" />
          <span className="max-w-[240px] truncate" title={inputError}>
            input offline: {inputError}
          </span>
        </div>
      )}
    </div>
  );
}
