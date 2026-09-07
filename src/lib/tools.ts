import { exec } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { TOOL_DEFINITIONS, isKnownTool } from "./tool-catalog";
import { createBrowserTool, realCliRunner } from "./browser-tool";

/**
 * TeachCast agent toolset — server-side executor.
 * Mirrors the chat.z.ai agent toolset (file read/write, shell, browser
 * control, code execution) and runs it for real on the host machine,
 * rooted at a dedicated workspace directory. No mocks.
 *
 * The catalogue (pure data) lives in tool-catalog.ts so client code can
 * render tool metadata without bundling Node builtins.
 */

/** Everything the file/shell/code tools touch is rooted here. */
export const WORKSPACE_ROOT = path.join(process.cwd(), "workspace");

export { TOOL_DEFINITIONS, isKnownTool };
export type { ToolName } from "./tool-catalog";

export async function ensureWorkspace(): Promise<string> {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  return WORKSPACE_ROOT;
}

/** Resolve a user-supplied path inside the workspace; blocks absolute paths and traversal. */
export function resolveWorkspacePath(relPath: string): string {
  const rel = (relPath ?? "").replace(/^\.(\/|$)/, "").trim() || "";
  const abs = path.resolve(WORKSPACE_ROOT, rel === "" ? "." : rel);
  const rootWithSep = WORKSPACE_ROOT.endsWith(path.sep) ? WORKSPACE_ROOT : WORKSPACE_ROOT + path.sep;
  if (abs !== WORKSPACE_ROOT && !abs.startsWith(rootWithSep)) {
    throw new Error(`Path must stay inside the workspace directory (workspace/).`);
  }
  return abs;
}

const MAX_OUTPUT = 8_000;
const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 60_000;

function clip(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[output truncated, ${text.length - max} more characters]`;
}

async function runCommand(cmd: string, opts: { cwd: string; timeoutMs: number }): Promise<{ ok: boolean; exitCode: number; output: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: "/bin/bash" }, (err, stdout, stderr) => {
      const exitCode = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number" ? (err as unknown as { code: number }).code : err ? 1 : 0;
      const out = clip([stdout.toString(), stderr.toString()].filter(Boolean).join("\n--- stderr ---\n"));
      resolve({ ok: !err, exitCode, output: out || "(no output)" });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Tool implementations                                                */
/* ------------------------------------------------------------------ */

async function readFile(args: Record<string, unknown>): Promise<string> {
  await ensureWorkspace();
  const rel = String(args.path ?? "");
  const abs = resolveWorkspacePath(rel);
  const maxBytes = Math.min(Number(args.maxBytes ?? MAX_OUTPUT) || MAX_OUTPUT, 64_000);
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(abs);
    return `Directory listing of ${rel || "."}:\n${entries.join("\n")}`;
  }
  const buf = await fs.readFile(abs);
  const content = buf.subarray(0, maxBytes).toString("utf8");
  const note = buf.length > maxBytes ? `\n…[truncated at ${maxBytes} of ${buf.length} bytes]` : "";
  return `${content}${note || (content.endsWith("\n") ? "" : "\n")}[${buf.length} bytes read from ${rel}]`;
}

async function writeFile(args: Record<string, unknown>): Promise<string> {
  await ensureWorkspace();
  const rel = String(args.path ?? "");
  const abs = resolveWorkspacePath(rel);
  const content = String(args.content ?? "");
  const append = args.append === true;
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, { flag: append ? "a" : "w" });
  return `Wrote ${Buffer.byteLength(content)} bytes to ${rel}${append ? " (appended)" : ""}.`;
}

async function runShell(args: Record<string, unknown>): Promise<string> {
  await ensureWorkspace();
  const command = String(args.command ?? "").trim();
  if (!command) throw new Error("run_shell requires a command.");
  const timeoutMs = Math.min(Number(args.timeoutMs ?? DEFAULT_TIMEOUT) || DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const r = await runCommand(command, { cwd: WORKSPACE_ROOT, timeoutMs });
  return `exit code ${r.exitCode}\n${r.output}`;
}

const RUN_DIR = path.join(WORKSPACE_ROOT, ".runs");

async function runCode(args: Record<string, unknown>): Promise<string> {
  await ensureWorkspace();
  await fs.mkdir(RUN_DIR, { recursive: true });
  const language = String(args.language ?? "python").toLowerCase();
  const code = String(args.code ?? "");
  if (!code.trim()) throw new Error("run_code requires code.");
  const ext = language === "python" ? "py" : language === "node" || language === "javascript" ? "mjs" : null;
  if (!ext) throw new Error(`Unsupported language "${language}". Use python, node or javascript.`);
  const file = path.join(RUN_DIR, `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  await fs.writeFile(file, code);
  const runner = ext === "py" ? (process.env.TEACHCAST_PYTHON || "python3") : "node";
  const timeoutMs = Math.min(Number(args.timeoutMs ?? DEFAULT_TIMEOUT) || DEFAULT_TIMEOUT, MAX_TIMEOUT);
  try {
    const r = await runCommand(`"${runner}" "${file}"`, { cwd: WORKSPACE_ROOT, timeoutMs });
    return `exit code ${r.exitCode}\n${r.output}`;
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Browser control — production computer-use engine (M5)               */
/* ------------------------------------------------------------------ */

const BROWSER_SESSION = "teachcast-agent";
/** The operator console supervises this dedicated session (M4): the console
 *  LLM's browser_control acts HERE, deliberately separate from workflow
 *  replays so the operator can watch and steer it without interference. */
export const MANAGED_BROWSER_SESSION = "teachcast-managed";

/** The M5 engine (src/lib/browser-tool.ts): one action union mapped onto the
 *  real agent-browser CLI, stale-ref law, bounded recovery, structured
 *  {code,message,remedy} errors, CLI exit codes propagated. */
const browserTool = createBrowserTool({ runCli: realCliRunner, workspaceRoot: WORKSPACE_ROOT });

/** Executes an agent tool by name. Throws on invalid usage; returns real output.
 *  opts.browserSession scopes browser_control to a concrete agent-browser
 *  profile (default: the workflow/agent session "teachcast-agent"; the
 *  operator console passes MANAGED_BROWSER_SESSION so it supervises its own
 *  dedicated browser). File/shell/code tools are workspace-rooted regardless.
 *  opts.onCursor (optional) receives UI-only LLM-cursor events from
 *  browser_control so the stage overlay can animate the second cursor (M7). */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  opts?: { browserSession?: string; onCursor?: (ev: import("./browser-tool").CursorEvent) => void }
): Promise<string> {
  const browserSession = opts?.browserSession ?? BROWSER_SESSION;
  if (!isKnownTool(name)) throw new Error(`Unknown tool "${name}".`);
  switch (name) {
    case "read_file":
      return readFile(args);
    case "write_file":
      return writeFile(args);
    case "run_shell":
      return runShell(args);
    case "run_code":
      return runCode(args);
    case "browser_control":
      return browserTool.handle(args, browserSession, { onCursor: opts?.onCursor });
  }
}
