/**
 * Route-level hang guard (M6 production hardening).
 *
 * Live incident: under host memory pressure the Prisma client inside
 * /api/workflows/[id] never settled — the request hung FOREVER, the client
 * saw no error and no timeout, and the server only logged "200" when the
 * client disconnected. Every JSON route now runs under withRouteTimeout():
 * if the handler does not settle within its budget, the client gets a
 * structured 503 instead of silence.
 *
 * The core is dependency-free (no next/server import) so node --test can
 * exercise the timeout path directly; routes pass NextResponse.json as the
 * json serializer.
 *
 * Note on semantics: an aborted (hung) handler promise cannot be killed —
 * the guard only stops WAITING on it and answers the client. The runaway is
 * logged server-side at the moment of the timeout.
 */

export const DEFAULT_ROUTE_TIMEOUT_MS = 30_000;

/** Structured 503 body for a timed-out route. */
export interface TimeoutBody {
  error: {
    code: "ROUTE_TIMEOUT";
    message: string;
    remedy: string;
  };
}

export class RouteTimeoutError extends Error {
  readonly budgetMs: number;
  constructor(budgetMs: number) {
    super(`route did not settle within ${budgetMs}ms`);
    this.name = "RouteTimeoutError";
    this.budgetMs = budgetMs;
  }
}

type Handler<Ctx, Req> = (req: Req, ctx: Ctx) => Promise<unknown> | unknown;

export interface RouteGuardOptions {
  /** Budget in ms (default 30_000; env override TEACHCAST_ROUTE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** JSON serializer — defaults to the web-standard Response.json. */
  json?: (body: TimeoutBody, status: number) => Response;
  /** Extra detail stamped into the server-side log line. */
  label?: string;
}

function resolveBudget(explicit?: number): number {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const env = Number(process.env.TEACHCAST_ROUTE_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_ROUTE_TIMEOUT_MS;
}

/**
 * Wrap a route handler with a hard response deadline. On timeout the client
 * receives `503 {error:{code:"ROUTE_TIMEOUT",...}}` — never silence.
 *
 * Per-route budgets (set at the call site, tuned to the route's real work):
 *   data routes 30s · tools/exec + managed-session 60s · compile 120s.
 * Streaming routes (/api/chat SSE) are NOT wrapped: they stream progressively
 * and are already bounded by the client watchdogs (45s idle / 120s total).
 */
export function withRouteTimeout<Ctx, Req = Request>(handler: Handler<Ctx, Req>, opts: RouteGuardOptions = {}) {
  const budgetMs = resolveBudget(opts.timeoutMs);
  const json = opts.json ?? ((body, status) => Response.json(body, { status }));

  return async (req: Req, ctx: Ctx): Promise<Response> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RouteTimeoutError(budgetMs)), budgetMs);
      });
      return (await Promise.race([Promise.resolve(handler(req, ctx)), timeout])) as Response;
    } catch (err) {
      if (err instanceof RouteTimeoutError) {
        const path = (() => {
          try {
            return new URL((req as Request).url).pathname;
          } catch {
            return opts.label ?? "unknown-route";
          }
        })();
        /* Server-side evidence line: the hung handler is still out there; this
           is the moment we stopped making the operator wait for it. */
        console.error(
          `[api-guard] ROUTE_TIMEOUT after ${budgetMs}ms on ${path}${opts.label ? ` (${opts.label})` : ""} — hung handler NOT killed, only unawaited`
        );
        return json(
          {
            error: {
              code: "ROUTE_TIMEOUT",
              message: `The route did not complete within ${Math.round(budgetMs / 1000)}s and was aborted.`,
              remedy: "Retry the request. If it repeats, check GET /api/health for component status (db, browser daemon).",
            },
          },
          503
        );
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
