import { NextRequest, NextResponse } from "next/server";
import { executeTool } from "@/lib/tools";
import { TOOL_DEFINITIONS } from "@/lib/tool-catalog";
import { withRouteTimeout } from "@/lib/api-guard";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Direct agent-tool execution endpoint (the same executor the LLM uses).
 * POST { tool: "run_shell" | ..., args: { ... } }
 */
export async function GET() {
  return NextResponse.json({
    tools: TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description })),
  });
}

async function POST_impl(req: NextRequest) {
  let body: { tool?: unknown; args?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.tool === "string" ? body.tool : "";
  const args = (body.args && typeof body.args === "object" ? body.args : {}) as Record<string, unknown>;

  const known = TOOL_DEFINITIONS.some((t) => t.name === name);
  if (!known) {
    return NextResponse.json({ error: `Unknown tool "${name}"` }, { status: 400 });
  }

  try {
    const output = await executeTool(name, args);
    return NextResponse.json({ ok: true, tool: name, output });
  } catch (err) {
    return NextResponse.json(
      { ok: false, tool: name, error: err instanceof Error ? err.message : "tool failed" },
      { status: 500 }
    );
  }
}

/* executeTool has its own internal 30s budget + margin; the guard is the
   outer safety net so the client can never wait in silence. */
export const POST = withRouteTimeout(POST_impl, { timeoutMs: 60_000, label: "tools.exec" });
