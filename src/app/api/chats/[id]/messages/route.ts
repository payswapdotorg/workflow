import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { recoverStaleBuild, startBuild } from "@/lib/agent";
import { serializeChat, serializeMessage } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const messageSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Message cannot be empty")
    .max(2000, "Message is limited to 2000 characters"),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  try {
    await recoverStaleBuild(id);
    const chat = await db.chat.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!chat) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    return NextResponse.json({
      chat: serializeChat(chat),
      messages: chat.messages.map(serializeMessage),
    });
  } catch (error) {
    console.error("GET /api/chats/[id]/messages failed", error);
    return NextResponse.json({ error: "Failed to load messages" }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  try {
    const body: unknown = await request.json().catch(() => null);
    const parsed = messageSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid message" },
        { status: 400 }
      );
    }

    const chat = await db.chat.findUnique({ where: { id }, select: { id: true } });
    if (!chat) return NextResponse.json({ error: "Chat not found" }, { status: 404 });

    const message = await db.message.create({
      data: { chatId: id, role: "user", text: parsed.data.text },
    });

    const userMessages = await db.message.count({
      where: { chatId: id, role: "user" },
    });
    if (userMessages === 1) {
      const trimmed = parsed.data.text.trim().replace(/\s+/g, " ");
      const title = trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
      await db.chat.update({ where: { id }, data: { title } });
    }

    await startBuild(id, parsed.data.text);

    return NextResponse.json({ message: serializeMessage(message) }, { status: 201 });
  } catch (error) {
    console.error("POST /api/chats/[id]/messages failed", error);
    return NextResponse.json(
      { error: "Could not deliver the message to the build agent" },
      { status: 500 }
    );
  }
}
