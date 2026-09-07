import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { MANAGED_BROWSER_SESSION } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Managed external session — M4 ACTUALIZATION.
 *
 * A DEDICATED agent-browser session (`teachcast-managed`, see
 * MANAGED_BROWSER_SESSION) is driven here, kept deliberately separate from the
 * agent toolset's own browser session (`teachcast-agent`) so the operator can
 * watch and control it without interfering with workflow replays.
 *
 * Operator-side lifecycle (console panel):
 *   - GET    → live state: active, connected target url, page title
 *   - open   → real navigation (default: chat.z.ai)
 *   - snapshot → text a11y snapshot + REAL page frame (PNG screenshot,
 *     returned as a data URL) — the "observation" shown in the console
 *   - close  → tear the managed browser down
 *
 * The operator chat drives the SAME session through the LLM toolset
 * (/api/chat with browserTarget:"managed"); console messages are never
 * recorded as workflow steps.
 */

const MANAGED_SESSION = MANAGED_BROWSER_SESSION;
export const MANAGED_SESSION_NAME = MANAGED_SESSION;
const DEFAULT_URL = "https://chat.z.ai";
const MAX_SNAPSHOT_CHARS = 20_000;
/** Screenshots land here (inside the gitignored workspace, never committed). */
const FRAME_DIR = path.join(process.cwd(), "workspace", ".managed");

function cli(args: string[], timeoutMs = 45_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "agent-browser",
      ["--session", MANAGED_SESSION, ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = [stdout?.toString() ?? "", stderr?.toString() ?? ""]
          .filter(Boolean)
          .join("\n")
          .trim()
          .slice(0, MAX_SNAPSHOT_CHARS);
        resolve({ ok: !err, output: out || (err ? String((err as Error).message ?? err) : "") });
      }
    );
  });
}

/** Only real http(s) URLs, no shell-hostile characters (execFile needs no quoting, but stay strict). */
function validUrl(url: string): boolean {
  return /^https?:\/\/[^\s"'`<>\\{}|^]{1,2000}$/.test(url);
}

/** Live state of the managed browser: {active, url, title}. */
async function liveState(): Promise<{ active: boolean; url: string | null; title: string | null }> {
  const [url, title] = await Promise.all([
    cli(["get", "url"], 15_000),
    cli(["get", "title"], 15_000),
  ]);
  const active = url.ok && /^https?:\/\//i.test(url.output);
  return {
    active,
    url: active ? url.output.split("\n")[0].trim() : null,
    title: active && title.ok ? title.output.split("\n")[0].trim().slice(0, 300) : null,
  };
}

/** Real frame of the managed page: PNG screenshot -> base64 data URL. */
async function captureFrame(): Promise<string | null> {
  await fs.mkdir(FRAME_DIR, { recursive: true });
  const file = path.join(FRAME_DIR, `managed-${Date.now()}.png`);
  try {
    const shot = await cli(["screenshot", file], 30_000);
    if (!shot.ok) return null;
    const buf = await fs.readFile(file);
    if (buf.length === 0) return null;
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

export async function GET() {
  const state = await liveState();
  return NextResponse.json({ ...state, error: state.active ? null : "managed browser not running" });
}

export async function POST(req: NextRequest) {
  let body: { action?: unknown; url?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = String(body.action ?? "");
  switch (action) {
    case "open": {
      const url = String(body.url ?? DEFAULT_URL).trim() || DEFAULT_URL;
      if (!validUrl(url)) {
        return NextResponse.json({ error: "url must be a plain http(s) URL" }, { status: 400 });
      }
      const res = await cli(["open", url]);
      if (!res.ok) {
        return NextResponse.json({ error: `Managed browser failed to open: ${res.output}` }, { status: 500 });
      }
      const state = await liveState();
      return NextResponse.json({ active: true, url: state.url ?? url, title: state.title, error: null });
    }
    case "snapshot": {
      const state = await liveState();
      if (!state.active) {
        return NextResponse.json({ error: "Managed session is not connected" }, { status: 409 });
      }
      const [text, frame] = await Promise.all([
        cli(["snapshot", "--text", "--compact"], 45_000),
        captureFrame(),
      ]);
      if (!text.ok && !frame) {
        return NextResponse.json(
          { error: `Managed browser snapshot failed: ${text.output}` },
          { status: 500 }
        );
      }
      return NextResponse.json({
        snapshot: text.ok ? text.output : null,
        frame,
        url: state.url,
        title: state.title,
        snapshotAt: new Date().toISOString(),
      });
    }
    case "close": {
      const res = await cli(["close"], 30_000);
      return NextResponse.json({ active: false, ok: res.ok, error: res.ok ? null : res.output });
    }
    default:
      return NextResponse.json({ error: 'action must be "open" | "snapshot" | "close"' }, { status: 400 });
  }
}
