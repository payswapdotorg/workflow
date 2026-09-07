/**
 * TeachCast agent toolset catalogue — the chat.z.ai agent toolset:
 *   file read/write, shell execution, browser control, code execution.
 *
 * Pure data only (client-safe): no Node builtins here. The server-side
 * executor lives in tools.ts.
 */

export type ToolName = "read_file" | "write_file" | "run_shell" | "run_code" | "browser_control";

export interface ToolArgSpec {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  parameters: ToolArgSpec;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read a text file from the workspace (or list a directory). Paths are workspace-relative; the workspace root is the current working folder for all agent actions.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file or directory path, e.g. 'report.md' or 'data'." },
        maxBytes: { type: "number", description: "Optional maximum bytes to return (default 8000)." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite (or append to) a text file in the workspace. Parent directories are created automatically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        content: { type: "string", description: "The full content to write." },
        append: { type: "boolean", description: "Append instead of overwrite (default false)." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_shell",
    description:
      "Execute a shell command (bash) on the computer, in the workspace directory. Use for system actions: moving files, listing processes, git, curl, etc. Returns the exit code and combined stdout/stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run." },
        timeoutMs: { type: "number", description: "Optional timeout in ms (default 30000, max 60000)." },
      },
      required: ["command"],
    },
  },
  {
    name: "run_code",
    description:
      "Execute a Python or Node.js script on the computer and return its stdout/stderr and exit code. Scripts run with the workspace as the current directory.",
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", description: "'python', 'node' or 'javascript'." },
        code: { type: "string", description: "The full script source code to execute." },
        timeoutMs: { type: "number", description: "Optional timeout in ms (default 30000, max 60000)." },
      },
      required: ["language", "code"],
    },
  },
  {
    name: "browser_control",
    description:
      "Control a real web browser on the computer. Actions: 'open' (url), 'snapshot' (read the current page as text), 'click' (CSS selector), 'type' (CSS selector + text), 'url' (current URL), 'close'. Use snapshot to see a page, then click/type to interact.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: open, snapshot, click, type, url, close." },
        url: { type: "string", description: "For action=open: the http(s) URL to open." },
        selector: { type: "string", description: "For action=click/type: a CSS selector for the target element." },
        text: { type: "string", description: "For action=type: the text to fill in." },
      },
      required: ["action"],
    },
  },
];

/** OpenAI function-calling schema for the custom provider path. */
export function openAIToolSchema() {
  return TOOL_DEFINITIONS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Compact textual tool catalogue for the JSON-protocol (built-in fallback) path. */
export function toolCatalogText(): string {
  return TOOL_DEFINITIONS.map((t) => {
    const params = Object.entries(t.parameters.properties)
      .map(([k, v]) => `${k}${t.parameters.required.includes(k) ? "" : "?"}: ${(v as { type?: string })?.type ?? "any"}`)
      .join(", ");
    return `- ${t.name}(${params}): ${t.description}`;
  }).join("\n");
}

/** Human-facing workspace description (client-safe; relative paths are enforced server-side). */
export function workspaceInfoText(): string {
  return "the dedicated `workspace/` directory next to the app";
}

export function isKnownTool(name: string): name is ToolName {
  return TOOL_DEFINITIONS.some((t) => t.name === name);
}
