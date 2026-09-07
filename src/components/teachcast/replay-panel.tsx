"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  Check,
  CircleAlert,
  CircleStop,
  Flag,
  Loader2,
  Play,
  Terminal,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useAppStore } from "@/lib/store";
import { abortExecRun, isExecRunning, startExecRun } from "@/lib/exec-client";
import type { ExecLogEntry, ExecRunState } from "@/lib/types";
import { toast } from "sonner";

/**
 * The Replay view (operator directive 2026-09-07): "remove the reply and show
 * the browser." Launching a workflow runs it on the DEDICATED managed browser
 * (the /api/execute engine) and the stage shows that browser live — this panel
 * is the honest execution record only: step progress, skips, failures, and the
 * terminal verdict, verbatim from the server. No LLM narration, no chat — the
 * browser is the reply.
 */
export function ReplayPanel() {
  const workflow = useAppStore((s) => s.replayWorkflow);
  const execRun = useAppStore((s) => s.execRun);
  const consoleOpen = useAppStore((s) => s.consoleOpen);
  const setConsoleOpen = useAppStore((s) => s.setConsoleOpen);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [execRun?.log.length, execRun?.status]);

  /* hooks BEFORE any early return — hook count must never vary with state */
  const log = execRun?.log ?? [];
  const doneish = useMemo(
    () => log.filter((e) => e.type === "step" && (e.status === "done" || e.status === "skipped" || e.status === "failed")).length,
    [log]
  );
  const browserMissing = useMemo(
    () => log.some((e) => e.type === "msg" && e.text.includes("managed browser is not connected")),
    [log]
  );

  if (!workflow) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
          <Play className="h-7 w-7 text-amber-400" />
        </div>
        <div className="max-w-xs">
          <p className="text-sm font-medium text-zinc-200">No workflow launched</p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Pick a workflow in your Library and press Launch — it runs on the managed browser and the browser appears on the stage.
          </p>
        </div>
        <Button
          onClick={() => useAppStore.getState().setView("library")}
          className="bg-amber-500 text-black hover:bg-amber-400"
        >
          Go to Library
        </Button>
      </div>
    );
  }

  const total = workflow.steps.length;
  const status = execRun?.status ?? "idle";
  const busy = status === "running";

  /* progress from the terminal step entries the server actually reported */
  const progress = total === 0 ? 0 : Math.round((doneish / total) * 100);

  const start = () => {
    if (isExecRunning()) return;
    void startExecRun(workflow.id, workflow.name);
  };
  const stop = () => {
    abortExecRun();
    toast.info("Run stopped", { description: "The managed-browser run was aborted." });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="border-b border-zinc-800/80 px-4 py-3">
        <div className="flex items-center gap-2">
          <Flag className="h-4 w-4 shrink-0 text-amber-400" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100" title={workflow.name}>
            {workflow.name}
          </h2>
          <Badge
            variant="outline"
            className="hidden h-5 shrink-0 gap-1 border-sky-500/40 px-1.5 text-[10px] text-sky-300 sm:inline-flex"
            title="This workflow runs on the dedicated managed browser — the stage shows that browser live"
          >
            <Terminal className="h-2.5 w-2.5" />
            managed browser
          </Badge>
          {workflow.autoLaunch && (
            <Badge variant="outline" className="hidden h-5 shrink-0 gap-1 border-amber-500/40 px-1.5 text-[10px] text-amber-300 sm:inline-flex" title="This workflow opens automatically when TeachCast starts">
              <Zap className="h-2.5 w-2.5" />
              On start
            </Badge>
          )}
          <StatusBadge status={status} />
        </div>
        {workflow.description && (
          <p className="mt-1 line-clamp-1 text-xs text-zinc-500" title={workflow.description}>
            {workflow.description}
          </p>
        )}
        <div className="mt-2.5">
          <Progress value={progress} className="h-1.5 bg-zinc-800 [&>div]:bg-sky-400" />
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-zinc-500">
            <span>
              {doneish}/{total} steps settled
            </span>
            {busy && <span className="text-sky-400/90">Running on the managed browser — watch the stage. You can click into the browser to take over (captchas, logins).</span>}
          </div>
        </div>
        {/* controls */}
        <div className="mt-3 flex items-center gap-2">
          {busy ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 border-red-500/40 text-red-300 hover:bg-red-500/10"
              onClick={stop}
            >
              <CircleStop className="h-3.5 w-3.5" />
              Stop run
            </Button>
          ) : (
            <Button size="sm" className="h-8 gap-1.5 bg-sky-600 text-white hover:bg-sky-500" onClick={start}>
              <Play className="h-3.5 w-3.5" />
              {status === "idle" ? "Start run" : "Run again"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            onClick={() => setConsoleOpen(!consoleOpen)}
            title="The console panel connects the managed browser (chat.z.ai) and shows its live state"
          >
            <Terminal className="h-3.5 w-3.5" />
            {consoleOpen ? "Hide console" : "Open console"}
          </Button>
        </div>
      </div>

      {/* execution log — the honest record, verbatim from the server */}
      <div ref={scrollRef} className="flex-1 space-y-1.5 overflow-y-auto px-4 py-4 teachcast-scroll">
        {log.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-zinc-400">Ready to run “{workflow.name}”</p>
            <p className="max-w-xs text-xs leading-relaxed text-zinc-600">
              It will execute on the managed browser — the browser appears on the stage LIVE and you can drive it yourself: click into it and your mouse and keyboard land on the real page (solve a captcha or log in mid-run). Connect it from the console first if it is not already live.
            </p>
          </div>
        )}
        {log.map((entry) => (
          <ExecRow key={entry.id} entry={entry} />
        ))}
        {browserMissing && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-left text-xs text-amber-200/90">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              The managed browser is not connected. Open the console, press <strong>Connect chat.z.ai</strong>, then Start the run again.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* one step or one server line */
function ExecRow({ entry }: { entry: ExecLogEntry }) {
  if (entry.type === "msg") {
    return (
      <p className="px-1.5 text-[12px] leading-relaxed text-zinc-400">
        {entry.text.startsWith("Run failed") || entry.text.startsWith("tool error") ? (
          <span className="text-red-300/90">{entry.text}</span>
        ) : (
          entry.text
        )}
      </p>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-zinc-800/60 bg-zinc-900/40 px-1.5 py-1.5">
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold ${
          entry.status === "done"
            ? "bg-emerald-500/20 text-emerald-300"
            : entry.status === "failed"
              ? "bg-red-500/20 text-red-300"
              : entry.status === "skipped"
                ? "bg-zinc-700/60 text-zinc-400"
                : "bg-sky-500/20 text-sky-300"
        }`}
      >
        {entry.index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] leading-snug text-zinc-200">
          {entry.label}
          {entry.status === "running" && <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin text-sky-400" />}
          {entry.status === "done" && <Check className="ml-1.5 inline h-3 w-3 text-emerald-400" />}
        </p>
        {entry.detail && (
          <p
            className={`mt-0.5 text-[10px] leading-snug ${
              entry.status === "failed" ? "text-red-300/90" : "text-zinc-500"
            }`}
          >
            {entry.detail}
          </p>
        )}
      </div>
      <Badge
        variant="outline"
        className={`h-4 shrink-0 px-1 text-[9px] ${
          entry.status === "done"
            ? "border-emerald-500/40 text-emerald-300"
            : entry.status === "failed"
              ? "border-red-500/40 text-red-300"
              : entry.status === "skipped"
                ? "border-zinc-600 text-zinc-400"
                : "border-sky-500/40 text-sky-300"
        }`}
      >
        {entry.status}
      </Badge>
    </div>
  );
}

function StatusBadge({ status }: { status: ExecRunState["status"] | "idle" }) {
  const cls =
    status === "finished"
      ? "border-emerald-500/40 text-emerald-300"
      : status === "running"
        ? "border-sky-500/40 text-sky-300"
        : status === "failed"
          ? "border-red-500/40 text-red-300"
          : status === "aborted"
            ? "border-zinc-600 text-zinc-400"
            : "border-zinc-700 text-zinc-400";
  return (
    <Badge variant="outline" className={`h-5 shrink-0 px-1.5 text-[10px] ${cls}`}>
      {status}
    </Badge>
  );
}
