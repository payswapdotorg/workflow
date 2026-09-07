/**
 * Unit tests for the M6 route-level hang guard (src/lib/api-guard.ts).
 * Run: node --test tests/
 * The guard core is dependency-free, so the timeout path is exercised
 * directly: a handler that never settles must produce a structured 503,
 * fast handlers must pass through untouched, and real errors must still
 * propagate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withRouteTimeout, RouteTimeoutError, DEFAULT_ROUTE_TIMEOUT_MS } from "../src/lib/api-guard.ts";

const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const never = () => new Promise(() => {}); /* the hung-Prisma shape */
const fakeReq = (url = "http://localhost/api/test") => ({ url });

const parse = async (res) => ({ status: res.status, body: await res.json() });

test("default budget constant is 30s", () => {
  assert.equal(DEFAULT_ROUTE_TIMEOUT_MS, 30_000);
});

test("a handler that never settles produces a structured 503 ROUTE_TIMEOUT (the silent-hang fix)", async () => {
  const route = withRouteTimeout(never, { timeoutMs: 50, json });
  const t0 = Date.now();
  const { status, body } = await parse(await route(fakeReq(), undefined));
  const elapsed = Date.now() - t0;
  assert.equal(status, 503);
  assert.equal(body.error.code, "ROUTE_TIMEOUT");
  assert.match(body.error.message, /did not complete within/);
  assert.match(body.error.remedy, /\/api\/health/);
  assert.ok(elapsed >= 40, `must wait the full budget (elapsed ${elapsed}ms)`);
  assert.ok(elapsed < 2_000, `must NOT wait forever (elapsed ${elapsed}ms)`);
});

test("a fast handler passes through untouched (status + body preserved)", async () => {
  const route = withRouteTimeout(async () => json({ ok: true, value: 42 }, 201), { timeoutMs: 1_000, json });
  const { status, body } = await parse(await route(fakeReq(), undefined));
  assert.equal(status, 201);
  assert.deepEqual(body, { ok: true, value: 42 });
});

test("handler errors other than the timeout propagate unchanged", async () => {
  const boom = Object.assign(new Error("prisma exploded"), { code: "P1001" });
  const route = withRouteTimeout(async () => {
    throw boom;
  }, { timeoutMs: 1_000, json });
  await assert.rejects(() => route(fakeReq(), undefined), (err) => err === boom);
});

test("RouteTimeoutError is distinguishable from handler errors", () => {
  const e = new RouteTimeoutError(30_000);
  assert.equal(e instanceof RouteTimeoutError, true);
  assert.equal(e.budgetMs, 30_000);
});

test("timeout URL is extracted for the server-side log line (no crash on odd reqs)", async () => {
  const route = withRouteTimeout(never, { timeoutMs: 40, json, label: "unit.label" });
  const res = await route(fakeReq("http://localhost/api/workflows/abc"), undefined);
  assert.equal(res.status, 503);
});

test("env override TEACHCAST_ROUTE_TIMEOUT_MS applies when no explicit budget", async () => {
  process.env.TEACHCAST_ROUTE_TIMEOUT_MS = "60";
  try {
    const route = withRouteTimeout(never, { json });
    const t0 = Date.now();
    const res = await route(fakeReq(), undefined);
    assert.equal(res.status, 503);
    assert.ok(Date.now() - t0 >= 50);
  } finally {
    delete process.env.TEACHCAST_ROUTE_TIMEOUT_MS;
  }
});
