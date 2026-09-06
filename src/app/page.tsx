"use client";

import { useEffect, useRef } from "react";
import { AppHeader } from "@/components/teachcast/app-header";
import { ScreenStage } from "@/components/teachcast/screen-stage";
import { TeachingChat } from "@/components/teachcast/teaching-chat";
import { LibraryView } from "@/components/teachcast/library-view";
import { ReplayPanel } from "@/components/teachcast/replay-panel";
import { SettingsView } from "@/components/teachcast/settings-view";
import { useAppStore } from "@/lib/store";
import { replayEngine } from "@/lib/replay-engine";
import { captureSnapshotStep } from "@/lib/session-actions";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export default function Home() {
  const view = useAppStore((s) => s.view);
  const setSettings = useAppStore((s) => s.setSettings);
  const prevView = useRef(view);

  /* load provider settings once */
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && useAppStore.getState().setSettings(s))
      .catch(() => {});
  }, [setSettings]);

  /* auto-pause a running replay when the user leaves the Replay view */
  useEffect(() => {
    if (prevView.current === "replay" && view !== "replay" && replayEngine.isBusy()) {
      replayEngine.pause();
      toast.info("Replay paused", { description: "It will stay paused until you return and press Resume." });
    }
    prevView.current = view;
  }, [view]);

  const inStudio = view === "session" || view === "replay";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <AppHeader />

      <main className="min-h-0 flex-1">
        {/* Studio: persistent split view (screen left / chat right) */}
        <div className={cn("h-full min-h-0", !inStudio && "hidden")}>
          <div className="flex h-full min-h-0 flex-col lg:flex-row">
            <div className="h-[42vh] shrink-0 border-zinc-800/80 lg:h-auto lg:min-h-0 lg:flex-1 lg:border-r">
              <ScreenStage mode={view === "replay" ? "replay" : "session"} onSnapshot={captureSnapshotStep} />
            </div>
            <div className="flex min-h-0 flex-1 flex-col lg:w-[440px] lg:max-w-[440px] lg:flex-none xl:w-[480px] xl:max-w-[480px]">
              {view === "replay" ? <ReplayPanel /> : <TeachingChat />}
            </div>
          </div>
        </div>

        {/* Library */}
        <div className={cn("h-full min-h-0", view !== "library" && "hidden")}>
          <LibraryView />
        </div>

        {/* Settings */}
        <div className={cn("h-full min-h-0", view !== "settings" && "hidden")}>
          <SettingsView />
        </div>
      </main>
    </div>
  );
}
