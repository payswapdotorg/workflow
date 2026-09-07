import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Managed external session — groundwork for the LLM supervising a chat.z.ai
 * session from TeachCast's console preview panel.
 *
 * A DEDICATED agent-browser session (`teachcast-managed`) is driven here, kept
 * deliberately separate from the agent toolset's own browser session
 * (`teachcast-agent`) so the operator can watch and control it without
 * interfering with workflow replays. The LLM-facing tool wiring for this
 * session lands in the next milestone; this route provides the operator-side
 * lifecycle: open (default: chat.z.ai), status, snapshot, close.
 */

const MANAGED_SESSION = "teachcast-managed";
export const MANAGED_SESSION_NAME = MANAGED_SESSION;
const DEFAULT_URL = "https://chat.z.ai";
const MAX_SNAPSHOT_CHARS = 20_000;

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

export async function GET() {
  const url = await cli(["get", "url"], 15_000);
  const active = url.ok && /^https?:\/\//i.test(url.output);
  return NextResponse.json({
    active,
    url: active ? url.output.split("\n")[0].trim() : null,
    error: url.ok ? null : url.output,
  });
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
      const status = await cli(["get", "url"], 15_000);
      return NextResponse.json({
        active: true,
        url: status.ok ? status.output.split("\n")[0].trim() : url,
        error: null,
      });
    }
    case "snapshot": {
      const res = await cli(["snapshot", "--text", "--compact"], 45_000);
      if (!res.ok) {
        return NextResponse.json(
          { error: `Managed browser snapshot failed: ${res.output}` },
          { status: 500 }
        );
      }
      return NextResponse.json({ snapshot: res.output, snapshotAt: new Date().toISOString() });
    }
    case "close": {
      const res = await cli(["close"], 30_000);
      return NextResponse.json({ active: false, ok: res.ok, error: res.ok ? null : res.output });
    }
    default:
      return NextResponse.json({ error: 'action must be "open" | "snapshot" | "close"' }, { status: 400 });
  }
}
