import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withRouteTimeout } from "@/lib/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PAYLOAD_CHARS = 4_000_000; // per-step guard (screenshots are ~100-300KB base64)

interface IncomingStep {
  kind?: unknown;
  payload?: unknown;
  ts?: unknown;
}

function validateSteps(steps: unknown): { ok: true; steps: IncomingStep[] } | { ok: false; error: string } {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: "steps must be a non-empty array" };
  }
  if (steps.length > 80) return { ok: false, error: "A workflow can hold at most 80 steps" };
  for (const s of steps as IncomingStep[]) {
    if (!s || (s.kind !== "message" && s.kind !== "snapshot")) {
      return { ok: false, error: 'Each step needs kind "message" or "snapshot"' };
    }
    if (typeof s.payload !== "object" || s.payload === null) {
      return { ok: false, error: "Each step needs a payload object" };
    }
    if (JSON.stringify(s.payload).length > MAX_PAYLOAD_CHARS) {
      return { ok: false, error: "Step payload too large" };
    }
  }
  return { ok: true, steps: steps as IncomingStep[] };
}

export const GET = withRouteTimeout(
  async () => {
    const rows = await db.workflow.findMany({
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { steps: true } } },
    });
    return NextResponse.json(
      rows.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        installed: w.installed,
        autoLaunch: w.autoLaunch,
        lastRunAt: w.lastRunAt,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        stepCount: w._count.steps,
      }))
    );
  },
  { timeoutMs: 30_000, label: "workflows.list" }
);

export const POST = withRouteTimeout(
  async (req: NextRequest) => {
    let body: { name?: unknown; description?: unknown; steps?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const name = String(body.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    if (name.length > 120) return NextResponse.json({ error: "name is too long (max 120)" }, { status: 400 });
    const description = String(body.description ?? "").trim().slice(0, 600);

    const check = validateSteps(body.steps);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

    const created = await db.workflow.create({
      data: {
        name,
        description,
        steps: {
          create: check.steps.map((s, i) => ({
            kind: s.kind as string,
            payload: JSON.stringify(s.payload ?? {}),
            ts: s.ts ? new Date(s.ts as string) : new Date(),
            order: i,
          })),
        },
      },
      include: { steps: { orderBy: { order: "asc" } } },
    });

    return NextResponse.json(
      {
        id: created.id,
        name: created.name,
        description: created.description,
        installed: created.installed,
        autoLaunch: created.autoLaunch,
        lastRunAt: created.lastRunAt,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        steps: created.steps.map((s) => ({
          id: s.id,
          kind: s.kind,
          payload: JSON.parse(s.payload),
          ts: s.ts,
          order: s.order,
        })),
      },
      { status: 201 }
    );
  },
  { timeoutMs: 30_000, label: "workflows.create" }
);
