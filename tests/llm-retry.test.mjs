/**
 * Unit tests for the M8 throttle-backoff helper (src/lib/llm-retry.ts).
 *
 * Covers the architect's mandatory unit coverage:
 *   - a fake provider that 429s twice then succeeds -> the call COMPLETES,
 *     with the retry count visible via onRetry
 *   - a fake provider that always 429s -> the call FAILS with the structured
 *     error (ThrottleExhaustedError), attempts visible, never fake success
 *   - honest failure: genuine (non-throttle) errors are NEVER retried
 *   - bounded schedule: 2s -> 4s -> 8s (capped), jitter bounded
 *
 * All sleeps are injected (instant recorder) — no real waiting.
 * Run: node --test tests/llm-retry.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isThrottleError,
  backoffDelay,
  withThrottleBackoff,
  ThrottleExhaustedError,
  THROTTLE_MAX_RETRIES,
  THROTTLE_BASE_DELAY_MS,
  THROTTLE_MAX_DELAY_MS,
} from "../src/lib/llm-retry.ts";

/** Instant sleep recorder: asserts the schedule without waiting. */
function recorder() {
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  return { waits, sleep };
}

const err429 = () => new Error('Provider error 429: {"error":"Too many requests, please try again later"}');

/* ---------------- 429 twice then success -> completes ---------------- */

test("a provider that 429s twice then succeeds: the call completes", async () => {
  const { waits, sleep } = recorder();
  let calls = 0;
  const attempts = [];
  const result = await withThrottleBackoff(
    async () => {
      calls++;
      if (calls <= 2) throw err429();
      return "completed";
    },
    { sleep, onRetry: (info) => attempts.push(info.attempt) }
  );
  assert.equal(result, "completed");
  assert.equal(calls, 3, "initial attempt + 2 retries");
  assert.deepEqual(attempts, [1, 2], "retry count is visible, 1-based");
  assert.deepEqual(waits.length, 2, "one wait per retry");
});

/* ---------------- always 429 -> structured failure, retries visible ---------------- */

test("a provider that always 429s: fails with the structured error after max retries — never fake success", async () => {
  const { waits, sleep } = recorder();
  let calls = 0;
  const attempts = [];
  await assert.rejects(
    withThrottleBackoff(
      async () => {
        calls++;
        throw err429();
      },
      { sleep, onRetry: (info) => attempts.push(info.attempt) }
    ),
    (err) => {
      assert.ok(err instanceof ThrottleExhaustedError, "the terminal error is the structured one");
      assert.equal(err.code, "PROVIDER_THROTTLED");
      assert.equal(err.attempts, THROTTLE_MAX_RETRIES);
      assert.match(err.message, /3 retries exhausted/, "the retry count is visible in the message");
      assert.match(err.message, /429/, "the underlying cause is visible in the message");
      assert.match(err.message, /Remedy:/, "the error carries the remedy");
      return true;
    }
  );
  assert.equal(calls, THROTTLE_MAX_RETRIES + 1, "initial attempt + exactly 3 retries, then stop");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(waits.length, THROTTLE_MAX_RETRIES, "one bounded wait per retry");
});

/* ---------------- schedule: 2s -> 4s -> 8s, capped ---------------- */

test("backoff schedule doubles per retry: 2s, 4s, 8s", async () => {
  const { waits, sleep } = recorder();
  let calls = 0;
  await withThrottleBackoff(
    async () => {
      calls++;
      throw err429();
    },
    { sleep, jitterRatio: 0 } /* deterministic: exactly base delays */
  ).catch(() => {});
  assert.deepEqual(waits, [2000, 4000, 8000]);
});

test("delays are capped at maxDelayMs", async () => {
  const { waits, sleep } = recorder();
  await withThrottleBackoff(
    async () => {
      throw err429();
    },
    { sleep, jitterRatio: 0, maxRetries: 5 }
  ).catch(() => {});
  assert.deepEqual(waits, [2000, 4000, 8000, 8000, 8000]);
});

test("jitter stays within ±20% of the schedule", () => {
  for (const attempt of [1, 2, 3]) {
    for (let i = 0; i < 200; i++) {
      const d = backoffDelay(attempt);
      const raw = Math.min(THROTTLE_BASE_DELAY_MS * 2 ** (attempt - 1), THROTTLE_MAX_DELAY_MS);
      assert.ok(d >= raw * 0.8 && d <= raw * 1.2, `delay ${d} within [${raw * 0.8}, ${raw * 1.2}]`);
    }
  }
});

/* ---------------- honest failure: genuine errors are never retried ---------------- */

test("a genuine error (401 bad key) fails immediately — exactly one call, no retries", async () => {
  const { waits, sleep } = recorder();
  let calls = 0;
  await assert.rejects(
    withThrottleBackoff(
      async () => {
        calls++;
        throw new Error("Provider error 401: invalid api key");
      },
      { sleep }
    ),
    /Provider error 401/
  );
  assert.equal(calls, 1, "never retried");
  assert.deepEqual(waits, [], "no waits");
});

test("a provider 500 is not a throttle — fails immediately", async () => {
  let calls = 0;
  await assert.rejects(
    withThrottleBackoff(
      async () => {
        calls++;
        throw new Error("Provider error 500: internal");
      },
      { sleep: async () => {} }
    ),
    /500/
  );
  assert.equal(calls, 1);
});

test("a total timeout is not a connect timeout — fails immediately (budget honesty)", async () => {
  let calls = 0;
  await assert.rejects(
    withThrottleBackoff(
      async () => {
        calls++;
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      },
      { sleep: async () => {} }
    )
  );
  assert.equal(calls, 1);
});

/* ---------------- isThrottleError classification ---------------- */

test("isThrottleError: 429 by message, by status field, and by wording variants", () => {
  assert.equal(isThrottleError(new Error("Provider error 429: too many requests")), true);
  assert.equal(isThrottleError(Object.assign(new Error("x"), { status: 429 })), true);
  assert.equal(isThrottleError(Object.assign(new Error("x"), { status: "429" })), true);
  assert.equal(isThrottleError(new Error("Too many requests, please try again later")), true);
  assert.equal(isThrottleError(new Error("GLM rate limit exceeded")), true);
  assert.equal(isThrottleError(new Error("please retry after 5s (429)")), true);
});

test("isThrottleError: connection-establishment failures (fetch failed + cause chain, connect timeout)", () => {
  const cause = new Error("connect ECONNRESET 104.18.32.7:443");
  const fetchFailed = new Error("fetch failed", { cause });
  assert.equal(isThrottleError(fetchFailed), true, "cause chain is inspected");

  const refused = new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:443") });
  assert.equal(isThrottleError(refused), true);

  assert.equal(isThrottleError(new Error("Connect Timeout Error (attempted addresses: 1.2.3.4:443)")), true);
  assert.equal(isThrottleError(Object.assign(new Error("x"), { code: "ECONNRESET" })), true);
});

test("isThrottleError: rejects genuine and unrelated errors", () => {
  assert.equal(isThrottleError(new Error("Provider error 400: bad request")), false);
  assert.equal(isThrottleError(new Error("Provider error 401: unauthorized")), false);
  assert.equal(isThrottleError(new Error("Provider error 500: internal")), false);
  assert.equal(isThrottleError(new Error("re-resolution returned no parseable JSON")), false);
  assert.equal(isThrottleError(null), false);
  assert.equal(isThrottleError(undefined), false);
});

/* ---------------- misc contract ---------------- */

test("onRetry receives the triggering error and the pending delay", async () => {
  const { sleep } = recorder();
  const seen = [];
  let calls = 0;
  await withThrottleBackoff(
    async () => {
      calls++;
      throw err429();
    },
    { sleep, jitterRatio: 0, onRetry: (info) => seen.push({ attempt: info.attempt, delayMs: info.delayMs, msg: info.error.message }) }
  ).catch(() => {});
  assert.equal(seen.length, 3);
  assert.equal(seen[1].delayMs, 4000);
  assert.match(seen[0].msg, /429/);
});

test("non-Error throws are normalized into the structured failure", async () => {
  await assert.rejects(
    withThrottleBackoff(
      async () => {
        throw "Provider error 429: throttled" /* pathological provider wrapper */;
      },
      { sleep: async () => {} }
    ),
    (err) => err instanceof ThrottleExhaustedError && err.attempts === THROTTLE_MAX_RETRIES
  );
});

test("zero retries allowed: first throttle failure is terminal and structured", async () => {
  let calls = 0;
  await assert.rejects(
    withThrottleBackoff(
      async () => {
        calls++;
        throw err429();
      },
      { sleep: async () => {}, maxRetries: 0 }
    ),
    (err) => err instanceof ThrottleExhaustedError && /0 retries exhausted/.test(err.message)
  );
  assert.equal(calls, 1);
});
