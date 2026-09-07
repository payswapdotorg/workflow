"use client";

import { useEffect } from "react";
import { AppHeader } from "@/components/teachcast/app-header";
import { ScreenStage } from "@/components/teachcast/screen-stage";
import { TeachingChat } from "@/components/teachcast/teaching-chat";
import { LibraryView } from "@/components/teachcast/library-view";
import { ReplayPanel } from "@/components/teachcast/replay-panel";
import { SettingsView } from "@/components/teachcast/settings-view";
import { ConsolePanel } from "@/components/teachcast/console-panel";
import { useAppStore } from "@/lib/store";
import { sessionWatchdog } from "@/lib/session-watchdog";
import { captureSnapshotStep } from "@/lib/session-actions";
import type { WorkflowDTO, WorkflowSummaryDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export default function Home() {
  const view = useAppStore((s) => s.view);
  const setSettings = useAppStore((s) => s.setSettings);
  const consoleOpen = useAppStore((s) => s.consoleOpen);

  /* load provider settings once */
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && useAppStore.getState().setSettings(s))
      .catch(() => {});
  }, [setSettings]);

  /* Boot: session watchdog (hang detection / auto-recovery), recovery record,
     and Chrome-app style launch-on-start. Runs once per page load. */
  useEffect(() => {
    sessionWatchdog.attach();

    /* 1. consume a pending recovery record written before a watchdog reload */
    const rec = sessionWatchdog.popRecovery();
    if (rec) {
      useAppStore.getState().setPendingRecovery({
        kind: rec.kind,
        text: rec.text,
        /* the operator console restores its draft only — no surprise resends */
        resubmit: rec.kind === "session" ? rec.resubmit : false,
      });
      if (rec.kind === "console") useAppStore.getState().setConsoleOpen(true);
      toast.info("Recovered from a frozen session", {
        description: rec.resubmit && rec.kind === "session"
          ? "Your draft was restored and will be resubmitted."
          : "Your draft was restored.",
      });
    }

    /* 2. launch-on-start: open straight into the chosen installed workflow */
    (async () => {
      try {
        const res = await fetch("/api/workflows", { cache: "no-store" });
        if (!res.ok) return;
        const list = (await res.json()) as WorkflowSummaryDTO[];
        const target = list.find((w) => w.autoLaunch && w.installed);
        if (!target) return;
        const fullRes = await fetch(`/api/workflows/${target.id}`, { cache: "no-store" });
        if (!fullRes.ok) return;
        const full = (await fullRes.json()) as WorkflowDTO;
        useAppStore.getState().setReplayWorkflow(full);
        if (rec?.resubmit && rec.kind === "session") {
          toast.info(`“${target.name}” is armed`, {
            description: "Launch-on-start workflow is ready in the Replay view.",
          });
          return;
        }
        useAppStore.getState().setView("replay");
        toast.success(`Launching “${target.name}”`, {
          description: "This workflow opens on start. Press Start run — it executes on the managed browser and the stage shows that browser live.",
        });
      } catch {
        /* launch-on-start is best-effort */
      }
    })();
  }, []);

  const inStudio = view === "session" || view === "replay";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <AppHeader />

      <main className="min-h-0 flex-1">
        {/* Studio: persistent split view (screen left / chat right / console) */}
        <div className={cn("h-full min-h-0", !inStudio && "hidden")}>
          <div className="flex h-full min-h-0 flex-col lg:flex-row">
            <div className="h-[42vh] shrink-0 border-zinc-800/80 lg:h-auto lg:min-h-0 lg:flex-1 lg:border-r">
              <ScreenStage mode={view === "replay" ? "replay" : "session"} onSnapshot={captureSnapshotStep} />
            </div>
            <div className="flex min-h-0 flex-1 flex-col lg:w-[440px] lg:max-w-[440px] lg:flex-none xl:w-[480px] xl:max-w-[480px]">
              {view === "replay" ? <ReplayPanel /> : <TeachingChat />}
            </div>
            {consoleOpen && (
              <div className="hidden w-[340px] shrink-0 border-zinc-800/80 lg:block lg:border-l">
                <ConsolePanel />
              </div>
            )}
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
