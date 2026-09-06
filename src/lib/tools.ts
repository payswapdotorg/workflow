import { exec } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { TOOL_DEFINITIONS, isKnownTool } from "./tool-catalog";

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
/* Browser control — drives the agent-browser CLI (a real Chromium)    */
/* ------------------------------------------------------------------ */

const BROWSER_SESSION = "teachcast-agent";

async function browserCli(subcommand: string, timeoutMs = 45_000): Promise<string> {
  const r = await runCommand(`agent-browser --session ${BROWSER_SESSION} ${subcommand} 2>&1`, {
    cwd: WORKSPACE_ROOT,
    timeoutMs,
  });
  return r.output;
}

async function browserControl(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action ?? "").toLowerCase();
  switch (action) {
    case "open": {
      const url = String(args.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("browser_control open requires an http(s) url.");
      const out = await browserCli(`open "${url}"`);
      return `Browser opened ${url}\n${clip(out, 2000)}`;
    }
    case "snapshot": {
      const out = await browserCli("snapshot --text --compact");
      return clip(out);
    }
    case "click": {
      const selector = String(args.selector ?? "").trim();
      if (!selector) throw new Error("browser_control click requires a CSS selector.");
      const out = await browserCli(`find css "${selector.replace(/"/g, '\\"')}" click`);
      return `Clicked "${selector}".\n${clip(out, 2000)}`;
    }
    case "type": {
      const selector = String(args.selector ?? "").trim();
      const text = String(args.text ?? "");
      if (!selector) throw new Error("browser_control type requires a CSS selector.");
      const out = await browserCli(`find css "${selector.replace(/"/g, '\\"')}" fill "${text.replace(/"/g, '\\"')}"`);
      return `Typed into "${selector}".\n${clip(out, 2000)}`;
    }
    case "url": {
      const out = await browserCli("get url");
      return `Current URL: ${clip(out, 500)}`;
    }
    case "close": {
      const out = await browserCli("close");
      return `Browser closed.\n${clip(out, 500)}`;
    }
    default:
      throw new Error(`Unknown browser action "${action}". Use open | snapshot | click | type | url | close.`);
  }
}

/** Executes an agent tool by name. Throws on invalid usage; returns real output. */
export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
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
      return browserControl(args);
  }
}
