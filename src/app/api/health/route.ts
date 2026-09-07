import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Component health for operators and orchestrators (M6 production hardening).
 *
 *   db      — hard dependency: a failed ping degrades the whole app -> 503
 *   browser — the agent-browser daemon: soft dependency (browser tools are
 *             optional at runtime) -> reported, but never degrades /api/health
 *
 * Each check has its own short budget so /api/health itself can never hang —
 * a health endpoint that hangs is worse than no health endpoint.
 */

type Check = { ok: boolean; detail: string; ms: number };

function rejectAfter(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms));
}

async function checkDb(): Promise<Check> {
  const start = Date.now();
  try {
    await Promise.race([db.$queryRaw`SELECT 1`, rejectAfter(3_000, "db ping")]);
    return { ok: true, detail: "SELECT 1 succeeded", ms: Date.now() - start };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "db ping failed", ms: Date.now() - start };
  }
}

async function checkBrowser(): Promise<Check> {
  const start = Date.now();
  // The lightest possible daemon round-trip; a missing daemon is a normal,
  // reportable state — not an error — so this never throws.
  const probe = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    try {
      execFile(
        "agent-browser",
        ["--session", "teachcast-managed", "get", "url"],
        { timeout: 4_000 },
        (err, stdout, stderr) => {
          if (!err) {
            const url = stdout.toString().trim();
            resolve({ ok: true, detail: url ? `daemon alive, managed session at ${url}` : "daemon alive" });
          } else {
            const text = (stdout.toString() + " " + stderr.toString() + " " + String(err.message ?? "")).trim();
            resolve({ ok: false, detail: text ? text.slice(0, 200) : "daemon not reachable" });
          }
        }
      );
    } catch (err) {
      resolve({ ok: false, detail: err instanceof Error ? err.message : "probe failed" });
    }
  });
  return { ...probe, ms: Date.now() - start };
}

export async function GET() {
  const [dbCheck, browserCheck] = await Promise.all([checkDb(), checkBrowser()]);
  const ok = dbCheck.ok;
  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      ts: new Date().toISOString(),
      checks: { db: dbCheck, browser: browserCheck },
    },
    { status: ok ? 200 : 503 }
  );
}
