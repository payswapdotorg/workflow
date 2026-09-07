/**
 * Unit tests for the learning-mode capture reducer + draft synthesis +
 * lesson protocol (src/lib/teach-capture.ts) — M7 dual-cursor.
 * Run: node --test tests/teach-capture.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureReducer,
  synthesizeSteps,
  parseTeachCommand,
  initialCaptureState,
  MOVE_SAMPLE_MS,
  TYPE_BURST_GAP_MS,
} from "../src/lib/teach-capture.ts";

const T0 = 50_000;

/* ---------------- arming ---------------- */

test("arm starts a FRESH lesson and gates all capture", () => {
  const s0 = captureReducer(initialCaptureState, { type: "pointer_click", x: 0.5, y: 0.5, ts: T0, thumb: "data:image/jpeg,x" });
  assert.equal(s0.events.length, 0, "clicks before arm are ignored");
  const s1 = captureReducer(s0, { type: "pointer_move", x: 0.1, y: 0.1, ts: T0 + 1 });
  assert.equal(s1.events.length, 0, "moves before arm are ignored");
  const s2 = captureReducer(s1, { type: "arm", ts: T0 + 2 });
  assert.equal(s2.armed, true);
  assert.equal(s2.events.length, 0, "arming clears any pre-arm pollution");
  const s3 = captureReducer(s2, { type: "pointer_click", x: 0.5, y: 0.5, ts: T0 + 3, thumb: null });
  assert.equal(s3.events.length, 1, "clicks after arm are recorded");
});

test("events after disarm are ignored and pending bursts are flushed", () => {
  let s = captureReducer(initialCaptureState, { type: "arm", ts: T0 });
  s = captureReducer(s, { type: "key", char: "h", ts: T0 + 10 });
  s = captureReducer(s, { type: "disarm", ts: T0 + 20 });
  assert.equal(s.armed, false);
  assert.equal(s.events.length, 1, "the open burst is materialized on disarm");
  assert.equal(s.events[0].kind, "typing");
  s = captureReducer(s, { type: "key", char: "x", ts: T0 + 30 });
  s = captureReducer(s, { type: "pointer_click", x: 0.1, y: 0.1, ts: T0 + 40 });
  assert.equal(s.events.length, 1, "nothing is captured while disarmed");
});

test("disarm while already disarmed is a no-op", () => {
  const s = captureReducer(initialCaptureState, { type: "disarm", ts: T0 });
  assert.equal(s, initialCaptureState);
});

/* ---------------- pointer move sampling ---------------- */

test("moves are SAMPLED (>=80ms gap), not streamed raw", () => {
  let s = captureReducer(initialCaptureState, { type: "arm", ts: T0 });
  s = captureReducer(s, { type: "pointer_move", x: 0.1, y: 0.1, ts: T0 });
  s = captureReducer(s, { type: "pointer_move", x: 0.11, y: 0.11, ts: T0 + MOVE_SAMPLE_MS - 1 });
  assert.equal(s.events.length, 1, "sub-gap move is dropped");
  s = captureReducer(s, { type: "pointer_move", x: 0.2, y: 0.2, ts: T0 + MOVE_SAMPLE_MS });
  assert.equal(s.events.length, 2, "gap>=sample window records");
  assert.equal(s.lastMoveTs, T0 + MOVE_SAMPLE_MS);
});

test("moves are clamped to 0..1", () => {
  let s = captureReducer(initialCaptureState, { type: "arm", ts: T0 });
  s = captureReducer(s, { type: "pointer_move", x: 1.7, y: -0.2, ts: T0 });
  assert.deepEqual(s.events[0], { kind: "move", x: 1, y: 0, ts: T0 });
});

/* ---------------- clicks ---------------- */

test("clicks carry normalized coords + thumbnail and always record", () => {
  let s = captureReducer(initialCaptureState, { type: "arm", ts: T0 });
  s = captureReducer(s, { type: "pointer_click", x: 0.34, y: 0.62, ts: T0 + 5, thumb: "data:image/jpeg;base64,AAA" });
  assert.equal(s.clickCount, 1);
  assert.deepEqual(s.events[0], { kind: "click", x: 0.34, y: 0.62, ts: T0 + 5, thumb: "data:image/jpeg;base64,AAA" });
  s = captureReducer(s, { type: "pointer_click", x: 1.4, y: 0.3, ts: T0 + 6 });
  assert.equal(s.events[1].x, 1, "out-of-range click clamped");
  assert.equal(s.events[1].thumb, null, "missing thumb stored as null");
});

test("a click closes an open typing burst first (modality switch)", () => {
  let s = captureReducer(initialCaptureState, { type: "arm", ts: T0 });
  s = captureReducer(s, { type: "key", char: "a", ts: T0 + 10 });
  s = captureReducer(s, { type: "key", char: "b", ts: T0 + 20 });
  s = captureReducer(s, { type: "pointer_click", x: 0.5, y: 0.5, ts: T0 + 30 });
  assert.equal(s.events.length, 2);
  assert.equal(s.events[0].kind, "typing");
  assert.equal(s.events[0].text, "ab");
  assert.equal(s.events[1].kind, "click");
});

/* ---------------- typing bursts ---------------- */

test("keystrokes collapse into bursts; silence beyond the gap starts a new one", () => {
  let s = captureReducer(initialCaptureState, { type: "arm", ts: T0 });
  for (let i = 0; i < 5; i++) s = captureReducer(s, { type: "key", char: String(i), ts: T0 + i * 100 });
  assert.equal(s.events.length, 0, "burst stays open while typing continues");
  // silence longer than the burst gap -> first burst flushed
  s = captureReducer(s, { type: "key", char: "x", ts: T0 + 4 * 100 + TYPE_BURST_GAP_MS + 1 });
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].kind, "typing");
  assert.equal(s.events[0].text, "01234");
  assert.equal(s.burstChars.length, 1, "the new burst holds the fresh char");
  assert.equal(s.events[0].endTs, T0 + 400);
});

test("typing bursts ignore capture while disarmed and skip empty chars", () => {
  let s = captureReducer(initialCaptureState, { type: "key", char: "z", ts: T0 });
  assert.equal(s.burstChars.length, 0);
  s = captureReducer(initialCaptureState, { type: "arm", ts: T0 });
  s = captureReducer(s, { type: "key", char: "", ts: T0 + 1 });
  assert.equal(s.burstChars.length, 0);
});

test("reset returns to the pristine state", () => {
  let s = captureReducer(initialCaptureState, { type: "arm", ts: T0 });
  s = captureReducer(s, { type: "pointer_click", x: 0.5, y: 0.5, ts: T0 + 1 });
  s = captureReducer(s, { type: "reset" });
  assert.deepEqual(s, initialCaptureState);
});

/* ---------------- synthesis ---------------- */

test("synthesizeSteps: clicks + typing become steps; moves are context only", () => {
  const events = [
    { kind: "move", x: 0.1, y: 0.1, ts: 1 },
    { kind: "click", x: 0.25, y: 0.5, ts: 2, thumb: "data:image/jpeg;base64,THUMB" },
    { kind: "move", x: 0.3, y: 0.5, ts: 3 },
    { kind: "typing", text: "hello world", ts: 4, endTs: 5 },
    { kind: "click", x: 0.75, y: 0.2, ts: 6, thumb: null },
  ];
  const steps = synthesizeSteps(events);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].kind, "action");
  assert.equal(steps[0].payload.actionType, "click");
  assert.equal(steps[0].payload.x, 0.25);
  assert.equal(steps[0].payload.y, 0.5);
  assert.equal(steps[0].payload.thumb, "data:image/jpeg;base64,THUMB");
  assert.ok(steps[0].payload.label.includes("25%"), `label mentions the position: ${steps[0].payload.label}`);
  assert.equal(steps[1].payload.actionType, "type");
  assert.equal(steps[1].payload.text, "hello world");
  assert.ok(steps[1].payload.label.startsWith("Type:"));
  assert.equal(steps[2].payload.actionType, "click");
  assert.equal(steps[2].payload.thumb, null);
  // ts fields are ISO strings
  assert.ok(!Number.isNaN(Date.parse(steps[0].ts)));
  assert.equal(steps[0].ts, new Date(2).toISOString());
});

test("synthesizeSteps respects the 80-step hard cap (workflow API limit)", () => {
  const events = [];
  for (let i = 0; i < 200; i++) events.push({ kind: "click", x: i / 200, y: 0.5, ts: i, thumb: null });
  const steps = synthesizeSteps(events);
  assert.equal(steps.length, 80);
  const capped = synthesizeSteps(events.slice(0, 5), { maxSteps: 3 });
  assert.equal(capped.length, 3);
});

test("synthesizeSteps of an empty lesson is an empty draft", () => {
  assert.deepEqual(synthesizeSteps([]), []);
  const movesOnly = [{ kind: "move", x: 0.5, y: 0.5, ts: 1 }];
  assert.deepEqual(synthesizeSteps(movesOnly), []);
});

/* ---------------- lesson protocol ---------------- */

test("parseTeachCommand: watch phrases arm, learn phrases synthesize", () => {
  assert.equal(parseTeachCommand("watch this"), "watch");
  assert.equal(parseTeachCommand("Watch this!"), "watch");
  assert.equal(parseTeachCommand("watch me do the export"), "watch");
  assert.equal(parseTeachCommand("WATCH THIS: filling the form now"), "watch");
  assert.equal(parseTeachCommand("observe this"), "watch");
  assert.equal(parseTeachCommand("start watching"), "watch");
  assert.equal(parseTeachCommand("learn this"), "learn");
  assert.equal(parseTeachCommand("Learn that."), "learn");
  assert.equal(parseTeachCommand("did you get that"), "learn");
  assert.equal(parseTeachCommand("that's the lesson"), "learn");
});

test("parseTeachCommand ignores ordinary sentences mentioning the words", () => {
  assert.equal(parseTeachCommand("I want you to learn this workflow later"), null, "prefix match only");
  assert.equal(parseTeachCommand("please start the export"), null);
  assert.equal(parseTeachCommand("did you get that error too"), "learn", "documented prefix semantics");
  assert.equal(parseTeachCommand(""), null);
  assert.equal(parseTeachCommand("   "), null);
});

test("parseTeachCommand: learn takes precedence when both phrases appear", () => {
  assert.equal(parseTeachCommand("learn this — watch this first"), "learn");
});
