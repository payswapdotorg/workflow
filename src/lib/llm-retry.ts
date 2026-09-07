/**
 * M8 — provider throttle hardening: bounded exponential backoff for LLM
 * provider calls.
 *
 * Live-discovered gap (architect verification of M7): when the provider
 * throttles (429 "Too many requests, please try again later"), a whole taught
 * execution run died on ONE transient 429 — the step loop failed instantly.
 * Production answer: bounded backoff + retry, with the retry VISIBLY surfaced
 * where an operator is watching (the execution run log) and the final
 * failure HONEST (structured error naming the attempts — never fake success).
 *
 * Guarantees:
 *   - only TRANSIENT failures are retried: HTTP 429 / "too many requests" /
 *     "try again later" / rate-limit text, and connection-establishment
 *     failures (fetch failed with ECONNRESET/ECONNREFUSED/ETIMEDOUT causes,
 *     undici's Connect Timeout). Genuine errors (400/401/500, bad JSON,
 *     total timeouts) propagate IMMEDIATELY — never masked, never retried.
 *   - bounded: max 3 retries per call, delays 2s -> 4s -> 8s (capped) with
 *     ±20% jitter, so a throttled step defers for at most ~14s of waiting.
 *   - dependency-free (no imports): `node --test` exercises it directly.
 */

export const THROTTLE_MAX_RETRIES = 3;
export const THROTTLE_BASE_DELAY_MS = 2_000;
export const THROTTLE_MAX_DELAY_MS = 8_000;
export const THROTTLE_JITTER_RATIO = 0.2;

export interface ThrottleRetryInfo {
  /** 1-based retry number (1..maxRetries) about to be attempted. */
  attempt: number;
  /** Milliseconds the caller is about to wait before this retry. */
  delayMs: number;
  /** The transient error that triggered this retry. */
  error: Error;
}

export interface ThrottleRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  /** Injectable waiter (tests pass an instant recorder). */
  sleep?: (ms: number) => Promise<void>;
  /** Fired before each retry wait — the run-log surfacing hook. */
  onRetry?: (info: ThrottleRetryInfo) => void;
}

/** The structured terminal error when retries are exhausted. The message is
 *  self-describing for run logs: attempts made + last underlying cause. */
export class ThrottleExhaustedError extends Error {
  readonly code = "PROVIDER_THROTTLED";
  readonly attempts: number;
  readonly lastError: Error;
  readonly remedy: string;
  constructor(attempts: number, lastError: Error) {
    super(
      `LLM provider throttled — ${attempts} retr${attempts === 1 ? "y" : "ies"} exhausted (last: ${lastError.message.slice(0, 200)}). ` +
        "Remedy: wait a moment and run again, or configure a different provider in Settings."
    );
    this.name = "ThrottleExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
    this.remedy = "Wait a moment and retry, or configure a different provider in Settings.";
  }
}

/** True only for TRANSIENT throttle / connection-establishment failures.
 *  Inspects status/code fields and the message + `cause` chain (fetch wraps
 *  connection errors: TypeError "fetch failed" with an ECONNRESET cause). */
export function isThrottleError(err: unknown): boolean {
  if (!err) return false;
  const shape = err as { status?: unknown; code?: unknown; statusCode?: unknown };
  if (shape.status === 429 || shape.status === "429" || shape.statusCode === 429) return true;
  if (typeof shape.code === "string" && /^ECONN(RESET|REFUSED)$|^ETIMEDOUT$|^EAI_AGAIN$/.test(shape.code)) return true;
  /* walk the message + cause chain (bounded depth) */
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 4; depth++) {
    const msg = String((cur as Error)?.message ?? "");
    if (
      /\b429\b/.test(msg) ||
      /too many requests/i.test(msg) ||
      /try again later/i.test(msg) ||
      /rate.?limit/i.test(msg) ||
      /connect(ion)?\s*(timed?\s*out|timeout)/i.test(msg) ||
      /ECONN(RESET|REFUSED)|ETIMEDOUT|EAI_AGAIN/.test(msg)
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown })?.cause;
  }
  return false;
}

/** Delay before retry `attempt` (1-based): 2s, 4s, 8s... capped, ±jitter. */
export function backoffDelay(
  attempt: number,
  baseDelayMs = THROTTLE_BASE_DELAY_MS,
  maxDelayMs = THROTTLE_MAX_DELAY_MS,
  jitterRatio = THROTTLE_JITTER_RATIO
): number {
  const clamped = Math.max(1, attempt);
  const raw = Math.min(baseDelayMs * 2 ** (clamped - 1), maxDelayMs);
  const jitter = 1 + (Math.random() * 2 - 1) * jitterRatio;
  return Math.max(0, Math.round(raw * jitter));
}

/** Runs `fn` with bounded throttle backoff. The LAST attempt's error —
 *  throttling included — is either returned as success or thrown honestly. */
export async function withThrottleBackoff<T>(fn: () => Promise<T>, opts: ThrottleRetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? THROTTLE_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? THROTTLE_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? THROTTLE_MAX_DELAY_MS;
  const jitterRatio = opts.jitterRatio ?? THROTTLE_JITTER_RATIO;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError: Error = new Error("provider call never ran");
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs, jitterRatio);
      opts.onRetry?.({ attempt, delayMs, error: lastError });
      await sleep(delayMs);
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isThrottleError(lastError)) throw lastError; /* genuine failure — never retried, never masked */
    }
  }
  throw new ThrottleExhaustedError(maxRetries, lastError);
}
