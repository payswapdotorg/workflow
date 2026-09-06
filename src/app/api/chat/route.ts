import { NextRequest, NextResponse } from "next/server";
import { completionsUrl, fallbackComplete, getProviderSettings, type ServerLLMMessage } from "@/lib/llm-server";

export const runtime = "nodejs";
export const maxDuration = 300;

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  let body: { system?: unknown; messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const system =
    typeof body.system === "string" && body.system.trim()
      ? body.system
      : "You are a helpful assistant.";

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
  const llmMessages = messages as ServerLLMMessage[];

  const info = await getProviderSettings();
  const sseHeaders = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };

  /* ---- Custom OpenAI-compatible provider: stream straight through ---- */
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

  /* ---- Built-in fallback: real LLM (server-side SDK), delivered as SSE ---- */
  try {
    const full = await fallbackComplete(system, llmMessages);
    if (!full) {
      return NextResponse.json({ error: "Built-in provider returned an empty response" }, { status: 502 });
    }
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: `Built-in provider failed: ${message}` }, { status: 502 });
  }
}
