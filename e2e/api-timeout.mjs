/**
 * M6 e2e — the route hang guard, proven over real HTTP.
 *
 * The live incident: /api/workflows/[id] hung FOREVER under memory pressure
 * (no error, no timeout — silence until the client gave up). The fix is the
 * route-level guard; this test proves its behavior end to end against a real
 * Next dev server using the gated debug route:
 *
 *   1. fast handler  (ms=500)   -> 200, unaffected by the guard
 *   2. hung handler  (ms=35000) -> structured 503 ROUTE_TIMEOUT at ~30s,
 *      NOT silence (the artificial 35s handler from the review requirement)
 *   3. GET /api/health -> 200 with db + browser component checks
 *   4. GET /api/workflows -> 200 (a guarded data route, healthy after wiring)
 *
 * Requires the server to run with ENABLE_DEBUG_ROUTES=1 (e2e/run-all.mjs does
 * exactly that). Usage: node e2e/api-timeout.mjs (env: TEACHCAST_URL).
 */
const BASE = process.env.TEACHCAST_URL || "http://localhost:3005";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${String(detail).slice(0, 300)}`}`);
  return ok;
};

async function timedGet(path, budgetMs) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(budgetMs) });
    const text = await res.text();
    return { status: res.status, text, elapsed: Date.now() - t0 };
  } catch (e) {
    return { status: 0, text: String(e?.message ?? e), elapsed: Date.now() - t0 };
  }
}

let ok = true;

/* 0. the debug route must exist (server booted with ENABLE_DEBUG_ROUTES=1) */
const probe = await timedGet("/api/debug/slow?ms=10", 15_000);
if (probe.status === 404) {
  console.log("FAIL  /api/debug/slow is 404 — boot the server with ENABLE_DEBUG_ROUTES=1 (run-all.mjs does)");
  process.exit(1);
}

/* 1. fast handler passes through the guard untouched */
const fast = await timedGet("/api/debug/slow?ms=500", 15_000);
ok = check(
  "fast handler (500ms) returns 200 with its own body",
  fast.status === 200 && fast.text.includes('"slept":500') && fast.elapsed < 10_000,
  `status=${fast.status} elapsed=${fast.elapsed}ms body=${fast.text.slice(0, 120)}`
);

/* 2. THE core check: a 35s handler answers with the structured 503, not silence */
const hung = await timedGet("/api/debug/slow?ms=35000", 60_000);
let hungBody = null;
try { hungBody = JSON.parse(hung.text); } catch {}
ok =
  check(
    "hung handler (35s) returns structured 503 ROUTE_TIMEOUT — not silence",
    hung.status === 503 && hungBody?.error?.code === "ROUTE_TIMEOUT",
    `status=${hung.status} elapsed=${(hung.elapsed / 1000).toFixed(1)}s body=${hung.text.slice(0, 200)}`
  ) && ok;
ok =
  check(
    "the 503 arrives at the ~30s guard budget (proof the guard, not the handler, answered)",
    hung.elapsed >= 28_000 && hung.elapsed <= 45_000,
    `elapsed=${(hung.elapsed / 1000).toFixed(1)}s`
  ) && ok;
ok =
  check(
    "the 503 body carries a remedy pointing at /api/health",
    typeof hungBody?.error?.remedy === "string" && hungBody.error.remedy.includes("/api/health"),
    JSON.stringify(hungBody?.error ?? null).slice(0, 200)
  ) && ok;

/* 3. health endpoint: db hard dep ok, browser soft dep reported */
const health = await timedGet("/api/health", 20_000);
let healthBody = null;
try { healthBody = JSON.parse(health.text); } catch {}
ok =
  check(
    "GET /api/health returns 200 with db + browser checks",
    health.status === 200 && healthBody?.checks?.db?.ok === true && typeof healthBody?.checks?.browser === "object",
    `status=${health.status} body=${health.text.slice(0, 200)}`
  ) && ok;

/* 4. a guarded data route is still healthy */
const list = await timedGet("/api/workflows", 20_000);
ok = check("GET /api/workflows (guarded route) returns 200", list.status === 200, `status=${list.status}`);

const passed = results.filter((r) => r.ok).length;
console.log(`\n=== api-timeout: ${passed}/${results.length} checks passed ===`);
process.exit(ok && passed === results.length ? 0 : 1);
