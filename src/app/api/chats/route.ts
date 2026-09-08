import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { serializeChat } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const createChatSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
});

export async function GET() {
  try {
    const chats = await db.chat.findMany({ orderBy: { createdAt: "desc" } });
    return NextResponse.json({ chats: chats.map(serializeChat) });
  } catch (error) {
    console.error("GET /api/chats failed", error);
    return NextResponse.json({ error: "Failed to load chats" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const parsed = createChatSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid chat payload" }, { status: 400 });
    }
    const chat = await db.chat.create({ data: { title: parsed.data.title ?? "New chat" } });
    return NextResponse.json({ chat: serializeChat(chat) }, { status: 201 });
  } catch (error) {
    console.error("POST /api/chats failed", error);
    return NextResponse.json({ error: "Could not create the chat" }, { status: 500 });
  }
}
