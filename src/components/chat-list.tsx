"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/format";
import { useTeachCast } from "@/lib/store";
import type { BuildPhase } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ChatList({ onSelect }: { onSelect?: () => void }) {
  const chats = useTeachCast((s) => s.chats);
  const chatsLoading = useTeachCast((s) => s.chatsLoading);
  const activeChatId = useTeachCast((s) => s.activeChatId);
  const selectChat = useTeachCast((s) => s.selectChat);

  if (chatsLoading) {
    return (
      <div className="flex flex-col gap-1" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-md" />
        ))}
      </div>
    );
  }

  if (chats.length === 0) {
    return (
      <p className="px-2 py-4 text-sm leading-relaxed text-muted-foreground">
        No conversations yet. Start one with New chat.
      </p>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul className="flex flex-col gap-1 pr-1.5">
        {chats.map((chat) => {
          const active = chat.id === activeChatId;
          return (
            <li key={chat.id}>
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  onSelect?.();
                  void selectChat(chat.id);
                }}
                className={cn(
                  "flex min-h-11 w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                )}
              >
                <BuildDot phase={chat.build?.phase ?? null} />
                <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                <span
                  suppressHydrationWarning
                  className="shrink-0 text-[11px] text-muted-foreground/80"
                >
                  {relativeTime(chat.createdAt)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );
}

function BuildDot({ phase }: { phase: BuildPhase | null }) {
  if (phase === null) {
    return (
      <span
        className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground/40"
        aria-hidden="true"
      />
    );
  }
  const tone =
    phase === "ready" ? "bg-emerald-400" : phase === "error" ? "bg-red-400" : "bg-amber-400 animate-pulse";
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", tone)} aria-hidden="true" />;
}
