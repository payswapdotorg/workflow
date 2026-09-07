"use client";

import { useAppStore } from "./store";
import type { RecoveryRecord, SessionHealthSnapshot } from "./types";

/* ------------------------------------------------------------------ */
/* Long-running session watchdog                                       */
/*                                                                     */
/* Watches the UI-level turn clock: while a turn is active (spinner    */
/* spinning, message frozen) it requires REAL progress at least every  */
/* hangThresholdMs (default 6 minutes). The transport watchdogs in     */
/* streamChat settle wedged HTTP streams; this watchdog covers the     */
/* rest: frozen background tabs, OS sleep mid-stream, dead sockets     */
/* that never error, wedged tool loops — any state where the spinner   */
/* survives without genuine movement.                                  */
/*                                                                     */
/* On hang: save draft + recovery record -> reload -> restore draft    */
/* -> resubmit. A cooldown suppresses reload loops (a hang shortly     */
/* after a recovery surfaces in the status panel for manual action).   */
/* ------------------------------------------------------------------ */

const DRAFT_PREFIX = "teachcast.draft.";
const LAST_RECOVERY_KEY = "teachcast.lastRecoveryAt";
const RECOVERY_KEY = "teachcast.recovery";

/** Minimum delay between automatic recoveries (anti reload-loop guard). */
export const RECOVERY_COOLDOWN_MS = 3 * 60_000;

/** Default hang threshold: frozen message + active spinner for 6+ minutes. */
export const DEFAULT_HANG_THRESHOLD_MS = 6 * 60_000;

/**
 * Hang threshold override (localStorage `teachcast.hangThresholdMs`).
 * A documented power-user/testing knob that tunes the REAL detector —
 * everything else (detection, recovery, resubmit, loop guard) is identical.
 */
function hangThresholdMs(): number {
  try {
    const raw = localStorage.getItem("teachcast.hangThresholdMs");
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 1000) return n;
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_HANG_THRESHOLD_MS;
}

interface ActiveTurn {
  kind: string;
  startedTs: number;
  lastActivityTs: number;
}

function readLastRecoveryTs(): number | null {
  try {
    const raw = localStorage.getItem(LAST_RECOVERY_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

class SessionWatchdog {
  private turn: ActiveTurn | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private suppressed = false;
  private visibilityAttached = false;
  /** Text that started the active turn per surface — the draft is cleared on send,
   *  so recovery must remember the sent message itself, not re-read the draft. */
  private turnTexts = new Map<string, string>();

  /* ---------------- turn lifecycle ---------------- */

  beginTurn(kind: string, turnText?: string): void {
    const now = Date.now();
    this.turn = { kind, startedTs: now, lastActivityTs: now };
    if (turnText !== undefined && turnText.trim()) this.turnTexts.set(kind, turnText);
    this.suppressed = false;
    this.sync("streaming");
    if (!this.timer) this.timer = setInterval(() => void this.check(), 1000);
    this.attachVisibility();
  }

  /** Must be called on every genuine sign of progress. */
  activity(): void {
    if (this.turn) this.turn.lastActivityTs = Date.now();
    this.sync();
  }

  endTurn(): void {
    this.turn = null;
    this.suppressed = false;
    if (this.turnTexts.size > 0) this.turnTexts.clear();
    this.sync();
  }

  /* ---------------- recovery bookkeeping ---------------- */

  saveDraft(kind: string, text: string): void {
    try {
      localStorage.setItem(DRAFT_PREFIX + kind, text);
    } catch {
      /* best effort */
    }
  }

  loadDraft(kind: string): string {
    try {
      return localStorage.getItem(DRAFT_PREFIX + kind) ?? "";
    } catch {
      return "";
    }
  }

  clearDraft(kind: string): void {
    try {
      localStorage.removeItem(DRAFT_PREFIX + kind);
    } catch {
      /* best effort */
    }
  }

  /** Read + remove the boot recovery record (called once by page.tsx on mount). */
  popRecovery(): RecoveryRecord | null {
    try {
      const raw = localStorage.getItem(RECOVERY_KEY);
      if (!raw) return null;
      localStorage.removeItem(RECOVERY_KEY);
      const rec = JSON.parse(raw) as RecoveryRecord;
      return rec && typeof rec.text === "string" ? rec : null;
    } catch {
      return null;
    }
  }

  /** Persist the recovery record and reload the app. Shared by auto + manual recovery. */
  recover(kind: string, opts: { bypassCooldown?: boolean } = {}): void {
    if (!opts.bypassCooldown && this.inCooldown()) {
      this.suppressed = true;
      this.sync(this.turn ? "hung" : "idle");
      return;
    }
    /* prefer the text that started the active turn; fall back to any unsent draft */
    const text = this.turnTexts.get(kind) ?? this.loadDraft(kind);
    try {
      localStorage.setItem(LAST_RECOVERY_KEY, String(Date.now()));
      localStorage.setItem(
        RECOVERY_KEY,
        JSON.stringify({ kind, text, resubmit: !!text.trim(), ts: Date.now() } satisfies RecoveryRecord)
      );
    } catch {
      /* still reload — draft restore is best-effort */
    }
    window.location.reload();
  }

  inCooldown(): boolean {
    const last = readLastRecoveryTs();
    return last !== null && Date.now() - last < RECOVERY_COOLDOWN_MS;
  }

  /** Attach the visibility hook + push an initial snapshot (called once by page.tsx). */
  attach(): void {
    this.attachVisibility();
    this.sync();
  }

  /* ---------------- internals ---------------- */

  private async check(): Promise<void> {
    if (this.checking || !this.turn) return;
    this.checking = true;
    try {
      const t = this.turn;
      const idleFor = Date.now() - t.lastActivityTs;
      this.sync(idleFor >= hangThresholdMs() ? "hung" : "streaming");
      if (idleFor >= hangThresholdMs()) {
        this.recover(t.kind);
      }
    } finally {
      this.checking = false;
    }
  }

  /** Background tabs throttle timers; re-check the moment the tab becomes visible. */
  private attachVisibility(): void {
    if (this.visibilityAttached || typeof document === "undefined") return;
    this.visibilityAttached = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.check();
    });
  }

  /** Mirror the current watchdog state into the store for the status panel. */
  private sync(forceState?: SessionHealthSnapshot["state"]): void {
    const t = this.turn;
    const idleFor = t ? Date.now() - t.lastActivityTs : 0;
    const hung = !!t && idleFor >= hangThresholdMs();
    const state: SessionHealthSnapshot["state"] = forceState ?? (t ? (hung ? "hung" : "streaming") : "idle");
    useAppStore.getState().setSessionHealth({
      state: t ? state : "idle",
      kind: t?.kind ?? null,
      startedTs: t?.startedTs ?? null,
      lastActivityTs: t?.lastActivityTs ?? null,
      hangThresholdMs: hangThresholdMs(),
      lastRecoveryTs: readLastRecoveryTs(),
      suppressed: this.suppressed,
    });
  }
}

export const sessionWatchdog = new SessionWatchdog();
