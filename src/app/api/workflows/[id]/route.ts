import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const w = await db.workflow.findUnique({ where: { id }, include: { steps: { orderBy: { order: "asc" } } } });
  if (!w) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  return NextResponse.json({
    id: w.id,
    name: w.name,
    description: w.description,
    installed: w.installed,
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
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  let body: { installed?: unknown; markRun?: unknown; name?: unknown; description?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data: { installed?: boolean; lastRunAt?: Date; name?: string; description?: string } = {};
  if (typeof body.installed === "boolean") data.installed = body.installed;
  if (body.markRun === true) data.lastRunAt = new Date();
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    data.name = name.slice(0, 120);
  }
  if (body.description !== undefined) data.description = String(body.description).trim().slice(0, 600);

  try {
    const w = await db.workflow.update({ where: { id }, data });
    return NextResponse.json({
      id: w.id,
      name: w.name,
      description: w.description,
      installed: w.installed,
      lastRunAt: w.lastRunAt,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    });
  } catch {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    await db.workflow.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }
}
