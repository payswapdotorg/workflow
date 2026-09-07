import { NextResponse } from "next/server";
import { withRouteTimeout } from "@/lib/api-guard";

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
 *
 * The handler itself runs under withRouteTimeout like every other JSON
 * route — that is the entire point of the e2e: a handler that sleeps past
 * the 30s budget must be answered BY the guard (503 ROUTE_TIMEOUT), so the
 * hung path has to flow through the exact wrapper the data routes use.
 */
export const GET = withRouteTimeout(
  async (req: Request) => {
    if (process.env.ENABLE_DEBUG_ROUTES !== "1") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const raw = Number(new URL(req.url).searchParams.get("ms") ?? "35000");
    const ms = Math.min(Number.isFinite(raw) ? Math.max(raw, 0) : 35_000, 120_000);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return NextResponse.json({ slept: ms });
  },
  { label: "debug/slow" }
);
