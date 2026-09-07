"use client";

/**
 * LLM cursor overlay (M7) — the second cursor on the stage.
 *
 * Renders the LLM's cursor as a visually distinct amber SVG arrow with an
 * "AI" pill, absolutely positioned over the active surface's media box
 * (shared-screen video OR managed-browser mirror). Driven exclusively by
 * cursorBus events (server-emitted, real-geometry-backed):
 *
 *   move    -> eased glide (rAF sampling of the pure state machine)
 *   click   -> expanding ripple ring
 *   typing  -> keystroke indicator bubble
 *
 * Coordinates are normalized to the media box (object-contain aware), so the
 * cursor lands exactly where the managed action will land at any stage size.
 */

import { useEffect, useRef, useState } from "react";
import {
  cursorBus,
  cursorReducer,
  cursorPositionAt,
  moveExpired,
  parseCursorEvent,
  initialCursorState,
  type LlmCursorState,
} from "@/lib/llm-cursor";
import { normalizedToClient } from "@/lib/media-box";

interface LlmCursorOverlayProps {
  /** The element rendering the active surface's media (video or img). */
  getMedia: () => HTMLElement | null;
  /** Hide entirely (e.g. overlay not applicable for the current surface). */
  disabled?: boolean;
}

export function LlmCursorOverlay({ getMedia, disabled = false }: LlmCursorOverlayProps) {
  const [state, setState] = useState<LlmCursorState>(initialCursorState);
  const [px, setPx] = useState<{ x: number; y: number } | null>(null);
  /* the rAF loop reads the LATEST committed values through refs; React 1-way
     data flow stays intact because the refs are synced in effects below */
  const stateRef = useRef(state);
  const getMediaRef = useRef(getMedia);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    getMediaRef.current = getMedia;
  }, [getMedia]);

  /* subscribe to server-driven cursor events */
  useEffect(() => {
    return cursorBus.subscribe((ev) => {
      setState((s) => cursorReducer(s, { ...ev, now: Date.now() }));
    });
  }, []);

  /* rAF loop while the cursor is visible: eased glide sampling, auto
     move_done when the budget expires, px mapping against the media box.
     Runs only when needed — a static cursor costs no frames. (When hidden
     the render short-circuits, so no px clearing is needed here.) */
  useEffect(() => {
    if (disabled || state.phase === "hidden") return;
    let raf = 0;
    const tick = () => {
      const s = stateRef.current;
      if (moveExpired(s, Date.now())) {
        setState((cur) => cursorReducer(cur, { type: "move_done", now: Date.now() }));
      }
      const media = getMediaRef.current();
      if (media) {
        const rect = media.getBoundingClientRect();
        const src =
          media instanceof HTMLVideoElement
            ? media
            : ({ clientWidth: rect.width, clientHeight: rect.height } as HTMLElement);
        const pos = cursorPositionAt(stateRef.current, Date.now());
        const client = normalizedToClient(src, rect, pos.x, pos.y);
        setPx(client);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.phase, disabled]);

  if (disabled || state.phase === "hidden" || !px) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-30" aria-hidden="true">
      {/* click ripple — keyed by clickSeq so each click replays the animation */}
      {state.clickSeq > 0 && (
        <span
          key={state.clickSeq}
          className="absolute h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-400 llm-cursor-ripple"
          style={{ left: px.x, top: px.y }}
        />
      )}
      {/* the cursor itself */}
      <div className="absolute -translate-x-[2px] -translate-y-[2px]" style={{ left: px.x, top: px.y }}>
        <svg width="22" height="24" viewBox="0 0 22 24" className="drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">
          <path
            d="M4 1 L4 19.5 L9 14.8 L12.4 22.4 L15.6 21 L12.2 13.6 L19 13.2 Z"
            fill="#f59e0b"
            stroke="#1c1917"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        <span className="absolute left-[16px] top-[14px] inline-flex items-center rounded-full bg-amber-500 px-1.5 py-px text-[9px] font-bold leading-none text-black shadow">
          {state.label}
        </span>
      </div>
      {/* typing indicator — keyed by typeSeq so a new burst replays */}
      {state.phase === "typing" && (
        <span
          key={state.typeSeq}
          className="absolute ml-4 mt-4 max-w-[180px] truncate rounded-md border border-amber-500/40 bg-black/80 px-1.5 py-0.5 text-[10px] text-amber-200 backdrop-blur"
          style={{ left: px.x, top: px.y }}
        >
          <span className="mr-1 inline-flex gap-0.5 align-middle">
            <span className="h-1 w-1 animate-bounce rounded-full bg-amber-400 [animation-delay:0ms]" />
            <span className="h-1 w-1 animate-bounce rounded-full bg-amber-400 [animation-delay:120ms]" />
            <span className="h-1 w-1 animate-bounce rounded-full bg-amber-400 [animation-delay:240ms]" />
          </span>
          {state.typeText ? `typing "${state.typeText.slice(0, 24)}"` : "typing"}
        </span>
      )}
    </div>
  );
}

/** Re-export for tests/storying: the parsed event type guard. */
export { parseCursorEvent };
