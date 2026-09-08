import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recoverStaleBuild } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PUBLISHED_URL = "/?XTransformPort=3170";

export async function GET(request: Request) {
  try {
    const chatId = new URL(request.url).searchParams.get("chatId");

    let chat;
    if (chatId) {
      await recoverStaleBuild(chatId);
      chat = await db.chat.findUnique({ where: { id: chatId } });
      if (!chat) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    } else {
      chat = await db.chat.findFirst({
        where: { buildPhase: { not: null } },
        orderBy: { buildUpdatedAt: "desc" },
      });
      if (!chat) {
        return NextResponse.json({
          phase: "ready",
          detail: "No build running — describe an app in TeachCast to start one",
          progress: 0,
          hasBuild: false,
          publishedUrl: PUBLISHED_URL,
        });
      }
    }

    if (!chat.buildPhase) {
      return NextResponse.json({
        phase: "ready",
        detail: "No build started in this chat yet",
        progress: 0,
        hasBuild: false,
        chatId: chat.id,
        publishedUrl: PUBLISHED_URL,
      });
    }

    return NextResponse.json({
      phase: chat.buildPhase,
      detail: chat.buildDetail ?? "",
      progress: chat.buildProgress ?? 0,
      hasBuild: true,
      chatId: chat.id,
      slug: chat.buildSlug ?? null,
      updatedAt: chat.buildUpdatedAt ? chat.buildUpdatedAt.toISOString() : null,
      ...(chat.buildPhase === "ready" ? { publishedUrl: PUBLISHED_URL } : {}),
    });
  } catch (error) {
    console.error("GET /api/teachcast-status failed", error);
    return NextResponse.json({ error: "Status unavailable" }, { status: 500 });
  }
}
