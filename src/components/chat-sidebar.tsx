"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChatList } from "@/components/chat-list";
import { useTeachCast } from "@/lib/store";
import { cn } from "@/lib/utils";

export function ChatSidebar({ className }: { className?: string }) {
  const createChat = useTeachCast((s) => s.createChat);

  return (
    <nav
      aria-label="Chat history"
      className={cn("hidden w-60 shrink-0 flex-col gap-3 border-r p-3 lg:flex", className)}
    >
      <Button onClick={() => void createChat()} className="h-11 w-full justify-start gap-2">
        <Plus className="h-4 w-4" aria-hidden="true" />
        New chat
      </Button>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <h2 className="px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Conversations
        </h2>
        <ChatList />
      </div>
    </nav>
  );
}
