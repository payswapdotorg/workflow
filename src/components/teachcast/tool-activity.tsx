"use client";

import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Code2,
  FileText,
  FilePlus2,
  Globe,
  Loader2,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import type { ToolEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

const META: Record<string, { icon: typeof FileText; label: string }> = {
  read_file: { icon: FileText, label: "Read file" },
  write_file: { icon: FilePlus2, label: "Write file" },
  run_shell: { icon: TerminalSquare, label: "Shell" },
  run_code: { icon: Code2, label: "Run code" },
  browser_control: { icon: Globe, label: "Browser" },
};

function summarize(e: ToolEvent): string {
  const a = e.args ?? {};
  switch (e.name) {
    case "read_file":
      return String(a.path ?? "");
    case "write_file":
      return `${String(a.path ?? "")}${a.append ? " (append)" : ""}`;
    case "run_shell":
      return String(a.command ?? "").slice(0, 80);
    case "run_code":
      return `${String(a.language ?? "")} · ${String(a.code ?? "").length} chars`;
    case "browser_control":
      return [
        String(a.action ?? ""),
        a.url ? String(a.url) : "",
        a.ref ? String(a.ref).startsWith("@") ? String(a.ref) : `@${a.ref}` : "",
        a.key ? `key:${a.key}` : "",
        a.direction ? `→ ${a.direction}` : "",
        a.mode ? String(a.mode) : "",
      ]
        .filter(Boolean)
        .join(" ");
    default:
      return e.name;
  }
}

/** Renders the agent tool executions attached to an assistant message. */
export function ToolActivity({ calls }: { calls: ToolEvent[] }) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  if (!calls?.length) return null;

  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="mb-2 space-y-1.5" aria-label="Agent tool activity">
      {calls.map((e) => {
        const meta = META[e.name] ?? { icon: TerminalSquare, label: e.name };
        const Icon = meta.icon;
        const running = e.status === "running";
        const failed = e.status === "done" && e.ok === false;
        const hasOutput = !!e.output && e.output.length > 0;
        const open = openIds.has(e.id);
        return (
          <div
            key={e.id}
            className={cn(
              "overflow-hidden rounded-lg border text-xs",
              running
                ? "border-amber-500/40 bg-amber-500/[0.06]"
                : failed
                  ? "border-red-500/30 bg-red-500/[0.06]"
                  : "border-zinc-800 bg-zinc-950/80"
            )}
          >
            <button
              type="button"
              onClick={() => hasOutput && toggle(e.id)}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left",
                hasOutput ? "cursor-pointer hover:bg-zinc-900" : "cursor-default"
              )}
              aria-expanded={open}
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-400" />
              ) : failed ? (
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-red-400" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
              )}
              <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              <span className="shrink-0 font-medium text-zinc-200">{meta.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-500">{summarize(e)}</span>
              {hasOutput && (
                <ChevronDown className={cn("h-3 w-3 shrink-0 text-zinc-500 transition-transform", open && "rotate-180")} />
              )}
            </button>
            {open && hasOutput && (
              <pre className="max-h-48 overflow-y-auto border-t border-zinc-800/80 bg-black/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-300 teachcast-scroll">
                {e.output}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
