/**
 * Pure mapping helpers for the live browser surface (client + tests).
 *
 * Shared by src/components/teachcast/live-browser-surface.tsx (DOM values are
 * gathered there and passed in as plain objects) and by
 * tests/browser-input-map.test.mjs. No DOM types, no path aliases — node's
 * TS type stripping imports this file directly in the test battery.
 *
 * Three jobs:
 *  1. mapPointerToPage — a click on the scaled <img> mirror (object-contain,
 *     possible letterboxing) to CSS page coordinates inside the remote
 *     browser viewport.
 *  2. keyEventToWire — a browser KeyboardEvent to the wire shape
 *     /api/browser-input accepts (printable chars become insertText; named
 *     keys become full key events with virtual key codes; browser-reserved
 *     combinations return null and stay local).
 *  3. modifierMask — the CDP modifier bitmask from the event's modifier flags.
 */

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PointerMapInput {
  /** getBoundingClientRect() of the rendered <img> element. */
  rect: RectLike;
  /** naturalWidth/naturalHeight of the current frame JPEG (frame pixels). */
  naturalW: number;
  naturalH: number;
  /** Screencast metadata: the remote viewport in device pixels. */
  frameW: number;
  frameH: number;
  /** Page scale factor from screencast metadata (1 in plain headless). */
  pageScaleFactor: number;
}

export interface PagePoint {
  x: number;
  y: number;
}

/** Clamp helper used on both axes after mapping. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Map a pointer position over the rendered mirror to CSS page coordinates in
 * the remote viewport. The <img> uses object-contain: the frame is centered
 * and scaled uniformly, so the content box is derived from natural size vs
 * the element rect, then frame pixels are divided by the page scale factor
 * to land in CSS pixels (what Input.dispatchMouseEvent expects).
 */
export function mapPointerToPage(
  input: PointerMapInput,
  clientX: number,
  clientY: number
): PagePoint {
  const { rect, naturalW, naturalH, frameW, frameH, pageScaleFactor } = input;
  const psf = pageScaleFactor > 0 ? pageScaleFactor : 1;
  const natW = naturalW > 0 ? naturalW : frameW;
  const natH = naturalH > 0 ? naturalH : frameH;
  const scale = natW > 0 && natH > 0 ? Math.min(rect.width / natW, rect.height / natH) : 1;
  /* uniform scale, centered content (object-contain) */
  const contentW = natW * scale;
  const contentH = natH * scale;
  const offX = rect.left + (rect.width - contentW) / 2;
  const offY = rect.top + (rect.height - contentH) / 2;
  /* frame-pixel coordinates inside the JPEG */
  const fx = (clientX - offX) / (scale > 0 ? scale : 1);
  const fy = (clientY - offY) / (scale > 0 ? scale : 1);
  /* frame pixels -> CSS page pixels, then clamp to the viewport */
  const w = (frameW > 0 ? frameW : natW) / psf;
  const h = (frameH > 0 ? frameH : natH) / psf;
  return { x: clamp(Math.round(fx / psf), 0, Math.max(0, Math.floor(w - 1))), y: clamp(Math.round(fy / psf), 0, Math.max(0, Math.floor(h - 1))) };
}

/* ------------------------------------------------------------------ */
/* Keyboard mapping                                                    */
/* ------------------------------------------------------------------ */

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8. */
export const MOD_ALT = 1;
export const MOD_CTRL = 2;
export const MOD_META = 4;
export const MOD_SHIFT = 8;

export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export function modifierMask(e: KeyEventLike): number {
  let m = 0;
  if (e.altKey) m |= MOD_ALT;
  if (e.ctrlKey) m |= MOD_CTRL;
  if (e.metaKey) m |= MOD_META;
  if (e.shiftKey) m |= MOD_SHIFT;
  return m;
}

/** Named-key virtual key codes (US layout) — the ones pages actually use. */
const NAMED_VK: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  Delete: 46,
  Insert: 45,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Space: 32,
  Pause: 19,
  CapsLock: 20,
  ContextMenu: 93,
};

/** Punctuation by KeyboardEvent.code (US layout). */
const CODE_VK: Record<string, number> = {
  Backquote: 192,
  Minus: 189,
  Equal: 187,
  BracketLeft: 219,
  BracketRight: 221,
  Backslash: 220,
  Semicolon: 186,
  Quote: 222,
  Comma: 188,
  Period: 190,
  Slash: 191,
  Space: 32,
};

/** Compute the Windows virtual key code from key/code names. */
export function virtualKeyCode(e: KeyEventLike): number | null {
  if (NAMED_VK[e.key] !== undefined) return NAMED_VK[e.key];
  if (/^F(1[0-2]|[1-9])$/.test(e.key)) return 111 + Number(e.key.slice(1));
  if (/^Key[A-Z]$/.test(e.code)) return 65 + (e.code.charCodeAt(3) - 65);
  if (/^Digit[0-9]$/.test(e.code)) return 48 + Number(e.code.slice(5));
  if (/^Numpad[0-9]$/.test(e.code)) return 96 + Number(e.code.slice(6));
  if (CODE_VK[e.code] !== undefined) return CODE_VK[e.code];
  if (e.key.length === 1) {
    const lower = e.key.toLowerCase();
    if (lower >= "a" && lower <= "z") return 65 + (lower.charCodeAt(0) - 97);
    if (lower >= "0" && lower <= "9") return 48 + (lower.charCodeAt(0) - 48);
  }
  return null;
}

export type WireKeyInput = { kind: "text"; text: string } | { kind: "key"; key: string; code: string; vk: number | null; modifiers: number; text: string | null } | { kind: "keycombo"; key: string; code: string; vk: number | null; modifiers: number };

/**
 * Map a KeyboardEvent to the wire input. Rules:
 *  - Plain printable characters (no Ctrl/Meta) become insertText — the most
 *    robust path into real input fields (no layout/keyCode guessing).
 *  - Enter keeps its full key event WITH text "\r" so forms submit and
 *    buttons activate exactly like a local press.
 *  - Named/editing keys and Shift combos become full key events.
 *  - Ctrl/Meta combos are forwarded as keycombo (the page decides) — except
 *    reserved browser shortcuts (Ctrl/Cmd+W/T/N/L...) which return null and
 *    must stay local so the operator can still drive their own browser.
 */
export function keyEventToWire(e: KeyEventLike): WireKeyInput | null {
  const modifiers = modifierMask(e);
  const ctrlOrMeta = e.ctrlKey === true || e.metaKey === true;

  if (ctrlOrMeta) {
    /* reserved browser shortcuts stay local — never swallow the operator's tab */
    const reserved = ["w", "t", "n", "l", "W", "T", "N", "L", "r", "R", "q", "Q", "p", "P", "j", "J", "d", "D", "f", "F", "h", "H", "ArrowLeft", "ArrowRight"];
    if (reserved.includes(e.key)) return null;
    return { kind: "keycombo", key: e.key, code: e.code, vk: virtualKeyCode(e), modifiers };
  }

  if (e.key === "Enter") {
    return { kind: "key", key: "Enter", code: e.code === "" ? "Enter" : e.code, vk: 13, modifiers, text: "\r" };
  }

  if (e.key.length === 1) {
    /* plain printable character (Shifted letters and punctuation included) */
    return { kind: "text", text: e.key };
  }

  const vk = virtualKeyCode(e);
  if (vk !== null) {
    const text = e.key === "Space" ? " " : null;
    return { kind: "key", key: e.key, code: e.code, vk, modifiers, text };
  }
  /* unmapped long key names (Dead, Process, IME composition...) — let the
     local browser keep them; text input still works via insertText */
  return null;
}
