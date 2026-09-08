"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AppHeader } from "@/components/app-header";
import { ChatSidebar } from "@/components/chat-sidebar";
import { ChatThread } from "@/components/chat-thread";
import { PromptBox } from "@/components/prompt-box";
import { WorkspacePanel } from "@/components/workspace-panel";
import { useTeachCast } from "@/lib/store";

export default function Home() {
  const init = useTeachCast((s) => s.init);
  const error = useTeachCast((s) => s.error);
  const clearError = useTeachCast((s) => s.clearError);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (error) {
      toast.error(error);
      clearError();
    }
  }, [error, clearError]);

  return (
    <div className="flex h-dvh min-h-screen flex-col">
      <h1 className="sr-only">TeachCast v2</h1>
      <AppHeader />
      <div className="flex min-h-0 flex-1">
        <ChatSidebar />
        <main className="flex min-h-0 flex-1 flex-col">
          <Tabs defaultValue="chat" className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b px-4 py-2.5 md:hidden">
              <TabsList className="grid h-12 w-full grid-cols-2">
                <TabsTrigger value="chat" className="h-11 text-sm">
                  Chat
                </TabsTrigger>
                <TabsTrigger value="workspace" className="h-11 text-sm">
                  Workspace
                </TabsTrigger>
              </TabsList>
            </div>
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <TabsContent
                value="chat"
                forceMount
                className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden md:w-[60%] md:shrink-0 md:data-[state=inactive]:!flex"
              >
                <section aria-label="Conversation" className="flex min-h-0 flex-1 flex-col">
                  <ChatThread />
                  <PromptBox />
                </section>
              </TabsContent>
              <TabsContent
                value="workspace"
                forceMount
                className="mt-0 flex min-h-0 flex-1 flex-col border-t data-[state=inactive]:hidden md:flex-1 md:border-l md:border-t-0 md:data-[state=inactive]:!flex"
              >
                <WorkspacePanel />
              </TabsContent>
            </div>
          </Tabs>
        </main>
      </div>
    </div>
  );
}
