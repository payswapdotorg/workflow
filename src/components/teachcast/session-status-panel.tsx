"use client";

import { useEffect, useState } from "react";
import { Activity, Loader2, MonitorUp, RotateCcw, TriangleAlert } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import { sessionWatchdog, RECOVERY_COOLDOWN_MS } from "@/lib/session-watchdog";
import { cn } from "@/lib/utils";

/* Long-running session status: live turn clock, hang detection state,
   screen-share and replay health, and manual recovery. Rendered in the
   header as an indicator dot + popover panel. */

function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

const STATE_META: Record<string, { label: string; dot: string; text: string }> = {
  idle: { label: "Idle", dot: "bg-emerald-500", text: "text-emerald-400" },
  streaming: { label: "Streaming", dot: "bg-amber-400", text: "text-amber-300" },
  hung: { label: "Hung", dot: "bg-red-500", text: "text-red-400" },
};

export function SessionStatus() {
  const health = useAppStore((s) => s.sessionHealth);
  const stream = useAppStore((s) => s.stream);
  const replayWorkflow = useAppStore((s) => s.replayWorkflow);
  const replayStatus = useAppStore((s) => s.replayStatus);
  const [, setTick] = useState(0);

  /* re-render every second so elapsed/age values stay live */
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const meta = STATE_META[health.state] ?? STATE_META.idle;
  const now = Date.now();
  const elapsed = health.startedTs ? now - health.startedTs : null;
  const sinceActivity = health.lastActivityTs ? now - health.lastActivityTs : null;
  const cooldownLeft = health.lastRecoveryTs
    ? Math.max(0, RECOVERY_COOLDOWN_MS - (now - health.lastRecoveryTs))
    : 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="relative rounded-md p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500"
          aria-label={`Session status: ${meta.label}`}
          title="Session status"
        >
          <Activity className="h-4 w-4" />
          <span className={cn("absolute right-0.5 top-0.5 h-2 w-2 rounded-full", meta.dot)} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-300">
        <div className="flex items-center gap-2">
          <span className={cn("h-2.5 w-2.5 rounded-full", meta.dot)} />
          <span className={cn("text-sm font-semibold", meta.text)}>{meta.label}</span>
          {health.kind && <span className="text-[11px] text-zinc-500">turn surface: {health.kind}</span>}
          {health.state === "streaming" && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-amber-300" />}
        </div>

        <dl className="mt-3 space-y-1.5">
          <div className="flex justify-between gap-2">
            <dt className="text-zinc-500">Turn elapsed</dt>
            <dd className="font-mono text-zinc-200">{elapsed !== null ? fmtDuration(elapsed) : "—"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-zinc-500">Last real progress</dt>
            <dd className="font-mono text-zinc-200">
              {sinceActivity !== null ? `${fmtDuration(sinceActivity)} ago` : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-zinc-500">Hang threshold</dt>
            <dd className="font-mono text-zinc-200">{fmtDuration(health.hangThresholdMs)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-zinc-500">Screen share</dt>
            <dd className={stream ? "text-emerald-400" : "text-zinc-500"}>
              {stream ? "LIVE" : "off"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-zinc-500">Replay</dt>
            <dd className="max-w-[10rem] truncate text-zinc-300" title={replayWorkflow?.name}>
              {replayWorkflow ? `${replayStatus} · ${replayWorkflow.name}` : "no workflow"}
            </dd>
          </div>
        </dl>

        {health.state === "hung" && (
          <p className="mt-3 flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 p-2 leading-relaxed text-red-200">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              The active turn has been frozen for {fmtDuration(health.hangThresholdMs)}. Auto-recovery reloads the app,
              restores the draft and resubmits.
            </span>
          </p>
        )}
        {health.suppressed && (
          <p className="mt-3 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 leading-relaxed text-amber-200">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Auto-reload was suppressed (a recovery already ran within {fmtDuration(RECOVERY_COOLDOWN_MS)}). Use the
              button below to recover manually.
            </span>
          </p>
        )}

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] text-zinc-500">
            {cooldownLeft > 0 ? `Auto-recovery re-arms in ${fmtDuration(cooldownLeft)}` : "Auto-recovery armed"}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 border-zinc-700 px-2 text-[11px] text-zinc-200 hover:bg-zinc-800"
            onClick={() => sessionWatchdog.recover(health.kind ?? "session", { bypassCooldown: true })}
          >
            <RotateCcw className="h-3 w-3" />
            Reload &amp; recover now
          </Button>
        </div>

        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-600">
          <MonitorUp className="mt-0.5 h-3 w-3 shrink-0" />
          Threshold can be tuned for your machine via localStorage key{" "}
          <code className="rounded bg-zinc-800 px-1">teachcast.hangThresholdMs</code>.
        </p>
      </PopoverContent>
    </Popover>
  );
}
