import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withRouteTimeout } from "@/lib/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withRouteTimeout(
  async (_req: NextRequest, ctx: Ctx) => {
    const { id } = await ctx.params;
    const w = await db.workflow.findUnique({ where: { id }, include: { steps: { orderBy: { order: "asc" } } } });
    if (!w) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    return NextResponse.json({
      id: w.id,
      name: w.name,
      description: w.description,
      installed: w.installed,
      autoLaunch: w.autoLaunch,
      lastRunAt: w.lastRunAt,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      steps: w.steps.map((s) => ({
        id: s.id,
        kind: s.kind,
        payload: JSON.parse(s.payload),
        ts: s.ts,
        order: s.order,
      })),
    });
  },
  { timeoutMs: 30_000, label: "workflows.get" }
);

export const PATCH = withRouteTimeout(
  async (req: NextRequest, ctx: Ctx) => {
    const { id } = await ctx.params;
    let body: { installed?: unknown; markRun?: unknown; name?: unknown; description?: unknown; autoLaunch?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const data: { installed?: boolean; lastRunAt?: Date; name?: string; description?: string; autoLaunch?: boolean } = {};
    if (typeof body.installed === "boolean") data.installed = body.installed;
    if (body.markRun === true) data.lastRunAt = new Date();
    if (typeof body.autoLaunch === "boolean") data.autoLaunch = body.autoLaunch;
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
      data.name = name.slice(0, 120);
    }
    if (body.description !== undefined) data.description = String(body.description).trim().slice(0, 600);

    try {
      /* Launch-on-start is a Chrome-app style exclusive slot: only installed
         workflows may claim it, and enabling it clears it on every other one. */
      if (data.autoLaunch === true) {
        const target = await db.workflow.findUnique({ where: { id }, select: { installed: true } });
        if (!target) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
        if (!target.installed) {
          return NextResponse.json(
            { error: "Install the workflow before enabling launch-on-start" },
            { status: 400 }
          );
        }
        const updated = await db.$transaction([
          db.workflow.updateMany({ data: { autoLaunch: false } }),
          db.workflow.update({ where: { id }, data }),
        ]);
        const w = updated[1];
        return NextResponse.json({
          id: w.id, name: w.name, description: w.description, installed: w.installed,
          autoLaunch: w.autoLaunch, lastRunAt: w.lastRunAt, createdAt: w.createdAt, updatedAt: w.updatedAt,
        });
      }

      const w = await db.workflow.update({ where: { id }, data });
      return NextResponse.json({
        id: w.id,
        name: w.name,
        description: w.description,
        installed: w.installed,
        autoLaunch: w.autoLaunch,
        lastRunAt: w.lastRunAt,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      });
    } catch {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
  },
  { timeoutMs: 30_000, label: "workflows.update" }
);

export const DELETE = withRouteTimeout(
  async (_req: NextRequest, ctx: Ctx) => {
    const { id } = await ctx.params;
    try {
      await db.workflow.delete({ where: { id } });
      return NextResponse.json({ ok: true });
    } catch {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
  },
  { timeoutMs: 30_000, label: "workflows.delete" }
);
