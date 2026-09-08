"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTime } from "@/lib/format";
import { useTeachCast } from "@/lib/store";
import type { ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ChatThread() {
  const messages = useTeachCast((s) => s.messages);
  const threadLoading = useTeachCast((s) => s.threadLoading);
  const chatsLoading = useTeachCast((s) => s.chatsLoading);
  const activeChatId = useTeachCast((s) => s.activeChatId);

  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const root = scrollRootRef.current;
    const viewport =
      root?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]") ?? null;
    if (!viewport) return;
    viewportRef.current = viewport;
    const onScroll = () => {
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      setAtBottom(distance < 96);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setAtBottom(true);
  }, [activeChatId]);

  const messageCount = messages.length;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !atBottom) return;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: messageCount > 0 ? "smooth" : "auto",
    });
  }, [messageCount, atBottom, activeChatId]);

  const jumpToLatest = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  };

  const busy = threadLoading || chatsLoading;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ScrollArea ref={scrollRootRef} className="h-full">
        <div
          role="log"
          aria-label="Messages"
          className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6"
        >
          {busy ? (
            <ThreadSkeleton />
          ) : messages.length === 0 ? (
            <EmptyThread />
          ) : (
            messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))
          )}
        </div>
      </ScrollArea>
      {!busy && !atBottom && messages.length > 0 ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 gap-1.5 shadow-lg"
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <article className={cn("flex w-full flex-col gap-1", isUser ? "items-end" : "items-start")}>
      <span className="px-1 text-xs font-medium text-muted-foreground">
        {isUser ? "You" : "GLM"}
      </span>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-line rounded-xl border px-4 py-3 text-sm leading-relaxed",
          isUser
            ? "border-amber-400/25 bg-amber-500/10 text-amber-100"
            : "border-emerald-400/25 bg-emerald-500/10 text-emerald-100"
        )}
      >
        {message.text}
      </div>
      <time
        suppressHydrationWarning
        dateTime={message.createdAt}
        title={new Date(message.createdAt).toLocaleString()}
        className="px-1 text-[11px] text-muted-foreground"
      >
        {formatTime(message.createdAt)}
      </time>
    </article>
  );
}

function EmptyThread() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <span
        className="flex h-11 w-11 items-center justify-center rounded-full border bg-card text-muted-foreground"
        aria-hidden="true"
      >
        <MessageSquare className="h-5 w-5" />
      </span>
      <div className="max-w-sm">
        <p className="text-sm font-medium">Describe an app to get started</p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          Tell me what to build — for example, a todo app with priorities. The workspace
          panel fills in as the build runs.
        </p>
      </div>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div className="flex flex-col items-end gap-2">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-14 w-2/3 rounded-xl" />
      </div>
      <div className="flex flex-col items-start gap-2">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-24 w-3/4 rounded-xl" />
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="flex flex-col items-end gap-2">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-12 w-1/2 rounded-xl" />
      </div>
    </div>
  );
}
