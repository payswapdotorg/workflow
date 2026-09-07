"use client";

import { ExternalLink, LayoutGrid, MonitorPlay, PanelRight, PlayCircle, Settings2, Zap } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAppStore } from "@/lib/store";
import { SessionStatus } from "@/components/teachcast/session-status-panel";
import type { View } from "@/lib/types";

const NAV: Array<{ view: View; label: string; icon: typeof MonitorPlay }> = [
  { view: "session", label: "Session", icon: MonitorPlay },
  { view: "library", label: "Library", icon: LayoutGrid },
];

const emptySubscribe = () => () => {};
const getEmbedded = () => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
};
const getEmbeddedServer = () => false;

export function AppHeader() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const settings = useAppStore((s) => s.settings);
  const replayWorkflow = useAppStore((s) => s.replayWorkflow);
  const consoleOpen = useAppStore((s) => s.consoleOpen);
  const setConsoleOpen = useAppStore((s) => s.setConsoleOpen);
  const isEmbedded = useSyncExternalStore(emptySubscribe, getEmbedded, getEmbeddedServer);

  const openInNewTab = () => window.open(window.location.href, "_blank", "noopener");

  return (
    <header className="z-20 flex h-14 shrink-0 items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/90 px-3 backdrop-blur sm:px-4">
      {/* brand */}
      <button
        onClick={() => setView("session")}
        className="flex items-center gap-2.5 rounded-md px-1 py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500"
        aria-label="TeachCast home"
      >
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
        </span>
        <span className="text-[15px] font-bold tracking-tight text-zinc-50">TeachCast</span>
        <span className="hidden text-[11px] font-medium text-zinc-500 md:inline">Computer-use teaching studio</span>
      </button>

      {/* nav */}
      <nav className="ml-2 flex items-center gap-1 sm:ml-4" aria-label="Main">
        {NAV.map(({ view: v, label, icon: Icon }) => (
          <Button
            key={v}
            size="sm"
            variant={view === v ? "secondary" : "ghost"}
            className={`h-8 gap-1.5 px-2.5 text-xs ${
              view === v ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            }`}
            onClick={() => setView(v)}
            aria-current={view === v ? "page" : undefined}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </Button>
        ))}
        {replayWorkflow && (
          <Button
            size="sm"
            variant={view === "replay" ? "secondary" : "ghost"}
            className={`h-8 gap-1.5 px-2.5 text-xs ${
              view === "replay" ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            }`}
            onClick={() => setView("replay")}
            aria-current={view === "replay" ? "page" : undefined}
          >
            <PlayCircle className="h-3.5 w-3.5" />
            <span className="max-w-28 truncate">{replayWorkflow.name}</span>
          </Button>
        )}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {/* long-running session health indicator */}
        <SessionStatus />

        {/* managed-session console toggle (studio views) */}
        <Button
          size="sm"
          variant="ghost"
          className={`h-8 gap-1.5 px-2.5 text-xs ${
            consoleOpen ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          }`}
          onClick={() => setConsoleOpen(!consoleOpen)}
          aria-label="Toggle console"
          title="Managed-session console: live mirror, operator chat, external session"
        >
          <PanelRight className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Console</span>
        </Button>

        {/* provider badge */}
        <button
          onClick={() => setView("settings")}
          className="rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500"
          aria-label="Open LLM provider settings"
        >
          <Badge
            variant="outline"
            className={`h-7 cursor-pointer gap-1.5 px-2 text-[11px] font-medium transition-colors ${
              settings && !settings.usingFallback
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
            }`}
          >
            <Zap className="h-3 w-3" />
            <span className="hidden sm:inline">
              {settings && !settings.usingFallback ? "Custom provider" : "Built-in LLM"}
            </span>
          </Badge>
        </button>

        <Button
          size="sm"
          variant="ghost"
          className={`h-8 gap-1.5 px-2.5 text-xs ${
            isEmbedded
              ? "border border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
              : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          }`}
          onClick={openInNewTab}
          title="Screen sharing requires TeachCast to run in its own top-level tab"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Open in new tab</span>
        </Button>

        <Button
          size="sm"
          variant={view === "settings" ? "secondary" : "ghost"}
          className={`h-8 w-8 p-0 ${
            view === "settings" ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          }`}
          onClick={() => setView("settings")}
          aria-label="Settings"
        >
          <Settings2 className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
