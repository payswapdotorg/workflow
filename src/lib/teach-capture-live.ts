"use client";

/**
 * Live wiring for learning-mode capture (M7) — the ONLY DOM-touching layer.
 *
 * The pure reducer lives in teach-capture.ts; this singleton owns the real
 * listener set. The ScreenStage registers its demonstration surface (the
 * shared-screen <video> when streaming, the stage container otherwise);
 * arm()/disarm() attach real pointer + key listeners and translate them:
 *
 *   pointerdown  -> pointer_click  {x,y normalized to the MEDIA box, thumb}
 *   pointermove  -> pointer_move   {sampled by the reducer}
 *   keydown      -> key            {printable char / named key}
 *
 * Thumbnails are REAL frames grabbed from the live video track at click time
 * (captureFrame). Headless contexts without a stream capture null thumbs —
 * the pipeline stays honest either way.
 *
 * High-frequency events mutate only the module buffer + a couple of store
 * counters, so the React tree never re-renders per pointermove.
 */

import { captureReducer, initialCaptureState, type CaptureState, type CapturedEvent } from "./teach-capture";
import { clientToNormalized } from "./media-box";
import { captureFrame } from "./screen";
import { useAppStore } from "./store";

/** Keys recorded as-is (named) beyond printable characters. */
const NAMED_KEYS = new Set(["Enter", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"]);

class TeachCaptureLive {
  private state: CaptureState = { ...initialCaptureState };
  private surface: HTMLElement | null = null;
  private detachSurface: (() => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  /** Counters mirrored into the store (batched, not per-event). */
  private syncStore() {
    const st = useAppStore.getState();
    st.setCaptureArmed(this.state.armed);
    st.setCaptureEventCount(this.state.events.length);
  }

  /** Events recorded so far in the current (or last) lesson. */
  getEvents(): CapturedEvent[] {
    return this.state.events;
  }

  isArmed(): boolean {
    return this.state.armed;
  }

  /** The stage registers its demonstration surface on mount/unmount. */
  registerSurface(el: HTMLElement | null) {
    if (this.surface === el) return;
    this.detachSurface?.();
    this.detachSurface = null;
    this.surface = el;
    if (this.state.armed && el) this.attachListeners();
  }

  /** "watch this" — start recording a fresh lesson. */
  arm(): boolean {
    if (this.state.armed) return true;
    if (!this.surface) return false; // no stage mounted — nothing to demonstrate on
    this.state = captureReducer(this.state, { type: "arm", ts: Date.now() });
    this.attachListeners();
    this.syncStore();
    return true;
  }

  /** "learn this" — stop recording; returns the captured events for synthesis. */
  disarm(): CapturedEvent[] {
    if (!this.state.armed) return this.state.events;
    this.state = captureReducer(this.state, { type: "disarm", ts: Date.now() });
    this.detachListeners();
    this.syncStore();
    return this.state.events;
  }

  reset() {
    this.state = { ...initialCaptureState };
    this.detachListeners();
    this.syncStore();
  }

  /* ---------------- listeners ---------------- */

  private attachListeners() {
    const el = this.surface;
    if (!el || this.detachSurface) return;

    const mediaSource = () => {
      /* the media element when streaming (video), else the bare container —
         media-box falls back to the element rect either way */
      const video = el.querySelector("video");
      return video ?? el;
    };

    const toNormalized = (clientX: number, clientY: number) => {
      const m = mediaSource();
      const rect = m.getBoundingClientRect();
      const src =
        m instanceof HTMLVideoElement
          ? m
          : ({ clientWidth: rect.width, clientHeight: rect.height } as HTMLElement);
      return clientToNormalized(src, rect, clientX, clientY);
    };

    const onPointerDown = (e: PointerEvent) => {
      const p = toNormalized(e.clientX, e.clientY);
      if (!p) return; // letterbox area / outside the media box
      this.state = captureReducer(this.state, {
        type: "pointer_click",
        x: p.x,
        y: p.y,
        ts: Date.now(),
        thumb: captureFrame(640, 0.6),
      });
      this.syncStore();
    };

    const onPointerMove = (e: PointerEvent) => {
      const p = toNormalized(e.clientX, e.clientY);
      if (!p) return;
      this.state = captureReducer(this.state, { type: "pointer_move", x: p.x, y: p.y, ts: Date.now() });
      this.syncStore();
    };

    this.keyHandler = (e: KeyboardEvent) => {
      const isPrintable = e.key.length === 1;
      if (!isPrintable && !NAMED_KEYS.has(e.key)) return;
      const char = isPrintable ? e.key : `[${e.key}]`;
      this.state = captureReducer(this.state, { type: "key", char, ts: Date.now() });
      this.syncStore();
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    document.addEventListener("keydown", this.keyHandler);
    this.detachSurface = () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      if (this.keyHandler) document.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    };
  }

  private detachListeners() {
    this.detachSurface?.();
    this.detachSurface = null;
  }
}

/** Module singleton (like the replay engine) — survives view switches. */
export const teachCapture = new TeachCaptureLive();
