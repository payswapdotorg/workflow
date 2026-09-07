import { NextRequest, NextResponse } from "next/server";
import { getLiveBridge } from "@/lib/browser-bridge-live";
import { withRouteTimeout } from "@/lib/api-guard";
import type { WireInput } from "@/lib/browser-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operator input onto the managed browser — the upstream half of the live
 * stage. Every mouse/keyboard event the operator performs on the mirror is
 * forwarded here and dispatched into the remote page through the CDP bridge
 * (clicks, drags, wheel, full key events, insertText). This is how the
 * operator resolves captchas and logs into chat.z.ai from the Replay view.
 */

const KINDS = new Set(["click", "dblclick", "rightclick", "down", "up", "move", "scroll", "key", "keycombo", "text"]);
const MAX_COORD = 100_000;
const MAX_TEXT = 5_000;

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.slice(0, max);
  return s.length > 0 ? s : null;
}

function parseInput(body: Record<string, unknown>): WireInput | null {
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!KINDS.has(kind)) return null;
  const x = num(body.x);
  const y = num(body.y);
  switch (kind) {
    case "click":
    case "dblclick":
    case "rightclick":
      if (x === null || y === null || x < 0 || y < 0 || x > MAX_COORD || y > MAX_COORD) return null;
      return { kind, x: Math.round(x), y: Math.round(y) };
    case "down":
    case "up": {
      if (x === null || y === null || x < 0 || y < 0 || x > MAX_COORD || y > MAX_COORD) return null;
      const button = body.button === "right" ? "right" : "left";
      const countRaw = num(body.count);
      const count = countRaw === null ? 1 : Math.max(1, Math.min(3, Math.round(countRaw)));
      return { kind, x: Math.round(x), y: Math.round(y), button, count };
    }
    case "move": {
      if (x === null || y === null || x < 0 || y < 0 || x > MAX_COORD || y > MAX_COORD) return null;
      const buttonsRaw = num(body.buttons);
      const buttons = buttonsRaw === null ? 0 : Math.max(0, Math.min(7, Math.round(buttonsRaw)));
      return { kind, x: Math.round(x), y: Math.round(y), buttons };
    }
    case "scroll": {
      if (x === null || y === null || x < 0 || y < 0 || x > MAX_COORD || y > MAX_COORD) return null;
      const dx = num(body.deltaX);
      const dy = num(body.deltaY);
      if (dx === null || dy === null || Math.abs(dx) > 100_000 || Math.abs(dy) > 100_000) return null;
      return { kind: "scroll", x: Math.round(x), y: Math.round(y), deltaX: Math.round(dx), deltaY: Math.round(dy) };
    }
    case "key":
    case "keycombo": {
      const key = str(body.key, 64);
      if (!key) return null;
      const code = typeof body.code === "string" ? body.code.slice(0, 64) : "";
      const vkRaw = num(body.vk);
      const vk = vkRaw === null ? null : Math.max(0, Math.min(255, Math.round(vkRaw)));
      const modRaw = num(body.modifiers);
      const modifiers = modRaw === null ? 0 : Math.max(0, Math.min(15, Math.round(modRaw)));
      const text = typeof body.text === "string" ? body.text.slice(0, 16) : null;
      return { kind, key, code, vk, modifiers, text };
    }
    case "text": {
      const text = str(body.text, MAX_TEXT);
      if (!text) return null;
      return { kind: "text", text };
    }
    default:
      return null;
  }
}

async function POST_impl(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const input = parseInput(body);
  if (!input) {
    return NextResponse.json({ error: "Malformed input event" }, { status: 400 });
  }

  const result = await getLiveBridge().input(input);
  if (!result.ok) {
    /* 409 keeps the client honest: the managed browser is not connected */
    return NextResponse.json({ error: result.error ?? "input rejected" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}

export const POST = withRouteTimeout(POST_impl, { timeoutMs: 15_000, label: "browser-input" });
