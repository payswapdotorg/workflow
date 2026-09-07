import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Test hook for the M6 route-timeout guard (DISABLED by default).
 *
 * With ENABLE_DEBUG_ROUTES=1, `GET /api/debug/slow?ms=N` sleeps N ms (capped
 * at 120s) before answering — an artificial hung handler used by
 * e2e/api-timeout.mjs to prove the route guard returns a structured 503
 * instead of silence. Without the env flag this route 404s, so production
 * carries no sleep endpoint.
 */
export async function GET(req: Request) {
  if (process.env.ENABLE_DEBUG_ROUTES !== "1") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const raw = Number(new URL(req.url).searchParams.get("ms") ?? "35_000");
  const ms = Math.min(Number.isFinite(raw) ? Math.max(raw, 0) : 35_000, 120_000);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return NextResponse.json({ slept: ms });
}
