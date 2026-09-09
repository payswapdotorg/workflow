/**
 * The provider ladder (M8) — pure, dependency-free.
 *
 * Decides which LLM provider serves completions, in precedence order:
 *   1. DB row (the Settings UI; the operator's explicit choice wins)
 *   2. Environment (PROVIDER_ENDPOINT + PROVIDER_API_KEY [+ PROVIDER_MODEL]) —
 *      the deployment channel: set these on Vercel to point straight at the
 *      self-hosted Modal GLM endpoint (see modal/) and the app never touches
 *      the built-in Z.ai dependency — no shared balance, no shared rate limit.
 *   3. Built-in z-ai-web-dev-sdk fallback (local dev convenience only).
 *
 * Kept in its own module (no imports — not even path aliases) so unit tests
 * can import it directly under node's TS type stripping, and so the
 * precedence rules stay pinned even as the IO around them evolves.
 */

export interface ProviderInfo {
  custom: boolean;
  endpoint: string;
  apiKey: string;
  model: string;
}

/** Which channel is currently serving completions — surfaces in /api/settings
 *  so the UI can show the operator what is ACTUALLY in effect, not just what
 *  the DB happens to contain. */
export type ProviderSource = "db" | "env" | "fallback";

export interface ResolvedProvider extends ProviderInfo {
  source: ProviderSource;
}

/** A provider row as stored in the DB (the Settings UI writes this). */
export interface ProviderRow {
  endpoint?: string | null;
  apiKey?: string | null;
  model?: string | null;
}

/**
 * Resolve the effective provider from a DB row and the process environment.
 * Rules:
 *  - A half-configured layer (endpoint without key) is skipped, not mixed —
 *    a missing key must never produce unauthenticated requests.
 *  - Whitespace is trimmed; blank values count as absent.
 */
export function resolveProvider(row: ProviderRow, env: NodeJS.ProcessEnv): ResolvedProvider {
  const dbEndpoint = (row?.endpoint ?? "").trim();
  const dbApiKey = (row?.apiKey ?? "").trim();
  if (dbEndpoint && dbApiKey) {
    return { custom: true, source: "db", endpoint: dbEndpoint, apiKey: dbApiKey, model: (row?.model ?? "").trim() };
  }
  const envEndpoint = (env.PROVIDER_ENDPOINT ?? "").trim();
  const envApiKey = (env.PROVIDER_API_KEY ?? "").trim();
  if (envEndpoint && envApiKey) {
    return { custom: true, source: "env", endpoint: envEndpoint, apiKey: envApiKey, model: (env.PROVIDER_MODEL ?? "").trim() };
  }
  return { custom: false, source: "fallback", endpoint: "", apiKey: "", model: "" };
}
