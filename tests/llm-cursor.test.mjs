/**
 * Unit tests for the LLM cursor state machine (src/lib/llm-cursor.ts) and
 * the media-box geometry (src/lib/media-box.ts) — M7 dual-cursor.
 * Run: node --test tests/llm-cursor.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cursorReducer,
  cursorPositionAt,
  moveExpired,
  parseCursorEvent,
  cursorBus,
  easeInOutCubic,
  clamp01,
  initialCursorState,
  CURSOR_DEFAULT_MOVE_MS,
  CURSOR_MIN_MOVE_MS,
  CURSOR_MAX_MOVE_MS,
} from "../src/lib/llm-cursor.ts";
import { containRect, clientToNormalized, normalizedToClient } from "../src/lib/media-box.ts";

const T0 = 10_000;

/* ---------------- reducer: basic transitions ---------------- */

test("starts hidden at center", () => {
  assert.equal(initialCursorState.phase, "hidden");
  assert.equal(initialCursorState.x, 0.5);
  assert.equal(initialCursorState.y, 0.5);
});

test("show makes the cursor idle at the given position", () => {
  const s = cursorReducer(initialCursorState, { type: "show", x: 0.2, y: 0.8, now: T0 });
  assert.equal(s.phase, "idle");
  assert.equal(s.x, 0.2);
  assert.equal(s.y, 0.8);
});

test("move enters the moving phase with interpolation origin and clamped duration", () => {
  const s0 = cursorReducer(initialCursorState, { type: "show", x: 0.1, y: 0.1, now: T0 });
  const s1 = cursorReducer(s0, { type: "move", x: 0.9, y: 0.9, now: T0, durationMs: 99_999 });
  assert.equal(s1.phase, "moving");
  assert.deepEqual(s1.moveFrom, { x: 0.1, y: 0.1 });
  assert.equal(s1.moveStartedAt, T0);
  assert.equal(s1.moveDurationMs, CURSOR_MAX_MOVE_MS); // clamped from 99999
  const s2 = cursorReducer(s0, { type: "move", x: 0.9, y: 0.9, now: T0, durationMs: 1 });
  assert.equal(s2.moveDurationMs, CURSOR_MIN_MOVE_MS); // clamped up from 1
  const s3 = cursorReducer(s0, { type: "move", x: 0.9, y: 0.9, now: T0 });
  assert.equal(s3.moveDurationMs, CURSOR_DEFAULT_MOVE_MS);
});

test("coordinates are clamped to 0..1 on every event", () => {
  const s = cursorReducer(initialCursorState, { type: "move", x: 5, y: -2, now: T0 });
  assert.equal(s.x, 1);
  assert.equal(s.y, 0);
  const c = cursorReducer(s, { type: "click", x: -9, y: 9, now: T0 });
  assert.equal(c.x, 0);
  assert.equal(c.y, 1);
  assert.equal(c.phase, "clicking");
  assert.equal(c.clickSeq, 1);
});

test("move_done snaps to idle and keeps the target position", () => {
  const s0 = cursorReducer(initialCursorState, { type: "move", x: 0.7, y: 0.3, now: T0 });
  const s1 = cursorReducer(s0, { type: "move_done", now: T0 + 700 });
  assert.equal(s1.phase, "idle");
  assert.equal(s1.x, 0.7);
  assert.equal(s1.y, 0.3);
  assert.equal(s1.moveFrom, null);
});

test("move_done is a no-op outside the moving phase", () => {
  const s = cursorReducer(initialCursorState, { type: "move_done", now: T0 });
  assert.equal(s, initialCursorState);
});

test("click bumps clickSeq and click_done returns to idle", () => {
  const s0 = cursorReducer(initialCursorState, { type: "click", now: T0 });
  assert.equal(s0.phase, "clicking");
  assert.equal(s0.clickSeq, 1);
  const s1 = cursorReducer(s0, { type: "click", now: T0 + 10 });
  assert.equal(s1.clickSeq, 2);
  const s2 = cursorReducer(s1, { type: "click_done", now: T0 + 20 });
  assert.equal(s2.phase, "idle");
  assert.equal(s2.clickSeq, 2);
});

test("typing carries text and type_done returns to idle", () => {
  const s0 = cursorReducer(initialCursorState, { type: "typing", text: "hello", now: T0 });
  assert.equal(s0.phase, "typing");
  assert.equal(s0.typeText, "hello");
  assert.equal(s0.typeSeq, 1);
  const s1 = cursorReducer(s0, { type: "type_done", now: T0 + 100 });
  assert.equal(s1.phase, "idle");
  assert.equal(s1.typeText, "hello"); // text persists for the indicator
});

test("hide works from any phase and preserves position", () => {
  let s = cursorReducer(initialCursorState, { type: "move", x: 0.9, y: 0.1, now: T0 });
  s = cursorReducer(s, { type: "hide" });
  assert.equal(s.phase, "hidden");
  assert.equal(s.x, 0.9);
});

test("unknown events return the same state", () => {
  const s = cursorReducer(initialCursorState, { type: "explode" });
  assert.equal(s, initialCursorState);
});

/* ---------------- animation math ---------------- */

test("easeInOutCubic hits 0 / 0.5 / 1 exactly and stays in range", () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(-3), 0);
  assert.equal(easeInOutCubic(42), 1);
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const e = easeInOutCubic(t);
    assert.ok(e >= 0 && e <= 1, `ease out of range at t=${t}`);
  }
});

test("cursorPositionAt interpolates the glide with easing", () => {
  const s0 = cursorReducer(initialCursorState, { type: "show", x: 0, y: 0, now: T0 });
  const s1 = cursorReducer(s0, { type: "move", x: 1, y: 1, now: T0, durationMs: 1000 });
  assert.deepEqual(cursorPositionAt(s1, T0), { x: 0, y: 0 }); // t=0
  assert.deepEqual(cursorPositionAt(s1, T0 + 500), { x: 0.5, y: 0.5 }); // midpoint (cubic symmetric)
  assert.deepEqual(cursorPositionAt(s1, T0 + 1000), { x: 1, y: 1 }); // t=1
  assert.deepEqual(cursorPositionAt(s1, T0 + 5000), { x: 1, y: 1 }); // overshoot clamps
  const quarter = cursorPositionAt(s1, T0 + 250);
  assert.ok(quarter.x < 0.25, `eased position must lag linear at t=0.25 (got ${quarter.x})`);
});

test("cursorPositionAt is the terminal position outside the moving phase", () => {
  const s = cursorReducer(initialCursorState, { type: "show", x: 0.3, y: 0.6, now: T0 });
  assert.deepEqual(cursorPositionAt(s, T0 + 999), { x: 0.3, y: 0.6 });
});

test("moveExpired reports when the glide budget is exhausted", () => {
  const s0 = cursorReducer(initialCursorState, { type: "move", x: 1, y: 1, now: T0, durationMs: 500 });
  assert.equal(moveExpired(s0, T0 + 499), false);
  assert.equal(moveExpired(s0, T0 + 500), true);
  const idle = cursorReducer(s0, { type: "move_done", now: T0 + 500 });
  assert.equal(moveExpired(idle, T0 + 10_000), false);
});

test("clamp01 handles NaN and infinities", () => {
  assert.equal(clamp01(NaN), 0);
  assert.equal(clamp01(Infinity), 1);
  assert.equal(clamp01(-Infinity), 0);
});

/* ---------------- SSE payload validation ---------------- */

test("parseCursorEvent accepts well-formed events and clamps coordinates", () => {
  assert.deepEqual(parseCursorEvent({ type: "move", x: 0.25, y: 0.75 }), { type: "move", x: 0.25, y: 0.75, durationMs: undefined });
  assert.deepEqual(parseCursorEvent({ type: "move", x: 4, y: -1, durationMs: 300 }), { type: "move", x: 1, y: 0, durationMs: 300 });
  assert.deepEqual(parseCursorEvent({ type: "click" }), { type: "click", x: undefined, y: undefined });
  assert.deepEqual(parseCursorEvent({ type: "typing", text: "abc" }), { type: "typing", text: "abc", x: undefined, y: undefined });
  assert.deepEqual(parseCursorEvent({ type: "type_done" }), { type: "type_done" });
  assert.deepEqual(parseCursorEvent({ type: "hide" }), { type: "hide" });
  assert.deepEqual(parseCursorEvent({ type: "show", x: 0.1, y: 0.2 }), { type: "show", x: 0.1, y: 0.2 });
});

test("parseCursorEvent drops garbage", () => {
  assert.equal(parseCursorEvent(null), null);
  assert.equal(parseCursorEvent("click"), null);
  assert.equal(parseCursorEvent({ type: "detonate" }), null);
  assert.equal(parseCursorEvent({ type: "move" }), null); // missing coords
  assert.equal(parseCursorEvent({ type: "move", x: "0.5", y: 0.5 }), null); // non-numeric coords
  assert.equal(parseCursorEvent({ type: "move", x: NaN, y: 0.5 }), null);
});

/* ---------------- cursor bus ---------------- */

test("cursorBus dispatches to subscribers and tolerates throwing ones", () => {
  const seen = [];
  const unsub = cursorBus.subscribe((ev) => seen.push(ev));
  cursorBus.subscribe(() => {
    throw new Error("bad subscriber");
  });
  cursorBus.dispatch({ type: "click" });
  cursorBus.dispatch({ type: "type_done" });
  assert.deepEqual(seen, [{ type: "click" }, { type: "type_done" }]);
  unsub();
  cursorBus.dispatch({ type: "hide" });
  assert.equal(seen.length, 2); // no delivery after unsubscribe
});

/* ---------------- media box geometry ---------------- */

test("containRect letterboxes a 16:9 media into a 4:3 element (pillarbox)", () => {
  const r = containRect({ clientWidth: 400, clientHeight: 300, videoWidth: 1280, videoHeight: 720 });
  // 1280x720 scaled to fit 400x300 -> 400x225, centered vertically
  assert.equal(r.w, 400);
  assert.equal(r.h, 225);
  assert.equal(r.x, 0);
  assert.equal(r.y, 37.5);
});

test("containRect letterboxes a 4:3 media into a 16:9 element (letterbox)", () => {
  const r = containRect({ clientWidth: 640, clientHeight: 360, videoWidth: 400, videoHeight: 300 });
  // 400x300 scaled to fit 640x360 -> 480x360, centered horizontally
  assert.equal(r.w, 480);
  assert.equal(r.h, 360);
  assert.equal(r.x, 80);
  assert.equal(r.y, 0);
});

test("containRect falls back to the element box without intrinsic size", () => {
  const r = containRect({ clientWidth: 300, clientHeight: 200 });
  assert.deepEqual(r, { x: 0, y: 0, w: 300, h: 200 });
});

test("clientToNormalized maps points inside the media box and rejects outside ones", () => {
  const src = { clientWidth: 400, clientHeight: 300, videoWidth: 1280, videoHeight: 720 };
  const rect = { left: 10, top: 20, width: 400, height: 300 };
  // media box spans y 57.5..282.5 (rect.top + 37.5 .. + 225); center:
  const center = clientToNormalized(src, rect, 10 + 200, 20 + 37.5 + 112.5);
  assert.deepEqual(center, { x: 0.5, y: 0.5 });
  // top-left of the MEDIA box:
  const tl = clientToNormalized(src, rect, 10, 20 + 37.5);
  assert.deepEqual(tl, { x: 0, y: 0 });
  // letterbox area (above the media box) is OUTSIDE:
  assert.equal(clientToNormalized(src, rect, 10 + 200, 20 + 10), null);
  // beyond the element entirely:
  assert.equal(clientToNormalized(src, rect, 10 + 401, 20 + 150), null);
});

test("clientToNormalized falls back to element box when intrinsic size unknown", () => {
  const src = { clientWidth: 200, clientHeight: 100 };
  const rect = { left: 0, top: 0, width: 200, height: 100 };
  assert.deepEqual(clientToNormalized(src, rect, 100, 50), { x: 0.5, y: 0.5 });
  assert.deepEqual(clientToNormalized(src, rect, 200, 100), { x: 1, y: 1 });
});

test("normalizedToClient is the inverse of clientToNormalized", () => {
  const src = { clientWidth: 400, clientHeight: 300, naturalWidth: 1280, naturalHeight: 720 };
  const rect = { left: 5, top: 7, width: 400, height: 300 };
  const nx = 0.25;
  const ny = 0.75;
  const client = normalizedToClient(src, rect, nx, ny);
  const back = clientToNormalized(src, rect, client.x, client.y);
  assert.ok(Math.abs(back.x - nx) < 1e-9);
  assert.ok(Math.abs(back.y - ny) < 1e-9);
});

test("normalizedToClient clamps out-of-range input", () => {
  const src = { clientWidth: 100, clientHeight: 100, videoWidth: 100, videoHeight: 100 };
  const rect = { left: 0, top: 0, width: 100, height: 100 };
  assert.deepEqual(normalizedToClient(src, rect, 2, -1), { x: 100, y: 0 });
});
