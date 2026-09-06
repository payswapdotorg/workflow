import { NextRequest, NextResponse } from "next/server";
import {
  completionsUrl,
  customCompleteText,
  fallbackCompleteText,
  getProviderSettings,
  type ServerLLMMessage,
} from "@/lib/llm-server";
import { executeTool } from "@/lib/tools";
import { openAIToolSchema } from "@/lib/tool-catalog";

export const runtime = "nodejs";
export const maxDuration = 300;

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

const sseHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

const MAX_TOOL_ITERATIONS = 5;

export async function POST(req: NextRequest) {
  let body: { system?: unknown; messages?: unknown; enableTools?: unknown };
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

  const info = await getProviderSettings();

  /* ---------------- plain streaming (no tools): unchanged fast path ---------------- */
  if (!enableTools) {
    if (info.custom) {
      try {
        const upstream = await fetch(completionsUrl(info.endpoint), {
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
      const full = await fallbackCompleteText(system, llmMessages);
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
      let finalText = "";

      try {
        if (info.custom) {
          finalText = await runCustomToolLoop(info, system, llmMessages, emit);
        } else {
          finalText = await runJsonToolLoop(system, llmMessages, emit);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        finalText = `LLM call failed: ${message}`;
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
  emit: (data: unknown) => void
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
    const output = await executeTool(name, args);
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
  emit: (data: unknown) => void
): Promise<string> {
  const convo: CustomMsg[] = [
    { role: "system", content: system },
    ...llmMessages.map((m): CustomMsg => ({ role: m.role, content: m.content })),
  ];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const res = await fetch(completionsUrl(info.endpoint), {
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

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      /* Provider may not support function calling — fall back to the JSON protocol. */
      if (res.status === 400 || res.status === 404 || res.status === 422) {
        return runJsonToolLoop(system, llmMessages, emit);
      }
      throw new Error(`Provider error ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    const msg = data?.choices?.[0]?.message ?? {};
    const toolCalls: Array<{ id?: string; function?: { name?: string; arguments?: string } }> =
      msg.tool_calls ?? [];

    if (toolCalls.length === 0) {
      return typeof msg.content === "string" ? msg.content : "";
    }

    convo.push({ role: "assistant", content: msg.content ?? null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      const name = call.function?.name ?? "";
      const argsRaw = call.function?.arguments ?? "{}";
      const output = await execAndEmit(name, argsRaw, emit);
      convo.push({ role: "tool", tool_call_id: call.id ?? name, content: output.slice(0, 12_000) });
    }
  }
  /* iterations exhausted — ask for a final prose answer without tools */
  return customCompleteText(info, system, [
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
  emit: (data: unknown) => void
): Promise<string> {
  const info = await getProviderSettings();
  const convo = llmMessages.map((m) => ({ ...m }));

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const reply = info.custom
      ? await customCompleteText(info, system, convo)
      : await fallbackCompleteText(system, convo);

    const parsed = extractJson(reply);
    const toolName = typeof parsed?.tool === "string" ? (parsed.tool as string) : null;

    if (!toolName || !parsed) {
      /* Plain prose — check the reply doesn't merely LOOK like prose while
         containing a fenced tool call we failed to parse. */
      return reply.trim();
    }

    const output = await execAndEmit(toolName, JSON.stringify(parsed.args ?? {}), emit);
    convo.push({ role: "assistant", content: reply.trim().slice(0, 4000) });
    convo.push({
      role: "user",
      content: `[tool result] ${toolName} executed. Output:\n${output.slice(0, 8000)}\n\nContinue: call another tool the same way, or reply in plain prose when done.`,
    });
  }
  return "I reached the tool budget for this turn before finishing — here is what I completed so far. Ask me to continue if needed.";
}
