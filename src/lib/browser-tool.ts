/**
 * browser_control — production computer-use engine (M5).
 *
 * ONE tool whose `action` union maps 1:1 onto the real agent-browser CLI.
 * Design laws (OpenClaw + Hermes patterns):
 *
 *  - Perception before action: refs come from the CURRENT snapshot. Refs are
 *    ephemeral — any state change invalidates them.
 *  - Stale-ref law: a ref that was in our last snapshot but now fails gets
 *    ONE bounded recovery (re-snapshot + retry once). A ref that was never
 *    seen fails FAST (UNKNOWN_REF) — never a wrong click.
 *  - Structured errors: every failure throws BrowserActionError whose message
 *    is one compact JSON line {code, message, remedy[, snapshot]}. CLI exit
 *    codes are propagated — a failed action is NEVER reported as ok.
 *  - Bounded escalation, as REACTION only: ref → re-snapshot+retry once →
 *    fill→focus+inserttext fallback → coords → screenshot + report.
 *
 * This module is dependency-injectable: createBrowserTool({ runCli,
 * workspaceRoot }) takes the CLI runner as a dependency so unit tests can
 * exercise every action, error code and recovery path against scripted
 * outcomes. The production runner is exported as realCliRunner.
 * Self-contained on purpose: node builtins only, no path aliases (tests
 * import this file directly under node's TS type stripping).
 */

import { exec } from "child_process";
import { promises as fs } from "fs";
import path from "path";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type CliOutcome = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** process was killed by the runner's timeout */
  timedOut?: boolean;
};

export type CliRunner = (call: {
  session: string;
  /** full agent-browser subcommand, e.g. `click '@e5'` (without --json) */
  subcommand: string;
  timeoutMs: number;
}) => Promise<CliOutcome>;

export type BrowserErrorCode =
  | "UNKNOWN_REF"
  | "STALE_REF"
  | "CLICK_COVERED"
  | "TIMEOUT"
  | "CLI_ERROR"
  | "INVALID_ARGS"
  | "BROWSER_UNAVAILABLE";

export class BrowserActionError extends Error {
  readonly code: BrowserErrorCode;
  readonly remedy: string;
  /** extra context for the model (e.g. the fresh snapshot after a dead end) */
  readonly details?: string;

  constructor(code: BrowserErrorCode, message: string, remedy: string, details?: string) {
    super(details ? JSON.stringify({ code, message, remedy, snapshot: details }) : JSON.stringify({ code, message, remedy }));
    this.name = "BrowserActionError";
    this.code = code;
    this.remedy = remedy;
    this.details = details;
  }
}

export interface BrowserToolDeps {
  runCli: CliRunner;
  workspaceRoot: string;
  /** Backoff before the single transient-failure retry (default 2000ms). */
  retryBackoffMs?: number;
}

/* ------------------------------------------------------------------ */
/* Argument + ref validation                                           */
/* ------------------------------------------------------------------ */

/** Accepts "e5" or "@e5"; returns the canonical "@e5" or null. Models
 *  occasionally emit a ref wrapped in stray quote characters ("\"@e42\"" —
 *  quotes INSIDE the string value): one layer of wrapping quotes is stripped,
 *  because a ref's intent is unambiguous — the ledger lookup below still
 *  guards correctness (never-seen refs still fail with UNKNOWN_REF). */
export function normalizeRef(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/^["']+/, "").replace(/["']+$/, "").trim();
  const m = /^@?(e\d+)$/.exec(s);
  return m ? `@${m[1]}` : null;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return v === undefined || v === null ? "" : String(v);
}

/** Single-quote a dynamic token for bash. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Type gate at the action boundary. The model has live-sent booleans where
 * strings are required (verify {urlIs: true}, read {url: true}) — naive
 * String() coercion turned them into the probe "true" and produced nonsense
 * answers. Fields listed here must be strings when present; booleans, numbers
 * and objects are rejected with INVALID_ARGS naming the field. fill's text is
 * the one deliberate exception: an empty string is the documented "clear the
 * field" form.
 */
function rejectNonStringFields(
  action: string,
  args: Record<string, unknown>,
  fields: string[],
  opts: { allowEmpty?: string[] } = {}
): void {
  for (const f of fields) {
    const v = args[f];
    if (v === undefined || v === null) continue;
    const allowEmpty = opts.allowEmpty?.includes(f) === true;
    if (typeof v !== "string" || (!allowEmpty && v.trim() === "")) {
      const shown = typeof v === "string" ? JSON.stringify(v) : `${typeof v} (${JSON.stringify(v)})`;
      throw new BrowserActionError(
        "INVALID_ARGS",
        `browser_control ${action}: argument "${f}" must be ${allowEmpty ? "a string" : "a non-empty string"}; got ${shown}.`,
        `${remedyFor("INVALID_ARGS")} Pass "${f}" as a JSON string value, not ${typeof v}.`
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Error classification (grounded in the CLI's real error strings)     */
/* ------------------------------------------------------------------ */

export function classifyCliFailure(text: string, timedOut?: boolean): BrowserErrorCode {
  if (timedOut) return "TIMEOUT";
  const t = text.toLowerCase();
  if (/unknown ref/.test(t)) return "UNKNOWN_REF";
  if (/timed?\s?out/.test(t)) return "TIMEOUT";
  if (/intercept|obscure|cover/.test(t)) return "CLICK_COVERED";
  if (/element not found/.test(t)) return "UNKNOWN_REF";
  return "CLI_ERROR";
}

/* Transient host/daemon failures worth ONE bounded retry: fork/resource
 * exhaustion at spawn (EAGAIN/ENOBUFS/ENFILE, the CLI's "Error executing
 * binary:" wrapper) and daemon death ("Not attached to an active page").
 * Grounded in a live capture: a post-click snapshot died with spawn EAGAIN
 * on a busy host although the click itself had succeeded — reporting a hard
 * CLI_ERROR there cascades into a false task failure. */
const TRANSIENT_PATTERNS: RegExp[] = [
  /\bEAGAIN\b/,
  /\bENOBUFS\b/,
  /\bENFILE\b/,
  /error executing binary/i,
  /not attached to an active page/i,
];

export function isTransientBrowserFailure(r: { stdout?: string; stderr?: string }): boolean {
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return TRANSIENT_PATTERNS.some((p) => p.test(text));
}

function remedyFor(code: BrowserErrorCode): string {
  switch (code) {
    case "UNKNOWN_REF":
      return "Run action=snapshot first and use a ref it actually printed. Refs are never guessable.";
    case "STALE_REF":
      return "Refs died with the last page change. Re-snapshot now and pick the current ref for the same element.";
    case "CLICK_COVERED":
      return "Something overlaps the target. Close overlays, scroll_into_view, or click_coords as a last resort.";
    case "TIMEOUT":
      return "The condition never became true within the budget. Check the URL/text you are waiting on, or verify the page state.";
    case "CLI_ERROR":
      return "The browser command itself failed. Read the message; re-snapshot if the page may have changed.";
    case "BROWSER_UNAVAILABLE":
      return "The browser session is unavailable; re-navigate before the next ref action.";
    case "INVALID_ARGS":
      return "Fix the tool arguments to match the action's schema.";
  }
}

/* ------------------------------------------------------------------ */
/* The engine                                                          */
/* ------------------------------------------------------------------ */

const MAX_TOOL_OUTPUT = 8_000;

function clip(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated, ${text.length - max} more characters]`;
}

const STALE_HINT = "refs may be stale now — action=snapshot before the next ref action.";

/** Workspace-confining path resolver (same law as tools.ts resolveWorkspacePath). */
function resolveInWorkspace(workspaceRoot: string, relPath: string): string {
  const rel = (relPath ?? "").replace(/^\.(\/|$)/, "").trim() || "";
  const abs = path.resolve(workspaceRoot, rel === "" ? "." : rel);
  const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
  if (abs !== workspaceRoot && !abs.startsWith(rootWithSep)) {
    throw new BrowserActionError("INVALID_ARGS", "Screenshot path must stay inside the workspace directory.", "Use a workspace-relative path like 'shots/after.png'.");
  }
  return abs;
}

export function createBrowserTool(deps: BrowserToolDeps) {
  const { runCli, workspaceRoot } = deps;
  const retryBackoffMs = Math.max(deps.retryBackoffMs ?? 2_000, 0);
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

  /** Last-known ref set per session (from our most recent snapshot). */
  const refLedger = new Map<string, Set<string>>();

  function ledgerFor(session: string): Set<string> {
    let s = refLedger.get(session);
    if (!s) {
      s = new Set<string>();
      refLedger.set(session, s);
    }
    return s;
  }

  function rememberRefsFromSnapshot(session: string, snapshotText: string): Set<string> {
    const set = ledgerFor(session);
    set.clear();
    for (const m of snapshotText.matchAll(/\bref=(e\d+)\b/g)) set.add(m[1]);
    return set;
  }

  /** Extract the CLI's own error text (JSON error field, else combined output). */
  function rawErrorOf(r: CliOutcome): string {
    const combined = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
    const parsed = safeJson(r.stdout);
    return (parsed && typeof parsed.error === "string" && parsed.error) || combined || `exit code ${r.exitCode}`;
  }

  /** One CLI call; JSON-mode parse with a defensive text fallback. A transient
   *  host/daemon failure (spawn EAGAIN/ENOBUFS/ENFILE, dead daemon) gets ONE
   *  bounded recovery: ~2s backoff, then a single retry. A second failure is
   *  surfaced as BROWSER_UNAVAILABLE — never as a misleading CLI_ERROR. */
  async function call(
    session: string,
    subcommand: string,
    opts: { timeoutMs?: number; json?: boolean } = {}
  ): Promise<{ ok: boolean; data: Record<string, unknown> | null; text: string; rawError: string; timedOut: boolean; unavailable?: boolean }> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const command = opts.json === false ? subcommand : `${subcommand} --json`;
    let r = await runCli({ session, subcommand: command, timeoutMs });
    if (!r.ok && isTransientBrowserFailure(r)) {
      await sleep(retryBackoffMs);
      r = await runCli({ session, subcommand: command, timeoutMs });
      if (!r.ok) {
        return { ok: false, data: null, text: "", rawError: rawErrorOf(r), timedOut: !!r.timedOut, unavailable: true };
      }
    }
    const combined = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
    if (r.ok) {
      const parsed = safeJson(r.stdout);
      if (parsed && parsed.success === true) {
        return { ok: true, data: (parsed.data ?? {}) as Record<string, unknown>, text: clip(typeof parsed.data === "object" && parsed.data !== null && "output" in (parsed.data as object) ? String((parsed.data as Record<string, unknown>).output) : combined), rawError: "", timedOut: false };
      }
      // success exit but non-JSON payload (defensive): treat text as the payload
      return { ok: true, data: null, text: clip(r.stdout.trim() || combined), rawError: "", timedOut: false };
    }
    return { ok: false, data: null, text: "", rawError: rawErrorOf(r), timedOut: !!r.timedOut };
  }

  function safeJson(s: string): { success?: boolean; data?: unknown; error?: unknown } | null {
    const t = s.trim();
    if (!t.startsWith("{")) return null;
    try {
      return JSON.parse(t);
    } catch {
      // multi-line stdout: try the first JSON-looking line
      const line = t.split("\n").find((l) => l.trim().startsWith("{") && l.trim().endsWith("}"));
      if (!line) return null;
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }
  }

  function failFrom(session: string, action: string, r: { rawError: string; timedOut: boolean; unavailable?: boolean }): BrowserActionError {
    if (r.unavailable) {
      return new BrowserActionError(
        "BROWSER_UNAVAILABLE",
        `browser_control ${action} failed: browser unavailable after one retry: ${clip(r.rawError, 400)}`,
        remedyFor("BROWSER_UNAVAILABLE")
      );
    }
    const code = classifyCliFailure(r.rawError, r.timedOut);
    return new BrowserActionError(code, `browser_control ${action} failed: ${clip(r.rawError, 600)}`, remedyFor(code));
  }

  /* ---------------- the perception primitive ---------------- */

  async function doSnapshot(session: string, args: Record<string, unknown>): Promise<string> {
    const interactive = args.interactive !== false;
    const compact = args.compact !== false;
    const flags = `${interactive ? " -i" : ""}${compact ? " -c" : ""}`;
    const r = await call(session, `snapshot${flags}`, { timeoutMs: 30_000, json: false });
    if (!r.ok) throw failFrom(session, "snapshot", r);
    const text = r.text.trim() || "(empty page)";
    rememberRefsFromSnapshot(session, r.text);
    return clip(text);
  }

  /* ---------------- stale-ref law + bounded recovery ---------------- */

  async function withRefRecovery(
    session: string,
    action: string,
    ref: string,
    attempt: () => Promise<{ ok: boolean; rawError: string; timedOut: boolean }>
  ): Promise<string> {
    const first = await attempt();
    if (first.ok) return "";

    const code = classifyCliFailure(first.rawError, first.timedOut);
    if (code !== "UNKNOWN_REF") throw failFrom(session, action, first);

    const bare = ref.replace(/^@/, "");
    if (!ledgerFor(session).has(bare)) {
      // never seen in any snapshot of this session — fail FAST, no recovery
      throw new BrowserActionError(
        "UNKNOWN_REF",
        `browser_control ${action} failed: Unknown ref: ${bare}. That ref was never in any snapshot you took.`,
        remedyFor("UNKNOWN_REF")
      );
    }

    // STALE_REF path: exactly ONE bounded recovery — re-snapshot, retry once
    const fresh = await doSnapshot(session, {});
    const second = await attempt();
    if (second.ok) {
      return "[recovered: ref was stale; re-snapshotted and retried once]\n";
    }
    throw new BrowserActionError(
      "STALE_REF",
      `browser_control ${action} failed again after one re-snapshot retry: ${clip(second.rawError, 400)}`,
      `${remedyFor("STALE_REF")} The element is likely gone from the page. Current snapshot follows.`,
      clip(fresh, 3_500)
    );
  }

  /** ref-targeted interaction (click/fill/type/select/hover/scroll_into_view). */
  async function refAction(session: string, action: string, args: Record<string, unknown>, build: (ref: string) => string, timeoutMs = 20_000): Promise<string> {
    const ref = normalizeRef(args.ref);
    if (!ref) {
      throw new BrowserActionError("INVALID_ARGS", `browser_control ${action} requires a ref from the latest snapshot (e.g. "@e5"); got "${str(args, "ref")}".`, remedyFor("UNKNOWN_REF"));
    }
    const recovered = await withRefRecovery(session, action, ref, async () => call(session, build(ref), { timeoutMs }));
    return `${recovered}${actionLabel(action, ref)}\n${STALE_HINT}`;
  }

  function actionLabel(action: string, ref: string): string {
    const verbs: Record<string, string> = {
      click: `Clicked ${ref}`,
      fill: `Filled ${ref}`,
      type: `Typed into ${ref}`,
      select: `Selected option on ${ref}`,
      hover: `Hovered ${ref}`,
      scroll_into_view: `Scrolled ${ref} into view`,
    };
    return verbs[action] ?? `${action} ${ref}`;
  }

  /* ---------------- actions ---------------- */

  async function browserAction(args: Record<string, unknown>, session: string): Promise<string> {
    const action = str(args, "action").toLowerCase();
    switch (action) {
      case "navigate": {
        rejectNonStringFields("navigate", args, ["url"]);
        const url = str(args, "url").trim();
        if (!/^https?:\/\//i.test(url)) {
          throw new BrowserActionError("INVALID_ARGS", "browser_control navigate requires an http(s) url.", "Pass url like 'https://example.com'.");
        }
        const r = await call(session, `open ${q(url)}`, { timeoutMs: 45_000 });
        if (!r.ok) throw failFrom(session, "navigate", r);
        const w = await call(session, "wait --load domcontentloaded --timeout 15000", { timeoutMs: 20_000 });
        if (!w.ok) throw failFrom(session, "navigate/wait", w); // failed postcondition is never a silent ok
        ledgerFor(session).clear(); // any navigation invalidates every ref
        return `Navigated to ${url}.\n${STALE_HINT}`;
      }

      case "snapshot":
        return doSnapshot(session, args);

      case "click":
        return refAction(session, "click", args, (ref) => `click ${q(ref)}`);

      case "click_coords": {
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 100_000 || y > 100_000) {
          throw new BrowserActionError("INVALID_ARGS", "browser_control click_coords requires integer viewport coordinates x and y.", remedyFor("INVALID_ARGS"));
        }
        const a = await call(session, `mouse move ${x} ${y}`, { timeoutMs: 10_000 });
        if (!a.ok) throw failFrom(session, "click_coords", a);
        const b = await call(session, "mouse down", { timeoutMs: 10_000 });
        if (!b.ok) throw failFrom(session, "click_coords", b);
        const c = await call(session, "mouse up", { timeoutMs: 10_000 });
        if (!c.ok) throw failFrom(session, "click_coords", c);
        return `Clicked at (${x}, ${y}) via mouse move/down/up. Blind coordinate clicks are a last resort — prefer refs.\n${STALE_HINT}`;
      }

      case "fill": {
        // text:"" is the documented "clear the field" form — type-checked but allowed empty
        rejectNonStringFields("fill", args, ["text"], { allowEmpty: ["text"] });
        const text = str(args, "text");
        if (str(args, "text").length === 0 && args.text !== "") {
          throw new BrowserActionError("INVALID_ARGS", "browser_control fill requires text.", remedyFor("INVALID_ARGS"));
        }
        const ref = normalizeRef(args.ref);
        if (!ref) {
          throw new BrowserActionError("INVALID_ARGS", `browser_control fill requires a ref from the latest snapshot; got "${str(args, "ref")}".`, remedyFor("UNKNOWN_REF"));
        }
        // fill = clear + fill; on failure: ONE fallback — focus + keyboard inserttext
        let recovered = "";
        let fillError: unknown = null;
        try {
          recovered = await withRefRecovery(session, "fill", ref, async () => call(session, `fill ${q(ref)} ${q(text)}`, { timeoutMs: 20_000 }));
        } catch (e) {
          fillError = e; // execution failure (incl. exhausted stale recovery) — fall through to the inserttext rung
        }
        if (fillError === null) {
          // the fill itself succeeded (plain or after stale recovery) — done, no fallback rung
          return `${recovered}Filled ${ref}.\n${STALE_HINT}`;
        }
        // component rejected the fill (non-stale failure): bounded inserttext fallback
        const f = await call(session, `focus ${q(ref)}`, { timeoutMs: 15_000 });
        if (!f.ok) {
          // both rungs failed: report the ROOT CAUSE (the original fill error)
          if (fillError instanceof BrowserActionError) throw fillError;
          throw failFrom(session, "fill/focus", f);
        }
        const i = await call(session, `keyboard inserttext ${q(text)}`, { timeoutMs: 15_000 });
        if (!i.ok) {
          if (fillError instanceof BrowserActionError) throw fillError;
          throw failFrom(session, "fill/inserttext", i);
        }
        return `[recovered: fill was rejected; focused ${ref} and inserted the text]\nFilled ${ref} via focus + keyboard inserttext.\n${STALE_HINT}`;
      }

      case "type": {
        rejectNonStringFields("type", args, ["text"]);
        return refAction(session, "type", args, (ref) => `type ${q(ref)} ${q(str(args, "text"))}`);
      }

      case "press": {
        const key = str(args, "key").trim();
        if (!/^[A-Za-z0-9+_-]+$/.test(key)) {
          throw new BrowserActionError("INVALID_ARGS", `browser_control press requires a key name like Enter, Tab, Control+a; got "${key}".`, remedyFor("INVALID_ARGS"));
        }
        const r = await call(session, `press ${q(key)}`, { timeoutMs: 15_000 });
        if (!r.ok) throw failFrom(session, "press", r);
        return `Pressed ${key}.\n${STALE_HINT}`;
      }

      case "select": {
        const value = str(args, "value");
        if (!value) throw new BrowserActionError("INVALID_ARGS", "browser_control select requires value (the option value to select).", remedyFor("INVALID_ARGS"));
        return refAction(session, "select", args, (ref) => `select ${q(ref)} ${q(value)}`);
      }

      case "hover":
        return refAction(session, "hover", args, (ref) => `hover ${q(ref)}`);

      case "scroll": {
        const dir = (str(args, "direction") || "down").toLowerCase();
        if (!["up", "down", "left", "right"].includes(dir)) {
          throw new BrowserActionError("INVALID_ARGS", `browser_control scroll direction must be up|down|left|right; got "${dir}".`, remedyFor("INVALID_ARGS"));
        }
        const px = args.px === undefined || args.px === null || args.px === "" ? "" : ` ${Number(args.px)}`;
        if (px && (!Number.isInteger(Number(args.px)) || Number(args.px) <= 0 || Number(args.px) > 20_000)) {
          throw new BrowserActionError("INVALID_ARGS", "browser_control scroll px must be a positive integer (<= 20000).", remedyFor("INVALID_ARGS"));
        }
        const r = await call(session, `scroll ${dir}${px}`, { timeoutMs: 15_000 });
        if (!r.ok) throw failFrom(session, "scroll", r);
        return `Scrolled ${dir}${px ? ` by ${String(args.px)}px` : ""}.\n${STALE_HINT}`;
      }

      case "scroll_into_view":
        return refAction(session, "scroll_into_view", args, (ref) => `scrollintoview ${q(ref)}`);

      case "wait": {
        rejectNonStringFields("wait", args, ["text", "url", "element"]);
        const text = str(args, "text");
        const url = str(args, "url");
        const element = str(args, "element");
        const given = [text && "text", url && "url", element && "element"].filter(Boolean);
        if (given.length !== 1) {
          throw new BrowserActionError("INVALID_ARGS", "browser_control wait requires exactly ONE condition: text, url (glob), or element.", remedyFor("INVALID_ARGS"));
        }
        const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 25_000) || 25_000, 1_000), 60_000);
        let sub: string;
        if (text) sub = `wait --text ${q(text)}`;
        else if (url) sub = `wait --url ${q(url)}`;
        else sub = `wait ${q(normalizeRef(element) ?? element)}`;
        const r = await call(session, `${sub} --timeout ${timeoutMs}`, { timeoutMs: timeoutMs + 8_000 });
        if (!r.ok) throw failFrom(session, "wait", r);
        return `Condition met (${given[0]}: ${clip(text || url || element, 120)}).`;
      }

      case "read": {
        // booleans/numbers here previously coerced to the string "true" and
        // produced a nonsense probe (url:true) or were silently ignored (ref:true)
        rejectNonStringFields("read", args, ["ref", "url"]);
        const ref = normalizeRef(args.ref);
        const url = str(args, "url").trim();
        if (ref && url) throw new BrowserActionError("INVALID_ARGS", "browser_control read takes either ref or url, not both.", remedyFor("INVALID_ARGS"));
        if (ref) {
          const r = await call(session, `get text ${q(ref)}`, { timeoutMs: 20_000, json: false });
          if (!r.ok) throw failFrom(session, "read", r);
          return `Text of ${ref}:\n${clip(r.text.trim() || "(empty)")}`;
        }
        if (url) {
          if (!/^https?:\/\//i.test(url)) throw new BrowserActionError("INVALID_ARGS", "browser_control read url must be http(s).", remedyFor("INVALID_ARGS"));
          const r = await call(session, `read ${q(url)}`, { timeoutMs: 30_000, json: false });
          if (!r.ok) throw failFrom(session, "read", r);
          return clip(r.text.trim() || "(empty page)");
        }
        const r = await call(session, "read", { timeoutMs: 30_000, json: false });
        if (!r.ok) throw failFrom(session, "read", r);
        return clip(r.text.trim() || "(empty page)");
      }

      case "verify": {
        // live bug: verify {urlIs: true} coerced to the string "true" and probed nonsense
        rejectNonStringFields("verify", args, ["visible", "enabled", "textContains", "urlIs"]);
        const visible = str(args, "visible");
        const enabled = str(args, "enabled");
        const textContains = str(args, "textContains");
        const urlIs = str(args, "urlIs");
        const probes = [visible && "visible", enabled && "enabled", textContains && "textContains", urlIs && "urlIs"].filter(Boolean);
        if (probes.length === 0) {
          throw new BrowserActionError("INVALID_ARGS", "browser_control verify requires at least one probe: visible, enabled, textContains, urlIs.", remedyFor("INVALID_ARGS"));
        }
        const lines: string[] = [];
        const isProbe = async (kind: "visible" | "enabled", selector: string): Promise<boolean> => {
          const sel = normalizeRef(selector) ?? selector;
          const r = await call(session, `is ${kind} ${q(sel)}`, { timeoutMs: 15_000 });
          if (r.ok) return r.data?.[kind] === true;
          // a missing element is a negative ANSWER for a probe, not a tool failure
          if (/element not found/i.test(r.rawError)) return false;
          throw failFrom(session, `verify ${kind}`, r);
        };
        if (visible) lines.push(`visible ${normalizeRef(visible) ?? visible}: ${await isProbe("visible", visible)}`);
        if (enabled) lines.push(`enabled ${normalizeRef(enabled) ?? enabled}: ${await isProbe("enabled", enabled)}`);
        if (textContains) {
          const r = await call(session, "read", { timeoutMs: 30_000, json: false });
          if (!r.ok) throw failFrom(session, "verify textContains", r);
          const hit = r.text.toLowerCase().includes(textContains.toLowerCase());
          lines.push(`textContains ${JSON.stringify(textContains)}: ${hit}`);
        }
        if (urlIs) {
          const r = await call(session, "get url", { timeoutMs: 10_000, json: false });
          if (!r.ok) throw failFrom(session, "verify urlIs", r);
          const current = r.text.trim();
          lines.push(`urlIs ${JSON.stringify(urlIs)}: ${current === urlIs} (current url: ${current})`);
        }
        return lines.join("\n");
      }

      case "screenshot": {
        const rawPath = str(args, "path").trim() || `.browser/snap-${Date.now()}.png`;
        const abs = resolveInWorkspace(workspaceRoot, rawPath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        const r = await call(session, `screenshot ${q(abs)}`, { timeoutMs: 30_000 });
        if (!r.ok) throw failFrom(session, "screenshot", r);
        const saved = typeof r.data?.path === "string" && r.data.path ? r.data.path : abs;
        return `Screenshot saved to ${path.relative(workspaceRoot, saved) || path.basename(saved)} (under workspace/).`;
      }

      case "dialog": {
        const mode = str(args, "mode").toLowerCase();
        if (!["accept", "dismiss", "status"].includes(mode)) {
          throw new BrowserActionError("INVALID_ARGS", "browser_control dialog mode must be accept|dismiss|status.", remedyFor("INVALID_ARGS"));
        }
        const promptText = str(args, "text");
        const sub = mode === "accept" ? `dialog accept${promptText ? ` ${q(promptText)}` : ""}` : `dialog ${mode}`;
        const r = await call(session, sub, { timeoutMs: 15_000 });
        if (!r.ok) throw failFrom(session, "dialog", r);
        if (mode === "status") return `Dialog status: ${r.data && "hasDialog" in r.data ? (r.data.hasDialog ? "a dialog is open" : "no dialog open") : clip(r.text, 200)}`;
        return `Dialog ${mode === "accept" ? "accepted" : "dismissed"}${promptText ? ` with text ${JSON.stringify(promptText)}` : ""}.\n${STALE_HINT}`;
      }

      default:
        throw new BrowserActionError(
          "INVALID_ARGS",
          `Unknown browser action "${action}".`,
          "Use one of: navigate, snapshot, click, click_coords, fill, type, press, select, hover, scroll, scroll_into_view, wait, read, verify, screenshot, dialog."
        );
    }
  }

  /** Entry point used by executeTool. Never throws raw CLI text: every failure
   *  is a BrowserActionError whose message is one compact JSON error line. */
  async function handle(args: Record<string, unknown>, session: string): Promise<string> {
    if (!args || typeof args !== "object" || !str(args, "action").trim()) {
      throw new BrowserActionError("INVALID_ARGS", "browser_control requires an action.", "Set action to one of: navigate, snapshot, click, click_coords, fill, type, press, select, hover, scroll, scroll_into_view, wait, read, verify, screenshot, dialog.");
    }
    try {
      return await browserAction(args, session);
    } catch (err) {
      if (err instanceof BrowserActionError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new BrowserActionError("CLI_ERROR", `browser_control failed: ${clip(message, 600)}`, remedyFor("CLI_ERROR"));
    }
  }

  /** Test/inspection seam: the ledger of the last snapshot per session. */
  function lastRefs(session: string): string[] {
    return [...ledgerFor(session)];
  }

  return { handle, lastRefs };
}

/* ------------------------------------------------------------------ */
/* Production runner                                                   */
/* ------------------------------------------------------------------ */

/** Real CLI runner: agent-browser is a daemon-backed CLI; the exit code is
 *  the truth. Nonzero exit => ok:false with stdout+stderr preserved. Spawn-
 *  class failures (EAGAIN/ENOBUFS/ENFILE arrive as STRING errnos on the error
 *  object, not exit codes) can die before the CLI prints anything — the errno
 *  signature is preserved into stderr so the engine's transient detector sees
 *  it and the bounded retry can run. */
export const realCliRunner: CliRunner = ({ session, subcommand, timeoutMs }) =>
  new Promise((resolve) => {
    exec(`agent-browser --session ${q(session)} ${subcommand}`, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: "/bin/bash" }, (err, stdout, stderr) => {
      if (err) {
        const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
        const rawCode: unknown = (err as { code?: unknown }).code;
        const code = typeof rawCode === "number" ? rawCode : 1;
        let stderrText = stderr.toString();
        const errno = typeof rawCode === "string" ? rawCode : null;
        if (errno && !stderrText.includes(errno)) {
          stderrText = [stderrText, `spawn ${err.message || errno}`].filter(Boolean).join("\n");
        }
        resolve({ ok: false, exitCode: code, stdout: stdout.toString(), stderr: stderrText, timedOut });
        return;
      }
      resolve({ ok: true, exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString(), timedOut: false });
    });
  });
