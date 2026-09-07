/**
 * LLM cursor — the second cursor on the stage (M7 dual-cursor teaching).
 *
 * A small, PURE state machine plus animation math that drives a visually
 * distinct overlay cursor (amber, labeled "AI") over the ScreenStage. The
 * user's real cursor already lives inside the shared video; this cursor is
 * the LLM's, and it is EVENT-DRIVEN, never decorative:
 *
 *   move(x, y)     -> eased glide to the normalized position
 *   click()        -> ripple at the current position
 *   typing(text)   -> keystroke indicator
 *
 * Coordinates are NORMALIZED (0..1) within the active surface's media box,
 * so the same events render correctly on the user's shared video (teaching
 * surface) and on the managed-browser mirror (acting surface) at any size.
 *
 * Pure on purpose: no DOM at module scope, importable by node --test.
 * The SSE wire type (ServerCursorEvent) is produced server-side by the M5
 * engine when it resolves real element geometry (agent-browser get box).
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type CursorPhase = "hidden" | "idle" | "moving" | "clicking" | "typing";

export interface LlmCursorState {
  phase: CursorPhase;
  /** normalized target/current position (0..1) */
  x: number;
  y: number;
  /** interpolation origin while gliding */
  moveFrom: { x: number; y: number } | null;
  /** caller-supplied ms clock (Date.now() or a fake in tests) */
  moveStartedAt: number;
  moveDurationMs: number;
  /** bumped per click — re-triggers the ripple animation */
  clickSeq: number;
  /** bumped per typing burst — re-triggers the keystroke indicator */
  typeSeq: number;
  typeText: string;
  label: string;
}

export type CursorCommandEvent =
  | { type: "show"; x?: number; y?: number; label?: string; now?: number }
  | { type: "hide"; now?: number }
  | { type: "move"; x: number; y: number; durationMs?: number; now?: number; label?: string }
  | { type: "move_done"; now?: number }
  | { type: "click"; x?: number; y?: number; now?: number; label?: string }
  | { type: "click_done"; now?: number }
  | { type: "typing"; text?: string; x?: number; y?: number; now?: number; label?: string }
  | { type: "type_done"; now?: number };

/** What the server emits over SSE as `{cursor: ...}` (UI-only — never fed to the model). */
export type ServerCursorEvent =
  | { type: "move"; x: number; y: number; durationMs?: number }
  | { type: "click"; x?: number; y?: number }
  | { type: "typing"; text?: string; x?: number; y?: number }
  | { type: "type_done" }
  | { type: "hide" }
  | { type: "show"; x?: number; y?: number };

export const CURSOR_DEFAULT_MOVE_MS = 600;
export const CURSOR_MIN_MOVE_MS = 120;
export const CURSOR_MAX_MOVE_MS = 1_600;

/* ------------------------------------------------------------------ */
/* Math                                                                */
/* ------------------------------------------------------------------ */

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** easeInOutCubic — smooth accelerate/decelerate for cursor glides. */
export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/* ------------------------------------------------------------------ */
/* Reducer                                                             */
/* ------------------------------------------------------------------ */

export const initialCursorState: LlmCursorState = {
  phase: "hidden",
  x: 0.5,
  y: 0.5,
  moveFrom: null,
  moveStartedAt: 0,
  moveDurationMs: 0,
  clickSeq: 0,
  typeSeq: 0,
  typeText: "",
  label: "AI",
};

/**
 * Pure reducer for the overlay cursor. `now` is always caller-supplied so
 * tests are deterministic. Unknown events return the same state.
 */
export function cursorReducer(state: LlmCursorState, event: CursorCommandEvent): LlmCursorState {
  const now = typeof event.now === "number" && Number.isFinite(event.now) ? event.now : 0;
  switch (event.type) {
    case "show": {
      const x = event.x === undefined ? state.x : clamp01(event.x);
      const y = event.y === undefined ? state.y : clamp01(event.y);
      return { ...state, phase: "idle", x, y, moveFrom: null, label: event.label ?? state.label };
    }
    case "hide":
      return { ...state, phase: "hidden", moveFrom: null };
    case "move": {
      const x = clamp01(event.x);
      const y = clamp01(event.y);
      const requested = event.durationMs ?? CURSOR_DEFAULT_MOVE_MS;
      const durationMs = Math.min(Math.max(requested, CURSOR_MIN_MOVE_MS), CURSOR_MAX_MOVE_MS);
      return {
        ...state,
        phase: "moving",
        x,
        y,
        moveFrom: { x: state.x, y: state.y },
        moveStartedAt: now,
        moveDurationMs: durationMs,
        label: event.label ?? state.label,
      };
    }
    case "move_done": {
      if (state.phase !== "moving") return state;
      return { ...state, phase: "idle", moveFrom: null };
    }
    case "click": {
      const x = event.x === undefined ? state.x : clamp01(event.x);
      const y = event.y === undefined ? state.y : clamp01(event.y);
      /* a click at a different position snaps there first (no glide unless
         the server sent an explicit move before) */
      const moved = x !== state.x || y !== state.y;
      return {
        ...state,
        phase: "clicking",
        x,
        y,
        moveFrom: moved ? { x: state.x, y: state.y } : state.moveFrom,
        moveStartedAt: moved ? now : state.moveStartedAt,
        moveDurationMs: moved ? CURSOR_MIN_MOVE_MS : state.moveDurationMs,
        clickSeq: state.clickSeq + 1,
        label: event.label ?? state.label,
      };
    }
    case "click_done": {
      if (state.phase !== "clicking") return state;
      return { ...state, phase: "idle", moveFrom: null };
    }
    case "typing": {
      const x = event.x === undefined ? state.x : clamp01(event.x);
      const y = event.y === undefined ? state.y : clamp01(event.y);
      return {
        ...state,
        phase: "typing",
        x,
        y,
        moveFrom: null,
        typeSeq: state.typeSeq + 1,
        typeText: typeof event.text === "string" ? event.text : state.typeText,
        label: event.label ?? state.label,
      };
    }
    case "type_done": {
      if (state.phase !== "typing") return state;
      return { ...state, phase: "idle" };
    }
    default:
      return state;
  }
}

/**
 * Interpolated position while gliding; the terminal position otherwise.
 * When the glide budget is exhausted the callers may dispatch move_done —
 * this function already reports the exact target at t >= 1.
 */
export function cursorPositionAt(state: LlmCursorState, nowMs: number): { x: number; y: number } {
  if (state.phase !== "moving" || !state.moveFrom) return { x: state.x, y: state.y };
  const t = state.moveDurationMs <= 0 ? 1 : (nowMs - state.moveStartedAt) / state.moveDurationMs;
  const e = easeInOutCubic(t);
  return {
    x: clamp01(state.moveFrom.x + (state.x - state.moveFrom.x) * e),
    y: clamp01(state.moveFrom.y + (state.y - state.moveFrom.y) * e),
  };
}

/** True once a glide's budget has fully elapsed (drives the auto move_done). */
export function moveExpired(state: LlmCursorState, nowMs: number): boolean {
  return state.phase === "moving" && nowMs - state.moveStartedAt >= state.moveDurationMs;
}

/* ------------------------------------------------------------------ */
/* SSE payload validation                                              */
/* ------------------------------------------------------------------ */

const SERVER_TYPES = new Set(["move", "click", "typing", "type_done", "hide", "show"]);

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Defensive parse of a `{cursor: ...}` SSE payload. Garbage never crashes
 * the overlay — it is dropped. Coordinates are clamped to 0..1.
 */
export function parseCursorEvent(raw: unknown): ServerCursorEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!SERVER_TYPES.has(String(r.type))) return null;
  switch (r.type) {
    case "move": {
      const x = num(r.x);
      const y = num(r.y);
      if (x === undefined || y === undefined) return null;
      const durationMs = num(r.durationMs);
      return { type: "move", x: clamp01(x), y: clamp01(y), durationMs };
    }
    case "click": {
      const x = num(r.x);
      const y = num(r.y);
      return { type: "click", x: x === undefined ? undefined : clamp01(x), y: y === undefined ? undefined : clamp01(y) };
    }
    case "typing": {
      const x = num(r.x);
      const y = num(r.y);
      return { type: "typing", text: str(r.text), x: x === undefined ? undefined : clamp01(x), y: y === undefined ? undefined : clamp01(y) };
    }
    case "type_done":
      return { type: "type_done" };
    case "hide":
      return { type: "hide" };
    case "show": {
      const x = num(r.x);
      const y = num(r.y);
      return { type: "show", x: x === undefined ? undefined : clamp01(x), y: y === undefined ? undefined : clamp01(y) };
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Component bus (tiny pub/sub — no DOM)                               */
/* ------------------------------------------------------------------ */

type Listener = (ev: ServerCursorEvent) => void;

const listeners = new Set<Listener>();

export const cursorBus = {
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  dispatch(ev: ServerCursorEvent): void {
    for (const l of [...listeners]) {
      try {
        l(ev);
      } catch {
        /* one bad subscriber never blocks the others */
      }
    }
  },
};
