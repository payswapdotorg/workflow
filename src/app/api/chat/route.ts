import { NextRequest, NextResponse } from "next/server";
import {
  completionsUrl,
  completeTextWithRetry,
  getProviderSettings,
  type ProviderInfo,
  type ServerLLMMessage,
} from "@/lib/llm-server";
import { withThrottleBackoff } from "@/lib/llm-retry";
import { executeTool, MANAGED_BROWSER_SESSION } from "@/lib/tools";
import { openAIToolSchema, TOOL_DEFINITIONS } from "@/lib/tool-catalog";
import { withToolProtocol } from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 300;

/* Deliberately NOT wrapped in withRouteTimeout(): this route streams SSE —
   the response is already flowing while the LLM works, so a wrapper would
   only be able to "time out" before the stream starts. The stream is instead
   bounded by its own watchdogs (45s idle abort, 120s total abort in the
   client's streamChat, plus the 15s keepalive that keeps intermediaries from
   giving up). Every non-streaming JSON route IS wrapped. */

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

const sseHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

/** Which agent-browser profile browser_control acts on. Strict whitelist —
 *  "managed" scopes the console LLM to its dedicated supervised browser,
 *  everything else (and the default) stays on the workflow/agent browser. */
function resolveBrowserSession(raw: unknown): string {
  return raw === "managed" ? MANAGED_BROWSER_SESSION : "teachcast-agent";
}

/* Architect review (PR #1): 5 starved multi-step tasks — 12-16 required. */
const MAX_TOOL_ITERATIONS = 14;

export async function POST(req: NextRequest) {
  let body: { system?: unknown; messages?: unknown; enableTools?: unknown; browserTarget?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const system =
    typeof body.system === "string" && body.system.trim()
      ? body.system
      : "You are a helpful assistant.";
  const enableTools = body.enableTools === true;

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "messages must be a non-empty array" }, { status: 400 });
  }
  for (const m of messages as ServerLLMMessage[]) {
    if (
      !m ||
      (m.role !== "user" && m.role !== "assistant") ||
      m.content === null ||
      m.content === undefined
    ) {
      return NextResponse.json(
        { error: 'Each message must have role "user"|"assistant" and content' },
        { status: 400 }
      );
    }
  }
  const llmMessages = structuredClone(messages) as ServerLLMMessage[];
  const browserSession = resolveBrowserSession(body.browserTarget);

  const info = await getProviderSettings();

  /* ---------------- plain streaming (no tools): unchanged fast path ---------------- */
  if (!enableTools) {
    if (info.custom) {
      try {
        /* M8: establishment (connect + status line) runs under bounded
           throttle backoff — nothing has been streamed yet, so a retry is
           fully honest. Once the body flows, failures stay honest. */
        const upstream = await withThrottleBackoff(async () => {
          const r = await fetch(completionsUrl(info.endpoint), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${info.apiKey}`,
            },
            body: JSON.stringify({
              model: info.model || "gpt-4o-mini",
              messages: [{ role: "system", content: system }, ...llmMessages],
              stream: true,
              temperature: 0.4,
            }),
            signal: AbortSignal.timeout(180_000),
          });
          if (r.status === 429) {
            const text = await r.text().catch(() => "");
            throw new Error(`Provider error 429: ${text.slice(0, 400)}`);
          }
          return r;
        });
        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text().catch(() => "");
          return NextResponse.json(
            { error: `Provider error ${upstream.status}: ${text.slice(0, 400)}` },
            { status: 502 }
          );
        }
        return new Response(upstream.body, { headers: sseHeaders });
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        return NextResponse.json({ error: `Provider request failed: ${message}` }, { status: 502 });
      }
    }

    /* built-in fallback, no tools */
    try {
      const full = await completeTextWithRetry(info, system, llmMessages);
      if (!full) {
        return NextResponse.json({ error: "Built-in provider returned an empty response" }, { status: 502 });
      }
      return chunkedSseResponse(full);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return NextResponse.json({ error: `Built-in provider failed: ${message}` }, { status: 502 });
    }
  }

  /* ---------------- tool mode: real agent loop, tool events streamed ---------------- */
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (data: unknown) => controller.enqueue(encoder.encode(sse(data)));
      /* Keepalive comments feed the CLIENT transport idle watchdog while long
         tool executions or slow provider calls produce no visible events.
         SSE comment lines (": ping") are ignored by event parsers but keep
         bytes flowing, so a 60s tool run can never look like a dead stream. */
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          /* stream already closed */
        }
      }, 15_000);
      let finalText = "";

      try {
        /* Server-owned tool protocol (architect review blocker 2): enableTools
           ALWAYS injects the protocol server-side, whatever system the caller
           supplied — without it the model narrates fabricated results instead
           of emitting tool calls. withToolProtocol is idempotent, so blessed
           client prompts (TEACH_SYSTEM_WITH_TOOLS etc.) pass through. */
        const toolSystem = withToolProtocol(system);
        if (info.custom) {
          finalText = await runCustomToolLoop(info, toolSystem, llmMessages, emit, browserSession);
        } else {
          finalText = await runJsonToolLoop(toolSystem, llmMessages, emit, browserSession);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        finalText = `LLM call failed: ${message}`;
      } finally {
        clearInterval(keepalive);
      }

      if (finalText) {
        for (let i = 0; i < finalText.length; i += 48) {
          emit({ choices: [{ delta: { content: finalText.slice(i, i + 48) } }] });
          await new Promise((r) => setTimeout(r, 8));
        }
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: sseHeaders });
}

/** Streams an already-complete answer as SSE chunks (same wire format as before). */
function chunkedSseResponse(full: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const CHUNK = 48;
      for (let i = 0; i < full.length; i += CHUNK) {
        controller.enqueue(encoder.encode(sse({ choices: [{ delta: { content: full.slice(i, i + CHUNK) } }] })));
        await new Promise((r) => setTimeout(r, 10));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: sseHeaders });
}

function toolId(): string {
  return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function execAndEmit(
  name: string,
  rawArgs: string,
  emit: (data: unknown) => void,
  browserSession: string
): Promise<string> {
  const id = toolId();
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return `Error: tool arguments were not valid JSON: ${rawArgs.slice(0, 200)}`;
  }
  emit({ tool: { id, name, args, status: "running" } });
  try {
    const output = await executeTool(name, args, {
      browserSession,
      /* M7: browser_control resolves real element geometry and emits UI-only
         LLM-cursor events — streamed to the client, never fed to the model. */
      onCursor: (ev) => emit({ cursor: ev }),
    });
    emit({ tool_result: { id, name, ok: true, output, status: "done" } });
    return output;
  } catch (err) {
    const message = err instanceof Error ? err.message : "tool failed";
    emit({ tool_result: { id, name, ok: false, output: message, status: "done" } });
    return `Error: ${message}`;
  }
}

/* ------------------------------------------------------------------ */
/* Custom provider: native OpenAI function-calling loop                */
/* ------------------------------------------------------------------ */

type CustomMsg = Record<string, unknown>;

async function runCustomToolLoop(
  info: ProviderInfo,
  system: string,
  llmMessages: ServerLLMMessage[],
  emit: (data: unknown) => void,
  browserSession: string
): Promise<string> {
  const convo: CustomMsg[] = [
    { role: "system", content: system },
    ...llmMessages.map((m): CustomMsg => ({ role: m.role, content: m.content })),
  ];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    /* M8: each loop iteration's provider call is throttle-guarded. A 429
       defers the turn (keepalives cover the silent window) instead of
       killing a multi-step computer-use run mid-flight. */
    const res = await withThrottleBackoff(async () => {
      const r = await fetch(completionsUrl(info.endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${info.apiKey}` },
        body: JSON.stringify({
          model: info.model || "gpt-4o-mini",
          messages: convo,
          tools: openAIToolSchema(),
          temperature: 0.4,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (r.status === 429) {
        const text = await r.text().catch(() => "");
        throw new Error(`Provider error 429: ${text.slice(0, 300)}`);
      }
      return r;
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      /* Provider may not support function calling — fall back to the JSON protocol. */
      if (res.status === 400 || res.status === 404 || res.status === 422) {
        return runJsonToolLoop(system, llmMessages, emit, browserSession);
      }
      throw new Error(`Provider error ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    const msg = data?.choices?.[0]?.message ?? {};
    const toolCalls: Array<{ id?: string; function?: { name?: string; arguments?: string } }> =
      msg.tool_calls ?? [];

    if (toolCalls.length === 0) {
      const content = typeof msg.content === "string" ? msg.content : "";
      /* JSON-protocol bridge (architect review blocker 1): the provider may
         answer with a {"tool","args"} JSON body instead of native tool_calls
         — or ignore the native schema entirely and 200 with JSON content.
         The model is following the protocol: execute it and continue the
         loop instead of dropping it as final prose. Unknown tool names are
         left as prose so explanatory JSON in ordinary answers never runs. */
      const parsed = extractJson(content);
      const jsonTool =
        parsed &&
        typeof parsed.tool === "string" &&
        TOOL_DEFINITIONS.some((t) => t.name === parsed.tool)
          ? (parsed.tool as string)
          : null;
      if (jsonTool) {
        const output = await execAndEmit(jsonTool, JSON.stringify(parsed?.args ?? {}), emit, browserSession);
        convo.push({ role: "assistant", content: content.trim().slice(0, 4000) });
        convo.push({
          role: "user",
          content: `[tool result] ${jsonTool} executed. Output:\n${output.slice(0, 8000)}\n\nContinue: call another tool the same way, or reply in plain prose when done.`,
        });
        continue;
      }
      return content;
    }

    convo.push({ role: "assistant", content: msg.content ?? null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      const name = call.function?.name ?? "";
      const argsRaw = call.function?.arguments ?? "{}";
      const output = await execAndEmit(name, argsRaw, emit, browserSession);
      convo.push({ role: "tool", tool_call_id: call.id ?? name, content: output.slice(0, 12_000) });
    }
  }
  /* iterations exhausted — ask for a final prose answer without tools */
  return completeTextWithRetry(info, system, [
    ...llmMessages,
    {
      role: "user",
      content: "Tool budget reached. Summarize now in plain prose what you did and the results.",
    },
  ]);
}

/* ------------------------------------------------------------------ */
/* Built-in fallback (and non-function-calling providers):             */
/* JSON tool protocol — the model replies with {"tool": name, "args"}  */
/* ------------------------------------------------------------------ */

import { extractJson, type ProviderInfo } from "@/lib/llm-server";

async function runJsonToolLoop(
  system: string,
  llmMessages: ServerLLMMessage[],
  emit: (data: unknown) => void,
  browserSession: string
): Promise<string> {
  const info = await getProviderSettings();
  const convo = llmMessages.map((m) => ({ ...m }));

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    /* M8: same throttle guard for the JSON-protocol loop. */
    const reply = await completeTextWithRetry(info, system, convo);

    const parsed = extractJson(reply);
    const toolName = typeof parsed?.tool === "string" ? (parsed.tool as string) : null;

    if (!toolName || !parsed) {
      /* Plain prose — check the reply doesn't merely LOOK like prose while
         containing a fenced tool call we failed to parse. */
      return reply.trim();
    }

    /* Asymmetry note (architect, PR #3 review): an UNKNOWN name parsed out of
       a protocol-formatted reply is executed anyway and comes back as
       "Error: Unknown tool ..." — the model EXPLICITLY attempted a tool call
       in the agreed channel, so it must see a real error to self-correct.
       The custom-loop bridge behaves differently on purpose: there the JSON
       appeared inside ordinary prose (no protocol attempt), so unknown names
       are left as prose and never executed. */
    const output = await execAndEmit(toolName, JSON.stringify(parsed.args ?? {}), emit, browserSession);
    convo.push({ role: "assistant", content: reply.trim().slice(0, 4000) });
    convo.push({
      role: "user",
      content: `[tool result] ${toolName} executed. Output:\n${output.slice(0, 8000)}\n\nContinue: call another tool the same way, or reply in plain prose when done.`,
    });
  }
  return "I reached the tool budget for this turn before finishing — here is what I completed so far. Ask me to continue if needed.";
}
