import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { withRouteTimeout } from "@/lib/api-guard";
import { executeTool, MANAGED_BROWSER_SESSION } from "@/lib/tools";
import { extractJson, customCompleteText, fallbackCompleteText, getProviderSettings } from "@/lib/llm-server";
import { RERESOLVE_SYSTEM } from "@/lib/prompts";
import type { ServerLLMMessage } from "@/lib/llm-server";
import type { CursorEvent } from "@/lib/browser-tool";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * M7 EXECUTION MODE — a taught workflow runs on the DEDICATED managed browser
 * while the operator watches the LLM cursor move on the stage mirror.
 *
 * NOT wrapped in withRouteTimeout(): this route streams SSE (same reasoning as
 * /api/chat — the response is already flowing while work happens; bounded by
 * its own budget + keepalive instead).
 *
 * The M5 stale-ref law applied to pixels: captured (x,y) are HINTS from the
 * demonstration. Before every step the executor takes a FRESH observation of
 * the managed page (a11y snapshot + screenshot) and the LLM re-resolves the
 * target against it — by ref from that snapshot wherever possible. Captured
 * coordinates are never replayed blindly.
 *
 * Wire protocol (SSE):
 *   {exec:{type:"run", workflowId, name, total, surface}}
 *   {exec:{type:"step", index, total, label, status:"running"}}
 *   {tool:...} {tool_result:...}       — same tool activity shape as /api/chat
 *   {cursor:{...}}                     — UI-only LLM-cursor events (real geometry)
 *   {exec:{type:"step", index, status:"done"|"skipped"|"failed", detail?}}
 *   {exec:{type:"done", ok, ran, skipped, failed}}
 *   data: [DONE]
 */

const MAX_STEPS = 80;
/** Hard wall-clock budget for the whole run (kept under maxDuration). */
const RUN_BUDGET_MS = 270_000;
const MAX_SNAPSHOT_CHARS = 20_000;
const FRAME_DIR = path.join(process.cwd(), "workspace", ".managed");

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

const sseHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

function cli(args: string[], timeoutMs = 45_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "agent-browser",
      ["--session", MANAGED_BROWSER_SESSION, ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = [stdout?.toString() ?? "", stderr?.toString() ?? ""]
          .filter(Boolean)
          .join("\n")
          .trim()
          .slice(0, MAX_SNAPSHOT_CHARS);
        resolve({ ok: !err, output: out || (err ? String((err as Error).message ?? err) : "") });
      }
    );
  });
}

/** Real PNG frame of the managed page as a data URL (null when unavailable). */
async function captureFrame(): Promise<string | null> {
  await fs.mkdir(FRAME_DIR, { recursive: true });
  const file = path.join(FRAME_DIR, `exec-${Date.now()}.png`);
  try {
    const shot = await cli(["screenshot", file], 30_000);
    if (!shot.ok) return null;
    const buf = await fs.readFile(file);
    if (buf.length === 0) return null;
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

/** Fresh observation of the managed page — the ground every step re-resolves against. */
async function observe(): Promise<{ snapshotText: string | null; frame: string | null; url: string | null }> {
  const [text, frame, url] = await Promise.all([
    cli(["snapshot", "--text", "--compact"], 45_000),
    captureFrame(),
    cli(["get", "url"], 15_000),
  ]);
  return {
    snapshotText: text.ok && text.output ? text.output : null,
    frame,
    url: url.ok && /^https?:\/\//i.test(url.output) ? url.output.split("\n")[0].trim() : null,
  };
}

interface ExpectProbe {
  textContains?: string;
  urlContains?: string;
}

interface Resolution {
  ref: string | null;
  coords: { x: number; y: number } | null;
  expect: ExpectProbe | null;
  skip: string | null;
}

/** One LLM call re-grounding a taught step against the CURRENT page. */
async function reResolve(
  step: {
    label: string;
    actionType: "click" | "type";
    text?: string;
    x?: number;
    y?: number;
    thumb?: string | null;
  },
  current: { snapshotText: string | null; frame: string | null }
): Promise<Resolution> {
  const parts: Record<string, unknown>[] = [];
  const captured =
    step.actionType === "click"
      ? `captured pointer position (hint only): ${Math.round((step.x ?? 0) * 100)}%, ${Math.round((step.y ?? 0) * 100)}% of the screen`
      : `captured keystrokes: ${JSON.stringify((step.text ?? "").slice(0, 200))}`;
  parts.push({
    type: "text",
    text: [
      `Taught step: ${step.label}`,
      `Action: ${step.actionType}`,
      captured,
      current.snapshotText
        ? `\nCURRENT accessibility snapshot of the page (refs are valid NOW):\n${current.snapshotText}`
        : "\nCURRENT accessibility snapshot: unavailable — rely on the screenshot.",
      current.frame
        ? "\nImages follow: the frame as it looked when the step was taught (if available), then the CURRENT screenshot."
        : "\nNo screenshot is available for the current page — rely on the accessibility snapshot and answer skip when unsure.",
      "\nAnswer with the single JSON object now.",
    ].join("\n"),
  });
  if (step.thumb) parts.push({ type: "image_url", image_url: { url: step.thumb } });
  if (current.frame) parts.push({ type: "image_url", image_url: { url: current.frame } });

  const messages: ServerLLMMessage[] = [{ role: "user", content: parts }];
  const info = await getProviderSettings();
  const reply = info.custom
    ? await customCompleteText(info, RERESOLVE_SYSTEM, messages)
    : await fallbackCompleteText(RERESOLVE_SYSTEM, messages);

  const parsed = extractJson(reply);
  if (!parsed) {
    /* an unparseable reply is a PROTOCOL violation, not an intentional skip:
       it becomes a failed step so the run never dresses garbage up as a
       graceful outcome. */
    throw new Error(`re-resolution returned no parseable JSON (protocol demands one object): ${reply.slice(0, 160)}`);
  }
  if (parsed.skip === true) {
    return {
      ref: null,
      coords: null,
      expect: null,
      skip: String(parsed.reason ?? "the LLM could not identify the target").slice(0, 300),
    };
  }
  const ref =
    typeof parsed.ref === "string" && /^@?e\d+$/i.test(parsed.ref.trim())
      ? `@${parsed.ref.trim().replace(/^@/, "")}`
      : null;
  const c = parsed.coords as Record<string, unknown> | undefined;
  const cx = c && typeof c.x === "number" && Number.isFinite(c.x) ? Math.round(c.x) : null;
  const cy = c && typeof c.y === "number" && Number.isFinite(c.y) ? Math.round(c.y) : null;
  const coords =
    cx !== null && cy !== null && cx >= 0 && cy >= 0 && cx <= 100_000 && cy <= 100_000 ? { x: cx, y: cy } : null;
  const exp = parsed.expect as Record<string, unknown> | null | undefined;
  const expect: ExpectProbe | null =
    exp && typeof exp === "object"
      ? {
          textContains:
            typeof exp.textContains === "string" && exp.textContains.trim() ? exp.textContains.trim().slice(0, 200) : undefined,
          urlContains:
            typeof exp.urlContains === "string" && exp.urlContains.trim() ? exp.urlContains.trim().slice(0, 200) : undefined,
        }
      : null;
  if (!ref && !coords) {
    throw new Error(`re-resolution produced neither a snapshot ref nor coordinates (got: ${reply.slice(0, 160)})`);
  }
  return { ref, coords, expect: expect && (expect.textContains || expect.urlContains) ? expect : null, skip: null };
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function POST(req: NextRequest) {
  let body: { workflowId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const workflowId = String(body.workflowId ?? "").trim();
  if (!workflowId) return NextResponse.json({ error: "workflowId is required" }, { status: 400 });

  const workflow = await db.workflow.findUnique({
    where: { id: workflowId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });

  const actionSteps = workflow.steps
    .filter((s) => s.kind === "action")
    .map((s) => ({ raw: s, payload: JSON.parse(s.payload) as Record<string, unknown> }));
  if (actionSteps.length === 0) {
    return NextResponse.json(
      {
        error:
          "This workflow has no executable action steps (taught clicks/keystrokes). Narration/screen workflows replay against your own screen in the Replay view instead.",
      },
      { status: 422 }
    );
  }
  if (actionSteps.length > MAX_STEPS) {
    return NextResponse.json({ error: `A run can execute at most ${MAX_STEPS} action steps` }, { status: 422 });
  }

  /* Preflight: the managed browser is the ONLY surface this route acts on. */
  const preflight = await cli(["get", "url"], 15_000);
  if (!preflight.ok || !/^https?:\/\//i.test(preflight.output)) {
    return NextResponse.json(
      { error: "The managed browser is not connected. Open it from the console panel (Connect) and retry.", code: "BROWSER_UNAVAILABLE" },
      { status: 409 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (data: unknown) => controller.enqueue(encoder.encode(sse(data)));
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          /* stream already closed */
        }
      }, 15_000);
      const deadline = Date.now() + RUN_BUDGET_MS;

      let ran = 0;
      let skipped = 0;
      let failed = 0;
      let aborted = false;

      emit({
        exec: {
          type: "run",
          workflowId: workflow.id,
          name: workflow.name,
          total: actionSteps.length,
          surface: `managed browser (${MANAGED_BROWSER_SESSION})`,
        },
      });

      const toolId = () => `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      /** executeTool with the chat-shaped tool activity + UI-only cursor events. */
      const runTool = async (args: Record<string, unknown>): Promise<string> => {
        const id = toolId();
        emit({ tool: { id, name: "browser_control", args, status: "running" } });
        const onCursor = (ev: CursorEvent) => emit({ cursor: ev });
        try {
          const output = await executeTool("browser_control", args, { browserSession: MANAGED_BROWSER_SESSION, onCursor });
          emit({ tool_result: { id, name: "browser_control", ok: true, output, status: "done" } });
          return output;
        } catch (err) {
          const message = err instanceof Error ? err.message : "browser action failed";
          emit({ tool_result: { id, name: "browser_control", ok: false, output: message, status: "done" } });
          throw err;
        }
      };

      try {
        for (let i = 0; i < actionSteps.length; i++) {
          const { payload } = actionSteps[i];
          const index = i;
          const label = String(payload.label ?? `${payload.actionType} step`).slice(0, 300);
          const actionType = payload.actionType === "type" ? "type" : "click";
          emit({ exec: { type: "step", index, total: actionSteps.length, label, status: "running" } });

          if (Date.now() > deadline) {
            failed++;
            emit({ exec: { type: "step", index, status: "failed", detail: "run budget exhausted before this step" } });
            aborted = true;
            break;
          }

          try {
            /* 1. FRESH observation — the only ground truth (M5 law on pixels) */
            const current = await observe();
            if (!current.snapshotText && !current.frame) {
              throw new Error("could not observe the managed page (snapshot and screenshot both failed)");
            }

            /* 2. vision re-resolution against the CURRENT page */
            const step = {
              label,
              actionType: actionType as "click" | "type",
              text: typeof payload.text === "string" ? payload.text : undefined,
              x: typeof payload.x === "number" ? payload.x : undefined,
              y: typeof payload.y === "number" ? payload.y : undefined,
              thumb: typeof payload.thumb === "string" ? payload.thumb : null,
            };
            const res = await reResolve(step, current);
            if (res.skip) {
              skipped++;
              emit({ exec: { type: "step", index, status: "skipped", detail: res.skip } });
              continue;
            }

            /* 3. act on the managed browser — the cursor animates from REAL geometry */
            if (actionType === "click") {
              if (res.ref) await runTool({ action: "click", ref: res.ref });
              else if (res.coords) await runTool({ action: "click_coords", x: res.coords.x, y: res.coords.y });
            } else {
              if (!res.ref) {
                throw new Error("typing requires the target field as a snapshot ref — the re-resolver returned only coordinates");
              }
              await runTool({ action: "fill", ref: res.ref, text: step.text ?? "" });
            }
            ran++;

            /* 4. postconditions — M5-grade verification; failures are real failures */
            const details: string[] = [];
            if (actionType === "type" && res.ref) {
              /* inputs have no text-node content — read the VALUE back */
              const v = await cli(["get", "value", res.ref], 15_000);
              if (!v.ok) throw new Error(`could not read back the value of ${res.ref}: ${v.output.slice(0, 160)}`);
              const want = normalizeText(step.text ?? "");
              const got = normalizeText(v.output);
              if (want && !got.includes(want.slice(0, 200))) {
                throw new Error(`typed text did not land in ${res.ref} (read back: "${v.output.slice(0, 160)}")`);
              }
              details.push(`text confirmed in ${res.ref}`);
            }
            if (res.expect?.textContains) {
              const v = await runTool({ action: "verify", textContains: res.expect.textContains });
              if (/textContains[^:]*: false/.test(v)) {
                throw new Error(`postcondition failed: page text does not contain ${JSON.stringify(res.expect.textContains)}`);
              }
              details.push(`verified text ${JSON.stringify(res.expect.textContains)}`);
            }
            if (res.expect?.urlContains) {
              const u = await cli(["get", "url"], 15_000);
              const cur = u.ok ? u.output.split("\n")[0].trim() : "";
              if (!cur.includes(res.expect.urlContains)) {
                throw new Error(`postcondition failed: URL ${cur || "(unknown)"} does not contain ${JSON.stringify(res.expect.urlContains)}`);
              }
              details.push(`verified url contains ${JSON.stringify(res.expect.urlContains)}`);
            }
            emit({ exec: { type: "step", index, status: "done", detail: details.join("; ") || undefined } });
          } catch (err) {
            failed++;
            const message = err instanceof Error ? err.message : String(err);
            emit({ exec: { type: "step", index, status: "failed", detail: message.slice(0, 400) } });
            aborted = true; /* fail fast: a wrong click can cascade into wrong states */
            break;
          }
        }

        /* steps after a fail-fast break are honestly counted as not-run */
        const notRun = actionSteps.length - ran - skipped - failed;
        if (aborted && notRun > 0) skipped += notRun;
        emit({ exec: { type: "done", ok: failed === 0 && !aborted, ran, skipped, failed } });
        /* the library's lastRunAt stays honest */
        await db.workflow.update({ where: { id: workflow.id }, data: { lastRunAt: new Date() } }).catch(() => {});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ exec: { type: "done", ok: false, ran, skipped, failed: Math.max(failed, 1), error: message.slice(0, 300) } });
      } finally {
        clearInterval(keepalive);
      }

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: sseHeaders });
}

/* Only POST exists; GET is a documented 405 (kept under the standard guard). */
export const GET = withRouteTimeout(
  async () => NextResponse.json({ error: "POST a {workflowId} to start an execution run" }, { status: 405 }),
  { timeoutMs: 5_000, label: "execute.get" }
);
