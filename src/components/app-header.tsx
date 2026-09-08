"use client";

import { useState } from "react";
import { Blocks, History, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ChatList } from "@/components/chat-list";
import { useTeachCast } from "@/lib/store";

export function AppHeader() {
  const [historyOpen, setHistoryOpen] = useState(false);
  const createChat = useTeachCast((s) => s.createChat);
  const activeTitle = useTeachCast((s) =>
    s.chats.find((chat) => chat.id === s.activeChatId)?.title
  );

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary"
          aria-hidden="true"
        >
          <Blocks className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold tracking-tight">TeachCast</span>
        <span className="text-xs text-muted-foreground">v2</span>
      </div>

      {activeTitle ? (
        <span className="hidden max-w-[220px] truncate text-sm text-muted-foreground sm:block lg:hidden">
          {activeTitle}
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        <Badge variant="outline" className="gap-1.5 bg-card" title="Active model">
          <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
          </span>
          GLM
        </Badge>

        <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 lg:hidden"
              aria-label="Chat history"
            >
              <History className="h-4 w-4" />
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Chats</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <Button
                className="h-11 w-full justify-start gap-2"
                onClick={() => {
                  setHistoryOpen(false);
                  void createChat();
                }}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                New chat
              </Button>
              <div className="flex max-h-[50vh] min-h-0 flex-col">
                <ChatList onSelect={() => setHistoryOpen(false)} />
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </header>
  );
}
