"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppWindow,
  CheckCircle2,
  Download,
  ExternalLink,
  Layers,
  Loader2,
  MoreVertical,
  Play,
  Trash2,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppStore } from "@/lib/store";
import { formatDistanceToNow, format } from "date-fns";
import { toast } from "sonner";
import type { WorkflowSummaryDTO } from "@/lib/types";

export function LibraryView() {
  const workflows = useAppStore((s) => s.workflows);
  const setWorkflows = useAppStore((s) => s.setWorkflows);
  const setView = useAppStore((s) => s.setView);
  const setReplayWorkflow = useAppStore((s) => s.setReplayWorkflow);
  const view = useAppStore((s) => s.view);
  const libraryVersion = useAppStore((s) => s.libraryVersion);

  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkflowSummaryDTO | null>(null);
  /** Throttle anchor for focus/visibility/poll revalidation (updated on every fetch). */
  const lastRefreshTs = useRef(0);

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      lastRefreshTs.current = Date.now();
      /* silent refreshes update the list in place — no full-grid spinner */
      if (!opts?.silent) setLoading(true);
      try {
        const res = await fetch("/api/workflows", { cache: "no-store" });
        if (res.ok) setWorkflows(await res.json());
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [setWorkflows]
  );

  /* refetch whenever the Library becomes the active view (views stay mounted) */
  useEffect(() => {
    if (view === "library") refresh();
  }, [view, refresh]);

  /* workflow mutations anywhere (save / install / delete / autoLaunch /
     replay markRun) and Library re-entry clicks bump libraryVersion —
     refetch in the background so an already-open Library can never go
     stale. Bumps only fire while the Library is already active (the
     app-header re-entry handler), so this never double-fetches on entry. */
  useEffect(() => {
    if (view === "library" && libraryVersion > 0) refresh({ silent: true });
  }, [libraryVersion, view, refresh]);

  /* workflows can also change OUTSIDE this tab (API, another window, an
     LLM tool call). While the Library is active: revalidate on window
     focus and on becoming visible (throttled), plus a gentle 10s poll —
     one cheap GET, only while the list is on screen. */
  useEffect(() => {
    if (view !== "library") return;
    const throttled = (minMs: number) => Date.now() - lastRefreshTs.current >= minMs;
    const onFocus = () => {
      if (throttled(3_000)) refresh({ silent: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible" && throttled(3_000)) refresh({ silent: true });
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const poll = setInterval(() => {
      if (throttled(10_000)) refresh({ silent: true });
    }, 10_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(poll);
    };
  }, [view, refresh]);

  const install = async (wf: WorkflowSummaryDTO) => {
    setBusyId(wf.id);
    try {
      const res = await fetch(`/api/workflows/${wf.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installed: true }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      setWorkflows(workflows.map((w) => (w.id === wf.id ? { ...w, installed: true } : w)));
      useAppStore.getState().bumpLibraryVersion(); /* reconcile with server truth */
      toast.success(`“${wf.name}” installed`, { description: "It is now a launchable app in your Library." });
    } catch (err) {
      toast.error("Install failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setBusyId(null);
    }
  };

  const launch = async (wf: WorkflowSummaryDTO) => {
    setLaunchingId(wf.id);
    try {
      const res = await fetch(`/api/workflows/${wf.id}`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      const full = await res.json();
      setReplayWorkflow(full);
      setView("replay");
    } catch (err) {
      toast.error("Launch failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setLaunchingId(null);
    }
  };

  const toggleAutoLaunch = async (wf: WorkflowSummaryDTO) => {
    setBusyId(wf.id);
    try {
      const res = await fetch(`/api/workflows/${wf.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoLaunch: !wf.autoLaunch }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      const updated = await res.json();
      setWorkflows(
        workflows.map((w) =>
          w.id === wf.id
            ? { ...w, autoLaunch: updated.autoLaunch }
            : updated.autoLaunch
              ? { ...w, autoLaunch: false } /* exclusive slot: only one app launches on start */
              : w
        )
      );
      useAppStore.getState().bumpLibraryVersion(); /* reconcile with server truth */
      if (updated.autoLaunch) {
        toast.success(`TeachCast opens with “${wf.name}”`, {
          description: "Launch-on-start is set — the app opens straight into this workflow.",
        });
      } else {
        toast.info(`Launch-on-start removed for “${wf.name}”`);
      }
    } catch (err) {
      toast.error("Could not update launch-on-start", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (wf: WorkflowSummaryDTO) => {
    setBusyId(wf.id);
    try {
      const res = await fetch(`/api/workflows/${wf.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setWorkflows(workflows.filter((w) => w.id !== wf.id));
      useAppStore.getState().bumpLibraryVersion(); /* reconcile with server truth */
      toast.info(`“${wf.name}” deleted`);
    } catch (err) {
      toast.error("Delete failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setBusyId(null);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="mx-auto h-full w-full max-w-6xl overflow-y-auto px-4 py-6 sm:px-6 teachcast-scroll">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-zinc-100">Workflow Library</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Workflows you taught in sessions. Install one to make it a launchable app; launching replays it against your
          live screen.
        </p>
      </div>

      {loading ? (
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-zinc-500">
          <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
          <p className="text-sm">Loading your workflows…</p>
        </div>
      ) : workflows.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-zinc-800 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
            <AppWindow className="h-7 w-7 text-amber-400" />
          </div>
          <div className="max-w-sm">
            <p className="text-sm font-medium text-zinc-200">No workflows yet</p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
              Start a teaching session, share your screen, and narrate a workflow while you perform it. Save it and it
              will appear here as an app.
            </p>
          </div>
          <Button onClick={() => setView("session")} className="gap-2 bg-amber-500 text-black hover:bg-amber-400">
            <Play className="h-4 w-4" />
            Start a session
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workflows.map((wf) => (
            <Card
              key={wf.id}
              className="group flex flex-col border-zinc-800/80 bg-zinc-900/60 p-0 transition-colors hover:border-zinc-700"
            >
              <CardContent className="flex flex-1 flex-col gap-3 p-5">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950">
                    <AppWindow className="h-5 w-5 text-amber-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-zinc-100" title={wf.name}>
                      {wf.name}
                    </h3>
                    <div className="mt-1 flex items-center gap-1.5">
                      {wf.installed ? (
                        <Badge className="h-5 gap-1 border-transparent bg-emerald-500/15 px-1.5 text-[10px] font-medium text-emerald-400">
                          <CheckCircle2 className="h-2.5 w-2.5" /> Installed
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="h-5 border-zinc-700 px-1.5 text-[10px] text-zinc-400">
                          Draft
                        </Badge>
                      )}
                      {wf.autoLaunch && (
                        <Badge className="h-5 gap-1 border-transparent bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-300" title="Opens automatically when TeachCast starts">
                          <Zap className="h-2.5 w-2.5" /> On start
                        </Badge>
                      )}
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                        aria-label={`Actions for ${wf.name}`}
                      >
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="border-zinc-800 bg-zinc-900">
                      {wf.installed && (
                        <DropdownMenuItem onClick={() => toggleAutoLaunch(wf)}>
                          <Zap className="mr-2 h-3.5 w-3.5" />
                          {wf.autoLaunch ? "Remove launch-on-start" : "Launch on start"}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        className="text-red-400 focus:bg-red-500/10 focus:text-red-300"
                        onClick={() => setDeleteTarget(wf)}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete workflow
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <p className="line-clamp-2 min-h-[2.5rem] text-xs leading-relaxed text-zinc-400">
                  {wf.description || "No description."}
                </p>

                <div className="mt-auto space-y-1 text-[11px] text-zinc-500">
                  <p className="flex items-center gap-1.5">
                    <Layers className="h-3 w-3 text-zinc-600" />
                    {wf.stepCount} step{wf.stepCount === 1 ? "" : "s"}
                  </p>
                  <p className="flex items-center gap-1.5">
                    <ExternalLink className="h-3 w-3 text-zinc-600" />
                    {wf.lastRunAt ? `Last run ${formatDistanceToNow(new Date(wf.lastRunAt), { addSuffix: true })}` : "Never run"}
                  </p>
                  <p className="flex items-center gap-1.5">
                    <AppWindow className="h-3 w-3 text-zinc-600" />
                    Created {format(new Date(wf.createdAt), "MMM d, HH:mm")}
                  </p>
                </div>

                <div className="flex gap-2 pt-1">
                  {!wf.installed ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 gap-1.5 border-zinc-700 text-zinc-200 hover:bg-zinc-800"
                      disabled={busyId === wf.id}
                      onClick={() => install(wf)}
                    >
                      {busyId === wf.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                      Install
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled className="flex-1 gap-1.5 border-emerald-500/30 text-emerald-400/70">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Installed
                    </Button>
                  )}
                  <Button
                    size="sm"
                    className="flex-1 gap-1.5 bg-amber-500 text-black hover:bg-amber-400"
                    disabled={launchingId === wf.id}
                    onClick={() => launch(wf)}
                  >
                    {launchingId === wf.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    Launch
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent className="border-zinc-800 bg-zinc-900">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the workflow and its {deleteTarget?.stepCount ?? 0} step
              {deleteTarget?.stepCount === 1 ? "" : "s"}. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-zinc-700 bg-transparent text-zinc-200 hover:bg-zinc-800">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-500"
              onClick={() => deleteTarget && remove(deleteTarget)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
