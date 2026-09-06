"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Camera,
  CircleAlert,
  Flag,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  SendHorizontal,
  Square,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { useAppStore } from "@/lib/store";
import { replayEngine } from "@/lib/replay-engine";
import { stepInstruction } from "@/lib/types";
import { ToolActivity } from "./tool-activity";
import { toast } from "sonner";

export function ReplayPanel() {
  const workflow = useAppStore((s) => s.replayWorkflow);
  const status = useAppStore((s) => s.replayStatus);
  const cursor = useAppStore((s) => s.replayCursor);
  const doneCount = useAppStore((s) => s.replayDoneCount);
  const log = useAppStore((s) => s.replayLog);
  const stream = useAppStore((s) => s.stream);

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [log, status]);

  if (!workflow) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
          <Play className="h-7 w-7 text-amber-400" />
        </div>
        <div className="max-w-xs">
          <p className="text-sm font-medium text-zinc-200">No workflow launched</p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Pick a workflow in your Library and press Launch to replay it against your live screen.
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
  const progress = total === 0 ? 0 : Math.round((doneCount / total) * 100);
  const busy = status === "running" || status === "paused";
  const canSend = !!input.trim() && !busy;

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    await replayEngine.sendUserMessage(text);
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
            className="hidden h-5 shrink-0 gap-1 border-zinc-700 px-1.5 text-[10px] text-zinc-400 sm:inline-flex"
            title="The LLM can act on the computer during replay: read/write files, run shell commands and code, control a browser"
          >
            <TerminalSquare className="h-2.5 w-2.5" />
            Agent tools on
          </Badge>
          <StatusBadge status={status} />
        </div>
        {workflow.description && (
          <p className="mt-1 line-clamp-1 text-xs text-zinc-500" title={workflow.description}>
            {workflow.description}
          </p>
        )}
        <div className="mt-2.5">
          <Progress value={progress} className="h-1.5 bg-zinc-800 [&>div]:bg-amber-400" />
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-zinc-500">
            <span>
              {doneCount}/{total} steps completed
            </span>
            {status === "running" && cursor >= 0 && (
              <span className="text-amber-400/90">Step {cursor + 1} in progress…</span>
            )}
          </div>
        </div>
        {/* controls */}
        <div className="mt-3 flex items-center gap-2">
          {!busy ? (
            <Button
              size="sm"
              className="h-8 gap-1.5 bg-amber-500 text-black hover:bg-amber-400"
              disabled={!stream}
              onClick={() => {
                if (!stream) return;
                replayEngine.start(workflow);
              }}
            >
              <Play className="h-3.5 w-3.5" />
              {status === "finished" || status === "stopped" ? "Restart replay" : status === "idle" ? "Start replay" : "Resume"}
            </Button>
          ) : (
            status === "running" && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 border-zinc-700 text-zinc-200 hover:bg-zinc-800"
                onClick={() => replayEngine.pause()}
              >
                <Pause className="h-3.5 w-3.5" />
                Pause
              </Button>
            )
          )}
          {status === "paused" && (
            <Button
              size="sm"
              className="h-8 gap-1.5 bg-amber-500 text-black hover:bg-amber-400"
              onClick={() => replayEngine.resume()}
            >
              <Play className="h-3.5 w-3.5" />
              Resume
            </Button>
          )}
          {busy && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 border-red-500/40 text-red-300 hover:bg-red-500/10"
              onClick={() => {
                replayEngine.stop(workflow.id);
                toast.info("Replay stopped", { description: "The run was marked in your Library." });
              }}
            >
              <Square className="h-3 w-3" />
              Stop
            </Button>
          )}
          {!stream && (
            <span className="text-[11px] text-amber-400/80">Share your screen (left) to start the replay.</span>
          )}
        </div>
      </div>

      {/* activity log */}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4 teachcast-scroll">
        {log.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-zinc-400">Ready to replay “{workflow.name}”</p>
            <p className="max-w-xs text-xs leading-relaxed text-zinc-600">
              Each step will appear here with live narration from the LLM as it analyzes frames of your shared screen.
            </p>
          </div>
        )}
        {log.map((entry) =>
          entry.type === "step" ? (
            <StepCard
              key={entry.id}
              stepIndex={entry.stepIndex}
              total={total}
              done={entry.done}
              active={!entry.done && cursor === entry.stepIndex && (status === "running" || status === "paused")}
            />
          ) : (
            <div key={entry.id} className={entry.msg.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[92%] rounded-2xl border px-3 py-2 ${
                  entry.msg.role === "user"
                    ? "rounded-br-md border-amber-500/25 bg-amber-500/10"
                    : entry.msg.error
                      ? "rounded-bl-md border-red-500/30 bg-red-500/10"
                      : "rounded-bl-md border-zinc-800 bg-zinc-900"
                }`}
              >
                {entry.msg.role === "assistant" && <ToolActivity calls={entry.msg.toolCalls ?? []} />}
                {entry.msg.image && (
                   
                  <img
                    src={entry.msg.image}
                    alt="Frame captured during replay"
                    className="mb-1.5 max-h-36 w-full rounded-lg border border-zinc-700/50 object-cover"
                  />
                )}
                <p
                  className={`whitespace-pre-wrap text-[13px] leading-relaxed ${
                    entry.msg.role === "user" ? "text-amber-50" : entry.msg.error ? "text-red-200" : "text-zinc-200"
                  }`}
                >
                  {entry.msg.text}
                  {entry.msg.streaming && !entry.msg.text && <span className="text-zinc-500">…</span>}
                </p>
                {entry.msg.streaming && entry.msg.text && (
                  <span className="mt-1 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-amber-400" />
                )}
              </div>
            </div>
          )
        )}
      </div>

      {/* composer */}
      <div className="border-t border-zinc-800/80 p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Ask about the replay while it runs — the LLM sees the current frame"
            rows={2}
            className="max-h-32 min-h-[48px] resize-none border-zinc-800 bg-zinc-900 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-amber-500/50"
          />
          <Button
            onClick={send}
            disabled={!canSend}
            size="icon"
            className="h-[48px] w-[48px] shrink-0 rounded-xl bg-amber-500 text-black hover:bg-amber-400"
            aria-label="Send message"
          >
            <SendHorizontal className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    idle: { label: "Ready", cls: "border-zinc-700 text-zinc-400" },
    running: { label: "Running", cls: "border-transparent bg-amber-500/15 text-amber-300" },
    paused: { label: "Paused", cls: "border-zinc-600 bg-zinc-800 text-zinc-300" },
    finished: { label: "Finished", cls: "border-transparent bg-emerald-500/15 text-emerald-400" },
    stopped: { label: "Stopped", cls: "border-transparent bg-red-500/15 text-red-400" },
  };
  const s = map[status] ?? map.idle;
  return (
    <Badge variant="outline" className={`h-5 shrink-0 px-1.5 text-[10px] font-medium ${s.cls}`}>
      {status === "running" && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}
      {s.label}
    </Badge>
  );
}

function StepCard({
  stepIndex,
  total,
  done,
  active,
}: {
  stepIndex: number;
  total: number;
  done: boolean;
  active: boolean;
}) {
  const step = useAppStore((s) => s.replayWorkflow?.steps[stepIndex]);
  if (!step) return null;
  const isSnapshot = step.kind === "snapshot";
  return (
    <div
      className={`rounded-xl border p-3 transition-all ${
        active
          ? "border-amber-500/60 bg-amber-500/[0.06] shadow-[0_0_20px_-6px] shadow-amber-500/40"
          : done
            ? "border-zinc-800/80 bg-zinc-900/40 opacity-60"
            : "border-zinc-800 bg-zinc-900/40 opacity-40"
      }`}
      aria-current={active ? "step" : undefined}
    >
      <div className="flex items-center gap-2">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold ${
            active ? "bg-amber-500 text-black" : done ? "bg-emerald-500/20 text-emerald-400" : "bg-zinc-800 text-zinc-400"
          }`}
        >
          {done ? <Check className="h-3.5 w-3.5" /> : stepIndex + 1}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Step {stepIndex + 1} of {total}
        </span>
        <Badge variant="outline" className="ml-auto h-4.5 gap-1 border-zinc-700 px-1.5 text-[10px] text-zinc-400">
          {isSnapshot ? <Camera className="h-2.5 w-2.5" /> : <MessageSquare className="h-2.5 w-2.5" />}
          {step.kind}
        </Badge>
        {active && <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" /></span>}
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-zinc-200">
        {stepInstruction(step) || <span className="italic text-zinc-500">(no instruction)</span>}
      </p>
      {step.payload.image && (
         
        <img
          src={step.payload.image}
          alt="Teacher's reference frame for this step"
          className={`mt-2 max-h-40 rounded-lg border border-zinc-800 object-cover ${done ? "" : "ring-1 ring-amber-500/30"}`}
        />
      )}
      {active && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-300/90">
          <CircleAlert className="h-3 w-3" />
          The LLM is analyzing the live frame and narrating below.
        </p>
      )}
    </div>
  );
}
