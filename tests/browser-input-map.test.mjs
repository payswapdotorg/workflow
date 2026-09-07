/**
 * Unit tests for the live-surface mapping helpers
 * (src/lib/browser-input-map.ts). Run: node --test tests/
 * These are the exact functions the operator's mouse/keyboard travel through
 * on the way to the remote page — geometry and key codes must be exact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPointerToPage, keyEventToWire, modifierMask, virtualKeyCode } from "../src/lib/browser-input-map.ts";

const RECT = { left: 100, top: 50, width: 640, height: 360 };

/* ---------------- pointer geometry ---------------- */

test("identity mapping when the mirror matches the viewport exactly", () => {
  /* 1280x720 frame in a 640x360 element: scale 0.5, centered, no letterbox */
  const p = mapPointerToPage({ rect: RECT, naturalW: 1280, naturalH: 720, frameW: 1280, frameH: 720, pageScaleFactor: 1 }, 100 + 320, 50 + 180);
  assert.equal(p.x, 640);
  assert.equal(p.y, 360);
});

test("center of the element maps to the center of the viewport", () => {
  const p = mapPointerToPage({ rect: RECT, naturalW: 1280, naturalH: 720, frameW: 1280, frameH: 720, pageScaleFactor: 1 }, 420, 230);
  assert.equal(p.x, 640);
  assert.equal(p.y, 360);
});

test("letterboxed content offsets are accounted for (taller element than frame)", () => {
  /* element 640x400, frame 1280x720 -> content 640x360, 20px bars top/bottom */
  const rect = { left: 0, top: 0, width: 640, height: 400 };
  const p = mapPointerToPage({ rect, naturalW: 1280, naturalH: 720, frameW: 1280, frameH: 720, pageScaleFactor: 1 }, 320, 200);
  assert.equal(p.x, 640, "horizontal center unaffected by vertical letterbox");
  assert.equal(p.y, 360, "click at content center (200 = bar 20 + content 180) maps to 360");
});

test("clicks outside the letterbox clamp instead of landing off-page", () => {
  const rect = { left: 0, top: 0, width: 640, height: 400 };
  const above = mapPointerToPage({ rect, naturalW: 1280, naturalH: 720, frameW: 1280, frameH: 720, pageScaleFactor: 1 }, 320, 5);
  assert.equal(above.y, 0, "click in the top letterbox bar clamps to y=0");
  const below = mapPointerToPage({ rect, naturalW: 1280, naturalH: 720, frameW: 1280, frameH: 720, pageScaleFactor: 1 }, 320, 395);
  assert.equal(below.y, 719, "click in the bottom bar clamps to the last row");
});

test("pageScaleFactor divides frame pixels into CSS pixels", () => {
  const p = mapPointerToPage({ rect: RECT, naturalW: 1280, naturalH: 720, frameW: 1280, frameH: 720, pageScaleFactor: 2 }, 100 + 320, 50 + 180);
  assert.equal(p.x, 320);
  assert.equal(p.y, 180);
});

test("missing natural size falls back to the frame metadata", () => {
  const p = mapPointerToPage({ rect: RECT, naturalW: 0, naturalH: 0, frameW: 1280, frameH: 720, pageScaleFactor: 1 }, 100 + 320, 50 + 180);
  assert.equal(p.x, 640);
  assert.equal(p.y, 360);
});

/* ---------------- keyboard mapping ---------------- */

test("plain printable characters become insertText", () => {
  for (const key of ["a", "Z", "5", "@", " "]) {
    const w = keyEventToWire({ key, code: "KeyA" });
    assert.deepEqual(w, { kind: "text", text: key });
  }
});

test("Enter becomes a full key event with \\r text so forms submit", () => {
  const w = keyEventToWire({ key: "Enter", code: "Enter" });
  assert.equal(w.kind, "key");
  assert.equal(w.text, "\r");
  assert.equal(w.vk, 13);
});

test("editing and navigation keys carry virtual key codes", () => {
  const cases = [
    { key: "Backspace", code: "Backspace", vk: 8 },
    { key: "Tab", code: "Tab", vk: 9 },
    { key: "Escape", code: "Escape", vk: 27 },
    { key: "Delete", code: "Delete", vk: 46 },
    { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
    { key: "PageDown", code: "PageDown", vk: 34 },
    { key: "Home", code: "Home", vk: 36 },
  ];
  for (const c of cases) {
    const w = keyEventToWire(c);
    assert.equal(w.kind, "key", c.key);
    assert.equal(w.vk, c.vk, c.key);
    assert.equal(w.text ?? null, null, `${c.key} carries no char text`);
  }
});

test("Space types a space via its key event", () => {
  const w = keyEventToWire({ key: "Space", code: "Space" });
  assert.equal(w.kind, "key");
  assert.equal(w.vk, 32);
  assert.equal(w.text, " ");
});

test("function keys compute their virtual codes", () => {
  assert.equal(virtualKeyCode({ key: "F5", code: "F5" }), 116);
  assert.equal(virtualKeyCode({ key: "F12", code: "F12" }), 123);
  const w = keyEventToWire({ key: "F5", code: "F5" });
  assert.equal(w.kind, "key");
});

test("letters and digits compute virtual codes from code or key", () => {
  assert.equal(virtualKeyCode({ key: "a", code: "KeyA" }), 65);
  assert.equal(virtualKeyCode({ key: "A", code: "KeyA" }), 65);
  assert.equal(virtualKeyCode({ key: "z", code: "KeyZ" }), 90);
  assert.equal(virtualKeyCode({ key: "5", code: "Digit5" }), 53);
  assert.equal(virtualKeyCode({ key: "?", code: "Slash" }), 191);
  assert.equal(virtualKeyCode({ key: "-", code: "Minus" }), 189);
});

test("ctrl combos become keycombo events the page can handle", () => {
  const w = keyEventToWire({ key: "a", code: "KeyA", ctrlKey: true });
  assert.equal(w.kind, "keycombo");
  assert.equal(w.modifiers, 2);
  const w2 = keyEventToWire({ key: "c", code: "KeyC", metaKey: true, shiftKey: true });
  assert.equal(w2.kind, "keycombo");
  assert.equal(w2.modifiers, 12);
});

test("reserved browser shortcuts stay local (null) so the operator keeps their tab", () => {
  for (const key of ["w", "t", "n", "l", "r", "W"]) {
    const w = keyEventToWire({ key, code: "KeyW", ctrlKey: true });
    assert.equal(w, null, `ctrl+${key} must stay local`);
  }
  const cmdT = keyEventToWire({ key: "t", code: "KeyT", metaKey: true });
  assert.equal(cmdT, null, "cmd+t must stay local");
});

test("modifierMask packs the CDP bitmask", () => {
  assert.equal(modifierMask({ key: "a", code: "KeyA" }), 0);
  assert.equal(modifierMask({ key: "a", code: "KeyA", altKey: true }), 1);
  assert.equal(modifierMask({ key: "a", code: "KeyA", ctrlKey: true }), 2);
  assert.equal(modifierMask({ key: "a", code: "KeyA", metaKey: true }), 4);
  assert.equal(modifierMask({ key: "a", code: "KeyA", shiftKey: true }), 8);
  assert.equal(modifierMask({ key: "a", code: "KeyA", ctrlKey: true, shiftKey: true }), 10);
});

test("unmapped long keys (IME composition) return null and stay local", () => {
  assert.equal(keyEventToWire({ key: "Dead", code: "" }), null);
  assert.equal(keyEventToWire({ key: "Process", code: "" }), null);
});
