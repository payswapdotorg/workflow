import { NextRequest, NextResponse } from "next/server";
import { completeTextWithRetry, extractJson, getProviderSettings } from "@/lib/llm-server";
import { COMPILE_SYSTEM, buildCompileUserPrompt } from "@/lib/prompts";
import { withRouteTimeout } from "@/lib/api-guard";
import type { CompiledStep } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

interface IncomingEvent {
  index?: unknown;
  kind?: unknown;
  text?: unknown;
  note?: unknown;
}

async function POST_impl(req: NextRequest) {
  let body: { events?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawEvents = body.events;
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    return NextResponse.json({ error: "events must be a non-empty array" }, { status: 400 });
  }
  if (rawEvents.length > 200) {
    return NextResponse.json({ error: "Too many events (max 200)" }, { status: 400 });
  }

  const events = (rawEvents as IncomingEvent[]).map((e, i) => ({
    index: typeof e.index === "number" ? e.index : i,
    kind: e.kind === "snapshot" ? "snapshot" : "message",
    text: typeof e.text === "string" ? e.text : "",
    note: typeof e.note === "string" ? e.note : "",
  }));

  const userPrompt = buildCompileUserPrompt(events);
  const info = await getProviderSettings();

  let raw: string;
  try {
    /* M8: throttle-guarded like every other provider call — a transient 429
       defers the compile instead of surfacing a failure to the operator. */
    raw = await completeTextWithRetry(info, COMPILE_SYSTEM, [
      { role: "user", content: userPrompt },
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: `LLM compilation failed: ${message}` }, { status: 502 });
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    return NextResponse.json(
      { error: "The LLM reply could not be parsed as JSON. Try again or save the raw events instead." },
      { status: 502 }
    );
  }

  const name = typeof parsed.name === "string" ? parsed.name.trim().slice(0, 80) : "";
  const description = typeof parsed.description === "string" ? parsed.description.trim().slice(0, 200) : "";

  const validIndexes = new Set(events.map((e) => e.index));
  const seen = new Set<number>();
  const steps: CompiledStep[] = [];
  if (Array.isArray(parsed.steps)) {
    for (const s of parsed.steps as Array<{ index?: unknown; instruction?: unknown }>) {
      if (!s || typeof s.index !== "number" || typeof s.instruction !== "string") continue;
      if (!validIndexes.has(s.index) || seen.has(s.index)) continue;
      const instruction = s.instruction.trim().slice(0, 200);
      if (!instruction) continue;
      seen.add(s.index);
      steps.push({ index: s.index, instruction });
      if (steps.length >= 40) break;
    }
  }

  if (!name || steps.length === 0) {
    return NextResponse.json(
      { error: "The LLM reply was missing a name or usable steps. Try again or save the raw events instead." },
      { status: 502 }
    );
  }

  return NextResponse.json({ name, description, steps });
}

/* A real LLM compile of up to 200 events can legitimately take a while — the
   120s budget reflects that while still bounding the worst case. */
export const POST = withRouteTimeout(POST_impl, { timeoutMs: 120_000, label: "compile" });
