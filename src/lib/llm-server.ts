import ZAI from "z-ai-web-dev-sdk";
import { db } from "@/lib/db";

export interface ServerLLMMessage {
  role: "user" | "assistant" | "system";
  content: unknown; // string OR OpenAI content-part array
}

export interface ProviderInfo {
  custom: boolean;
  endpoint: string;
  apiKey: string;
  model: string;
}

/** Reads provider settings from the DB (API key stays server-side). */
export async function getProviderSettings(): Promise<ProviderInfo> {
  const s = await db.settings.findUnique({ where: { id: "singleton" } });
  const endpoint = (s?.endpoint ?? "").trim();
  const apiKey = (s?.apiKey ?? "").trim();
  const model = (s?.model ?? "").trim();
  return { custom: !!(endpoint && apiKey), endpoint, apiKey, model };
}

/** Normalizes a base URL into a chat-completions endpoint. */
export function completionsUrl(endpoint: string): string {
  const e = endpoint.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(e)) return e;
  return `${e}/chat/completions`;
}

/** Flattens OpenAI content parts to plain text (for the built-in text-only fallback). */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: Record<string, unknown>) => {
        if (p?.type === "text" && typeof p.text === "string") return p.text;
        if (p?.type === "image_url") return "[a live screenshot was captured but the built-in provider is text-only]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Built-in fallback provider — a real LLM behind z-ai-web-dev-sdk (server-side only).
 * Used when no custom OpenAI-compatible provider is configured.
 */
export async function fallbackComplete(system: string, messages: ServerLLMMessage[]): Promise<string> {
  const zai = await ZAI.create();
  const msgs: Array<{ role: string; content: string }> = [{ role: "assistant", content: system }];
  for (const m of messages) {
    if (m.role === "system") continue;
    msgs.push({ role: m.role, content: contentToText(m.content) });
  }
  const completion = await zai.chat.completions.create({
    messages: msgs as never,
    thinking: { type: "disabled" },
  });
  return completion.choices[0]?.message?.content ?? "";
}

/** Extracts the first JSON object from an LLM reply (handles ``` fences and prose). */
export function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Non-streaming completion against the configured custom provider. */
export async function customComplete(
  info: ProviderInfo,
  system: string,
  messages: ServerLLMMessage[]
): Promise<string> {
  const res = await fetch(completionsUrl(info.endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${info.apiKey}`,
    },
    body: JSON.stringify({
      model: info.model || "gpt-4o-mini",
      messages: [{ role: "system", content: system }, ...messages],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Provider error ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}
