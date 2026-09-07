/**
 * Learning-mode capture (M7) — the event model for teaching by demonstration.
 *
 * While the operator says "watch this", TeachCast records what happens on the
 * stage mirror: sampled pointer moves, clicks (with a frame thumbnail grabbed
 * from the live video track at that instant) and typing bursts. "learn this"
 * folds the recording into a DRAFT WORKFLOW whose steps carry normalized
 * coordinates + visual context, reviewable in the existing workflow UI.
 *
 * Pure on purpose: no DOM at module scope, importable by node --test.
 * DOM wiring lives in teach-capture-live.ts; thumbnails are passed in as
 * strings (data URLs) by the caller.
 *
 * Coordinates are NORMALIZED (0..1) in the demonstration surface's media box
 * — resolution-independent, and on replay they are only HINTS: the executor
 * re-resolves every target against a fresh snapshot (the M5 stale-ref law
 * applied to pixels — captured coordinates are never blindly replayed).
 */

/* ------------------------------------------------------------------ */
/* Events + state                                                      */
/* ------------------------------------------------------------------ */

export interface CapturedMove {
  kind: "move";
  x: number;
  y: number;
  ts: number;
}

export interface CapturedClick {
  kind: "click";
  x: number;
  y: number;
  ts: number;
  /** frame grabbed from the live video at click time (data URL), null when headless */
  thumb: string | null;
}

export interface CapturedTyping {
  kind: "typing";
  text: string;
  ts: number;
  endTs: number;
}

export type CapturedEvent = CapturedMove | CapturedClick | CapturedTyping;

export interface CaptureState {
  armed: boolean;
  events: CapturedEvent[];
  /** last RECORDED move timestamp (sampling gate) */
  lastMoveTs: number | null;
  /** open typing burst accumulator */
  burstChars: string[];
  burstStartTs: number | null;
  lastKeyTs: number | null;
  clickCount: number;
}

export type CaptureEvent =
  | { type: "arm"; ts: number }
  | { type: "disarm"; ts: number }
  | { type: "pointer_move"; x: number; y: number; ts: number }
  | { type: "pointer_click"; x: number; y: number; ts: number; thumb?: string | null }
  | { type: "key"; char: string; ts: number }
  | { type: "reset" };

/** Minimum gap between recorded pointer moves (sampling, not raw streams). */
export const MOVE_SAMPLE_MS = 80;
/** A typing burst closes after this much silence. */
export const TYPE_BURST_GAP_MS = 1_500;
/** Hard cap on steps per synthesized draft (matches the workflow API limit). */
export const MAX_DRAFT_STEPS = 80;

export const initialCaptureState: CaptureState = {
  armed: false,
  events: [],
  lastMoveTs: null,
  burstChars: [],
  burstStartTs: null,
  lastKeyTs: null,
  clickCount: 0,
};

function flushBurst(state: CaptureState): CaptureState {
  if (state.burstChars.length === 0) return state;
  const text = state.burstChars.join("");
  const startTs = state.burstStartTs ?? state.lastKeyTs ?? 0;
  const event: CapturedTyping = {
    kind: "typing",
    text,
    ts: startTs,
    endTs: state.lastKeyTs ?? startTs,
  };
  return {
    ...state,
    events: [...state.events, event],
    burstChars: [],
    burstStartTs: null,
  };
}

/** Pure capture reducer. Out-of-range coordinates are clamped; everything is
 *  gated on `armed` so stray input outside a lesson never pollutes a draft. */
export function captureReducer(state: CaptureState, event: CaptureEvent): CaptureState {
  switch (event.type) {
    case "arm":
      /* arming starts a FRESH lesson — nothing from a previous one leaks in */
      return { ...initialCaptureState, armed: true };
    case "disarm": {
      if (!state.armed) return state;
      const flushed = flushBurst({ ...state, armed: false });
      return { ...flushed, armed: false };
    }
    case "pointer_move": {
      if (!state.armed) return state;
      const ts = event.ts;
      if (state.lastMoveTs !== null && ts - state.lastMoveTs < MOVE_SAMPLE_MS) return state;
      return {
        ...state,
        lastMoveTs: ts,
        events: [...state.events, { kind: "move", x: clamp01(event.x), y: clamp01(event.y), ts }],
      };
    }
    case "pointer_click": {
      if (!state.armed) return state;
      /* a click always ends an open typing burst (switching modality) */
      const flushed = flushBurst(state);
      return {
        ...flushed,
        events: [
          ...flushed.events,
          { kind: "click", x: clamp01(event.x), y: clamp01(event.y), ts: event.ts, thumb: event.thumb ?? null },
        ],
        clickCount: flushed.clickCount + 1,
      };
    }
    case "key": {
      if (!state.armed || !event.char) return state;
      const gapTooLong = state.lastKeyTs !== null && event.ts - state.lastKeyTs > TYPE_BURST_GAP_MS;
      const started = state.burstChars.length > 0;
      if (started && gapTooLong) {
        const flushed = flushBurst(state);
        return { ...flushed, burstChars: [event.char], burstStartTs: event.ts, lastKeyTs: event.ts };
      }
      return {
        ...state,
        burstChars: [...state.burstChars, event.char],
        burstStartTs: state.burstStartTs ?? event.ts,
        lastKeyTs: event.ts,
      };
    }
    case "reset":
      return { ...initialCaptureState };
    default:
      return state;
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/* ------------------------------------------------------------------ */
/* Synthesis: captured events -> draft workflow steps                  */
/* ------------------------------------------------------------------ */

export interface DraftStep {
  kind: "action";
  payload: {
    actionType: "click" | "type";
    /** normalized capture-space coordinates (click steps) */
    x?: number;
    y?: number;
    /** captured keystrokes (type steps) */
    text?: string;
    /** human-readable step label (mechanical; vision may enrich it later) */
    label: string;
    /** frame at event time — the visual context the LLM re-grounds against */
    thumb?: string | null;
    ts: string;
  };
  ts: string;
}

function pct(n: number): string {
  return `${Math.round(clamp01(n) * 100)}%`;
}

/**
 * Folds the captured sequence into draft steps. Moves are context (not
 * steps); every click and typing burst becomes one actionable step. When
 * a thumbnail is available the click step carries it as visual context.
 */
export function synthesizeSteps(events: CapturedEvent[], opts: { maxSteps?: number } = {}): DraftStep[] {
  const max = Math.max(1, Math.min(opts.maxSteps ?? MAX_DRAFT_STEPS, MAX_DRAFT_STEPS));
  const steps: DraftStep[] = [];
  for (const e of events) {
    if (steps.length >= max) break;
    if (e.kind === "click") {
      steps.push({
        kind: "action",
        ts: new Date(e.ts).toISOString(),
        payload: {
          actionType: "click",
          x: e.x,
          y: e.y,
          label: `Click at ${pct(e.x)}, ${pct(e.y)}`,
          thumb: e.thumb,
          ts: new Date(e.ts).toISOString(),
        },
      });
    } else if (e.kind === "typing") {
      const text = e.text.slice(0, 400);
      steps.push({
        kind: "action",
        ts: new Date(e.ts).toISOString(),
        payload: {
          actionType: "type",
          text,
          label: `Type: "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`,
          ts: new Date(e.ts).toISOString(),
        },
      });
    }
    /* moves are deliberately not steps — they are trajectory context */
  }
  return steps;
}

/* ------------------------------------------------------------------ */
/* Lesson protocol (deterministic chat commands)                       */
/* ------------------------------------------------------------------ */

export type TeachCommand = "watch" | "learn";

const WATCH_PHRASES = ["watch this", "watch me", "observe this", "start watching"];
const LEARN_PHRASES = ["learn this", "learn that", "did you get that", "that's the lesson"];

function normalizeMessage(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?…]+$/, "").replace(/\s+/g, " ");
}

/**
 * Deterministic lesson protocol. A message ARMS capture when it starts with
 * a watch phrase, and DISARMS + synthesizes when it starts with a learn
 * phrase. Prefix matching (not substring) so ordinary sentences that merely
 * contain the words never trigger the protocol by accident.
 */
export function parseTeachCommand(raw: string): TeachCommand | null {
  const msg = normalizeMessage(raw);
  if (!msg) return null;
  for (const p of LEARN_PHRASES) {
    if (msg === p || msg.startsWith(p + " ") || msg.startsWith(p + ":")) return "learn";
  }
  for (const p of WATCH_PHRASES) {
    if (msg === p || msg.startsWith(p + " ") || msg.startsWith(p + ":")) return "watch";
  }
  return null;
}
