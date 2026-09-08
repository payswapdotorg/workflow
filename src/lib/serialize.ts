import type { Chat, Message } from "@prisma/client";
import type { BuildInfo, BuildPhase, ChatMessage, ChatSummary } from "@/lib/types";

export function serializeChat(chat: Chat): ChatSummary {
  const build: BuildInfo | null = chat.buildPhase
    ? {
        phase: chat.buildPhase as BuildPhase,
        detail: chat.buildDetail ?? "",
        progress: chat.buildProgress ?? 0,
        slug: chat.buildSlug ?? null,
        updatedAt: chat.buildUpdatedAt ? chat.buildUpdatedAt.toISOString() : null,
      }
    : null;

  return { id: chat.id, title: chat.title, createdAt: chat.createdAt.toISOString(), build };
}

export function serializeMessage(message: Message): ChatMessage {
  return {
    id: message.id,
    role: message.role as "user" | "agent",
    text: message.text,
    createdAt: message.createdAt.toISOString(),
  };
}
