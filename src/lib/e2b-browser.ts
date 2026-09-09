/**
 * e2b-browser — the serverless browser backend for TeachCast (M8).
 *
 * WHY: on a serverless host (Vercel) there is no `agent-browser` binary, no
 * Chromium and no persistent daemon, so the M5 browser_control engine cannot
 * run locally. This module moves EXACTLY ONE thing: WHERE the agent-browser
 * CLI executes — inside an E2B sandbox instead of on the host. The tool
 * contract (sessions, refs, snapshots, exit codes, structured failures)
 * is byte-for-byte the CLI contract the M5 engine already speaks; nothing
 * about refs/stale-ref laws/error codes changes.
 *
 * Design laws (inherited from browser-tool.ts):
 *  - Same CliRunner contract: {session, subcommand, timeoutMs} -> CliOutcome.
 *    CLI exit codes are propagated — a failed action is NEVER reported as ok.
 *  - One sandbox per app process, find-or-create by metadata, because
 *    agent-browser sessions (`teachcast-agent`, `teachcast-managed`) already
 *    separate the agent's browser from the operator console's browser INSIDE
 *    the sandbox — mirroring the local model exactly.
 *  - Bounded, idempotent bootstrap: `agent-browser` + its Chromium are
 *    installed inside the sandbox on first use (or pre-baked via the custom
 *    template in e2b-template/), guarded by a marker file.
 *  - Duck-typed error mapping: the e2b SDK throws CommandExitError for
 *    non-zero exits and TimeoutError for over-budget commands; both are
 *    mapped onto CliOutcome {ok:false, exitCode, stderr, timedOut} so the
 *    engine's failure classification (transient spawn errors etc.) keeps
 *    working unchanged.
 *  - Dependency-injectable SDK: createE2bBrowser({sdk}) lets unit tests
 *    exercise find-or-create, bootstrap, quoting, exit-code and timeout
 *    mapping against a scripted fake — no network, no key.
 *
 * Env:
 *   E2B_API_KEY                 (required to activate; no key -> the module
 *                                refuses loudly instead of half-working)
 *   E2B_TEMPLATE                sandbox template id (default: "base";
 *                                use "teachcast-browser" once the custom
 *                                template from e2b-template/ is built)
 *   E2B_SANDBOX_TIMEOUT_MS      sandbox lifetime, default 15 min; bumped on
 *                                every call so an active session never times
 *                                out mid-action (max 24h per E2B plan)
 *   E2B_BOOTSTRAP_TIMEOUT_MS    one-shot install budget, default 5 min
 *
 * This module is server-side only. Node builtins + the e2b SDK import are
 * lazy (inside functions), so bundling the module into client code fails
 * at build time, not silently at runtime.
 */

import type { CliOutcome, CliRunner } from "./browser-tool";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export const E2B_METADATA_KIND = "teachcast-browser";
export const DEFAULT_E2B_TEMPLATE = "base";
export const DEFAULT_SANDBOX_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5 * 60_000;
/** Where browser_control screenshots land INSIDE the sandbox (E2B mode):
 *  the M5 engine resolves screenshot paths against its workspaceRoot, which
 *  is this value when the E2B backend is active. */
export const E2B_WORKSPACE_ROOT = "/root/workspace";

/** Minimal shape of the e2b SDK this module needs (structural typing keeps
 *  the unit-test fake honest and version-drift visible at the seam). */
export interface E2bSandboxLike {
  sandboxId: string;
  commands: {
    run(cmd: string, opts?: { timeoutMs?: number; cwd?: string; envs?: Record<string, string> }): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
      error?: string;
    }>;
  };
  files?: {
    read(path: string, opts?: { format?: string }): Promise<string | Uint8Array>;
  };
  isRunning?(): Promise<boolean>;
  kill?(): Promise<boolean>;
}

export interface E2bSdkLike {
  Sandbox: {
    create(template: string, opts?: Record<string, unknown>): Promise<E2bSandboxLike>;
    connect(sandboxId: string, opts?: Record<string, unknown>): Promise<E2bSandboxLike>;
    list(opts?: Record<string, unknown>): Promise<{ nextItems(): Promise<Array<{ sandboxId: string; metadata?: Record<string, string> }>>; hasNext: boolean }>;
    setTimeout?(sandboxId: string, timeoutMs: number, opts?: Record<string, unknown>): Promise<void>;
    kill?(sandboxId: string, opts?: Record<string, unknown>): Promise<boolean>;
  };
}

export interface E2bBrowserConfig {
  apiKey?: string;
  template?: string;
  sandboxTimeoutMs?: number;
  bootstrapTimeoutMs?: number;
  /** Skip the runtime agent-browser bootstrap (custom template already
   *  bakes it in). Default: false — bootstrap only if the marker is absent. */
  skipBootstrap?: boolean;
}

export interface E2bBrowserDeps {
  sdk: E2bSdkLike;
  config?: E2bBrowserConfig;
}

/* ------------------------------------------------------------------ */
/* Shell quoting (identical to browser-tool.ts's q())                  */
/* ------------------------------------------------------------------ */

/** Single-quote a dynamic token for bash. The e2b SDK runs commands through
 *  `/bin/bash -l -c`, so the quoting rules are the ones the M5 engine
 *  already relies on locally. */
export function q2(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/* ------------------------------------------------------------------ */
/* The backend                                                          */
/* ------------------------------------------------------------------ */

export interface E2bBrowser {
  /** The CliRunner the M5 engine consumes — contract-identical to
   *  realCliRunner, executed inside the sandbox. */
  runCli: CliRunner;
  /** Managed-console helper: agent-browser argv form (like the local
   *  execFile path in managed-session/route.ts), collapsed into one shell
   *  command for the sandbox. */
  runArgs(args: string[], timeoutMs?: number): Promise<{ ok: boolean; output: string }>;
  /** Read a file from the sandbox as base64 (screenshot fetch-back for
   *  the managed console frame). Returns null on any failure. */
  readFileBase64(path: string): Promise<string | null>;
  /** Current sandbox id (null until the first command creates/connects). */
  sandboxId(): string | null;
  /** Force a fresh find-or-create on the next call (tests, teardown). */
  reset(): void;
  /** Kill the sandbox (operator "close" is agent-browser level; this is the
   *  host-level teardown for tests and explicit lifecycle control). */
  kill(): Promise<boolean>;
}

export function createE2bBrowser(deps: E2bBrowserDeps): E2bBrowser {
  const { sdk } = deps;
  const apiKey = deps.config?.apiKey ?? process.env.E2B_API_KEY;
  const template = deps.config?.template ?? process.env.E2B_TEMPLATE ?? DEFAULT_E2B_TEMPLATE;
  const sandboxTimeoutMs =
    deps.config?.sandboxTimeoutMs ?? (Number(process.env.E2B_SANDBOX_TIMEOUT_MS) || DEFAULT_SANDBOX_TIMEOUT_MS);
  const bootstrapTimeoutMs =
    deps.config?.bootstrapTimeoutMs ?? (Number(process.env.E2B_BOOTSTRAP_TIMEOUT_MS) || DEFAULT_BOOTSTRAP_TIMEOUT_MS);

  let cached: E2bSandboxLike | null = null;
  let bootstrapped = false;

  function connOpts(): Record<string, unknown> {
    return apiKey ? { apiKey } : {};
  }

  /** Find a running sandbox owned by this app (metadata kind), newest first. */
  async function findExisting(): Promise<E2bSandboxLike | null> {
    if (typeof sdk.Sandbox.list !== "function") return null;
    try {
      const page = await sdk.Sandbox.list({
        query: { metadata: { kind: E2B_METADATA_KIND }, state: ["running"] },
        ...connOpts(),
      });
      const items = await page.nextItems();
      for (const info of items) {
        if (info?.metadata?.kind !== E2B_METADATA_KIND) continue;
        try {
          return await sdk.Sandbox.connect(info.sandboxId, connOpts());
        } catch {
          /* raced to timeout between list and connect — try the next */
        }
      }
    } catch {
      /* listing is an optimization, not a guarantee — fall through to create */
    }
    return null;
  }

  /**
   * One-time per sandbox: make sure agent-browser + a Chromium exist inside
   * it. Guarded by a marker file so reconnects (and Vercel cold starts that
   * reconnect to the same sandbox) skip straight to commands.
   * With the custom `teachcast-browser` template (e2b-template/) everything
   * is pre-baked and the probe finishes in one round-trip.
   */
  const BOOTSTRAP_MARKER = "/root/.teachcast-agent-browser";
  const BOOTSTRAP_SCRIPT = [
    `if [ -f ${BOOTSTRAP_MARKER} ]; then exit 0; fi`,
    `set -e`,
    `command -v agent-browser >/dev/null 2>&1 || npm install -g agent-browser`,
    /* Chromium system deps: best-effort — the custom template bakes them in;
       on a bare base image this apt pass is what makes Chrome start at all. */
    `(apt-get update -y && apt-get install -y --no-install-recommends ` +
      `libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 ` +
      `libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 ` +
      `libpango-1.0-0 libcairo2 fonts-liberation) || true`,
    `agent-browser install`,
    `mkdir -p ${E2B_WORKSPACE_ROOT}`,
    `touch ${BOOTSTRAP_MARKER}`,
  ].join("\n");

  async function ensureSandbox(): Promise<E2bSandboxLike> {
    if (cached) {
      /* Cheap liveness probe; a dead handle (sandbox timed out between
         actions) falls through to find-or-create instead of poisoning the
         next command. */
      try {
        if (cached.isRunning && (await cached.isRunning())) return cached;
      } catch {
        /* fall through */
      }
      cached = null;
    }
    const existing = await findExisting();
    cached = existing ?? (await sdk.Sandbox.create(template, { timeoutMs: sandboxTimeoutMs, metadata: { kind: E2B_METADATA_KIND }, ...connOpts() }));
    if (!bootstrapped && !deps.config?.skipBootstrap) {
      const r = await safeRun(cached, BOOTSTRAP_SCRIPT, bootstrapTimeoutMs);
      bootstrapped = true;
      if (!r.ok) {
        throw new Error(
          `E2B browser bootstrap failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(0, 400)}. ` +
            `Fix: build the custom template (e2b-template/) and set E2B_TEMPLATE=teachcast-browser, ` +
            `or raise E2B_BOOTSTRAP_TIMEOUT_MS.`
        );
      }
    }
    return cached;
  }

  /**
   * Run one shell command in the sandbox, mapping SDK exceptions onto the
   * CliOutcome contract (duck-typed: the real SDK throws CommandExitError
   * {exitCode, stdout, stderr} and TimeoutError; anything else surfaces as a
   * CLI_ERROR-style non-zero outcome with the message in stderr).
   */
  async function safeRun(
    sbx: E2bSandboxLike,
    cmd: string,
    timeoutMs: number
  ): Promise<CliOutcome> {
    try {
      const r = await sbx.commands.run(cmd, { timeoutMs });
      return { ok: r.exitCode === 0, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: false };
    } catch (err) {
      const e = err as { name?: string; exitCode?: unknown; stdout?: string; stderr?: string; message?: string; killed?: boolean };
      if (typeof e.exitCode === "number") {
        /* CommandExitError — the CLI genuinely exited non-zero */
        return {
          ok: false,
          exitCode: e.exitCode,
          stdout: e.stdout ?? "",
          stderr: [e.stderr, e.message && e.message !== e.stderr ? e.message : ""].filter(Boolean).join("\n"),
          timedOut: false,
        };
      }
      const timedOut = e?.name === "TimeoutError" || /timeout/i.test(String(e?.message ?? ""));
      return {
        ok: false,
        exitCode: timedOut ? 124 : 1,
        stdout: e.stdout ?? "",
        stderr: String(e?.message ?? err),
        timedOut,
      };
    }
  }

  /** Bump the sandbox lifetime so an active browser never dies mid-session.
   *  Best-effort: older SDKs without setTimeout are skipped silently. */
  async function keepAlive(sbx: E2bSandboxLike): Promise<void> {
    if (typeof sdk.Sandbox.setTimeout !== "function") return;
    try {
      await sdk.Sandbox.setTimeout(sbx.sandboxId, sandboxTimeoutMs, connOpts());
    } catch {
      /* a failed bump must never fail the user's action */
    }
  }

  const runCli: CliRunner = async ({ session, subcommand, timeoutMs }) => {
    if (!apiKey) {
      /* Loud, structured refusal — surfaces through the engine's
         BROWSER_UNAVAILABLE path, never a silent local fallback. */
      return {
        ok: false,
        exitCode: 127,
        stdout: "",
        stderr: "E2B browser backend selected but E2B_API_KEY is not set.",
        timedOut: false,
      };
    }
    const sbx = await ensureSandbox();
    void keepAlive(sbx);
    return safeRun(sbx, `agent-browser --session ${q2(session)} ${subcommand}`, timeoutMs);
  };

  const runArgs = async (args: string[], timeoutMs = 45_000) => {
    if (!apiKey) return { ok: false, output: "E2B browser backend selected but E2B_API_KEY is not set." };
    const sbx = await ensureSandbox();
    void keepAlive(sbx);
    const cmd = ["agent-browser", ...args.map(q2)].join(" ");
    const r = await safeRun(sbx, cmd, timeoutMs);
    const output = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
    return { ok: r.ok, output: r.ok ? output : output || `exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}` };
  };

  const readFileBase64 = async (path: string): Promise<string | null> => {
    try {
      const sbx = await ensureSandbox();
      if (!sbx.files) return null;
      const data = await sbx.files.read(path, { format: "bytes" });
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      if (bytes.length === 0) return null;
      return bytes.toString("base64");
    } catch {
      return null;
    }
  };

  return {
    runCli,
    runArgs,
    readFileBase64,
    sandboxId: () => cached?.sandboxId ?? null,
    reset: () => {
      cached = null;
      bootstrapped = false;
    },
    kill: async () => {
      const id = cached?.sandboxId ?? null;
      cached = null;
      bootstrapped = false;
      if (!id || typeof sdk.Sandbox.kill !== "function") return false;
      try {
        return await sdk.Sandbox.kill(id, connOpts());
      } catch {
        return false;
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* The production instance                                              */
/* ------------------------------------------------------------------ */

/**
 * True when the E2B backend should own browser_control: BROWSER_BACKEND=e2b
 * explicitly, OR E2B_API_KEY is present without an explicit "local".
 * Default stays local (zero behavior change for existing deployments);
 * on Vercel you set E2B_API_KEY and the browser capability follows.
 */
export function e2bBrowserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const backend = (env.BROWSER_BACKEND ?? "").trim().toLowerCase();
  if (backend === "e2b") return true;
  if (backend === "local") return false;
  return Boolean((env.E2B_API_KEY ?? "").trim());
}

let production: E2bBrowser | null = null;

/** The app-wide backend. Lazy: the e2b SDK import (and the key check) only
 *  happen when browser work is actually requested. */
export function getE2bBrowser(): E2bBrowser {
  if (!production) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require("e2b") as E2bSdkLike;
    production = createE2bBrowser({ sdk });
  }
  return production;
}

export { q2 as e2bQuote };
