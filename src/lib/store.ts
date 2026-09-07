"use client";

import { create } from "zustand";
import type {
  ChatMessage,
  RecordedStep,
  ReplayStatus,
  SessionHealthSnapshot,
  SettingsDTO,
  StepKind,
  StepPayload,
  View,
  WorkflowDTO,
  WorkflowSummaryDTO,
  ExecLogEntry,
  ExecRunState,
} from "./types";
import { uid } from "./types";
import type { DraftStep } from "./teach-capture";

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

interface AppState {
  /* navigation */
  view: View;
  setView: (v: View) => void;

  /* provider settings (cached) */
  settings: SettingsDTO | null;
  setSettings: (s: SettingsDTO | null) => void;

  /* shared screen stream (session + replay) */
  stream: MediaStream | null;
  setStream: (s: MediaStream | null) => void;

  /* teaching session */
  sessionMessages: ChatMessage[];
  sessionSteps: RecordedStep[];
  sessionThinking: boolean;
  pushSessionMessage: (m: ChatMessage) => void;
  patchSessionMessage: (id: string, patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) => void;
  pushSessionStep: (kind: StepKind, payload: StepPayload, ts?: string) => void;
  setSessionThinking: (v: boolean) => void;
  resetSession: () => void;

  /* library */
  workflows: WorkflowSummaryDTO[];
  setWorkflows: (w: WorkflowSummaryDTO[]) => void;
  /** Bumped on every workflow mutation from anywhere in the app (save,
   *  install, delete, launch-on-start, replay markRun) and on Library
   *  re-entry (nav click while Library is already active). LibraryView
   *  refetches whenever it changes, so the list can never go stale — even
   *  when the Library is already the active view. */
  libraryVersion: number;
  bumpLibraryVersion: () => void;

  /* replay */
  replayWorkflow: WorkflowDTO | null;
  replayStatus: ReplayStatus;
  setReplayWorkflow: (w: WorkflowDTO | null) => void;
  setReplayStatus: (s: ReplayStatus) => void;

  /* managed-session console (side panel) */
  consoleOpen: boolean;
  setConsoleOpen: (v: boolean) => void;
  /** True while the console is actively sampling the live screen into its mirror. */
  consoleStreaming: boolean;
  setConsoleStreaming: (v: boolean) => void;
  /** Real count of frames sampled into the console mirror since it started playing. */
  consoleFrames: number;
  bumpConsoleFrames: () => void;

  /* console chat — operator -> LLM, message-only (no workflow steps recorded) */
  consoleMessages: ChatMessage[];
  consoleThinking: boolean;
  pushConsoleMessage: (m: ChatMessage) => void;
  patchConsoleMessage: (id: string, patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) => void;
  setConsoleThinking: (v: boolean) => void;

  /* long-running session health (written by session-watchdog) */
  sessionHealth: SessionHealthSnapshot;
  setSessionHealth: (h: SessionHealthSnapshot) => void;

  /* boot recovery (populated from localStorage by page.tsx, consumed by the composer) */
  pendingRecovery: { kind: string; text: string; resubmit: boolean } | null;
  setPendingRecovery: (r: { kind: string; text: string; resubmit: boolean } | null) => void;

  /* ---------------- M7 dual-cursor teaching ---------------- */
  /** Teaching-chat mode: "teach" (user demonstrates on the shared screen) or
   *  "act" (the LLM acts on the managed browser, cursor mirrored). The stage
   *  reads this to switch surfaces and to label them honestly. */
  chatMode: "teach" | "act";
  setChatMode: (m: "teach" | "act") => void;
  /** Learning capture: the raw event buffer lives in the module-level
   *  teachCapture singleton (high-frequency pointer events must not re-render
   *  the tree); the store mirrors only what the UI renders. */
  captureArmed: boolean;
  captureEventCount: number;
  setCaptureArmed: (v: boolean) => void;
  setCaptureEventCount: (n: number) => void;
  /** Synthesized draft workflow (from "learn this") pending review/save. */
  draftSteps: DraftStep[] | null;
  setDraftSteps: (s: DraftStep[] | null) => void;
  /** Live execution run (POST /api/execute) streamed into the chat. */
  execRun: ExecRunState | null;
  setExecRun: (r: ExecRunState | null) => void;
  patchExecRun: (patch: Partial<ExecRunState>) => void;
  pushExecLog: (entry: ExecLogEntry) => void;
  /** Last real screenshot of the managed browser (data URL) — the act-mode
   *  surface mirrored on the stage while the LLM cursor moves over it. */
  managedFrame: string | null;
  managedUrl: string | null;
  setManagedFrame: (frame: string | null, url?: string | null) => void;
}

function createAppStore() {
    return create<AppState>((set, get) => ({
      view: "session",
    setView: (view) => set({ view }),

    settings: null,
    setSettings: (settings) => set({ settings }),

    stream: null,
    setStream: (stream) => set({ stream }),

    /* ---------------- session ---------------- */
    sessionMessages: [],
    sessionSteps: [],
    sessionThinking: false,
    pushSessionMessage: (m) => set((s) => ({ sessionMessages: [...s.sessionMessages, m] })),
    patchSessionMessage: (id, patch) =>
      set((s) => ({
        sessionMessages: s.sessionMessages.map((m) =>
          m.id === id ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m
        ),
      })),
    pushSessionStep: (kind, payload, ts) =>
      set((s) => ({
        sessionSteps: [...s.sessionSteps, { id: uid(), kind, payload, ts: ts ?? new Date().toISOString() }],
      })),
    setSessionThinking: (v) => set({ sessionThinking: v }),
    resetSession: () => set({ sessionMessages: [], sessionSteps: [], sessionThinking: false }),

    /* ---------------- library ---------------- */
    workflows: [],
    setWorkflows: (workflows) => set({ workflows }),
    libraryVersion: 0,
    bumpLibraryVersion: () => set((s) => ({ libraryVersion: s.libraryVersion + 1 })),

    /* ---------------- replay ----------------- */
    /* Operator directive 2026-09-07: the replay runs on the managed browser
       (/api/execute) — the narration engine and its chat log are removed;
       replayStatus mirrors the exec run for the status panel. */
    replayWorkflow: null,
    replayStatus: "idle" as ReplayStatus,
    setReplayWorkflow: (replayWorkflow) =>
      set({ replayWorkflow, replayStatus: "idle", execRun: null }),
    setReplayStatus: (replayStatus) => set({ replayStatus }),

    /* ---------------- console ---------------- */
    consoleOpen: false,
    setConsoleOpen: (consoleOpen) => set({ consoleOpen }),
    consoleStreaming: false,
    setConsoleStreaming: (consoleStreaming) => set({ consoleStreaming }),
    consoleFrames: 0,
    bumpConsoleFrames: () => set((s) => ({ consoleFrames: s.consoleFrames + 1 })),

    consoleMessages: [],
    consoleThinking: false,
    pushConsoleMessage: (m) => set((s) => ({ consoleMessages: [...s.consoleMessages, m] })),
    patchConsoleMessage: (id, patch) =>
      set((s) => ({
        consoleMessages: s.consoleMessages.map((m) =>
          m.id === id ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m
        ),
      })),
    setConsoleThinking: (consoleThinking) => set({ consoleThinking }),

    /* ---------------- health / recovery ---------------- */
    sessionHealth: {
      state: "idle",
      kind: null,
      startedTs: null,
      lastActivityTs: null,
      hangThresholdMs: 360_000,
      lastRecoveryTs: null,
      suppressed: false,
    },
    setSessionHealth: (sessionHealth) => set({ sessionHealth }),

    pendingRecovery: null,
    setPendingRecovery: (pendingRecovery) => set({ pendingRecovery }),

    /* ---------------- M7 dual-cursor teaching ---------------- */
    chatMode: "teach",
    setChatMode: (chatMode) => set({ chatMode }),
    captureArmed: false,
    captureEventCount: 0,
    setCaptureArmed: (captureArmed) => set({ captureArmed }),
    setCaptureEventCount: (captureEventCount) => set({ captureEventCount }),
    draftSteps: null,
    setDraftSteps: (draftSteps) => set({ draftSteps }),
    execRun: null,
    setExecRun: (execRun) =>
      set((s) => ({
        execRun,
        replayStatus: execRun ? execRun.status : ("idle" as ReplayStatus),
      })),
    patchExecRun: (patch) =>
      set((s) =>
        s.execRun
          ? {
              execRun: { ...s.execRun, ...patch },
              ...(patch.status ? { replayStatus: patch.status as ReplayStatus } : {}),
            }
          : {}
      ),
    pushExecLog: (entry) =>
      set((s) => (s.execRun ? { execRun: { ...s.execRun, log: [...s.execRun.log, entry] } } : {})),
    managedFrame: null,
    managedUrl: null,
    setManagedFrame: (managedFrame, managedUrl) =>
      set((s) => ({ managedFrame, managedUrl: managedUrl === undefined ? s.managedUrl : managedUrl })),
  }));
}

/**
 * The store instance is cached on globalThis (dev only) so React Fast Refresh /
 * HMR re-evaluations of this module reuse the SAME zustand store. Without this,
 * a hot reload can mount fresh components against a new store while previously
 * mounted components are still subscribed to the old one — clicks would update
 * state that the UI never re-renders from (the "nav buttons do nothing" class
 * of bug). In production the module evaluates once, so this is a no-op wrapper.
 */
const storeGlobals = globalThis as unknown as { __teachcastStore?: ReturnType<typeof createAppStore> };
export const useAppStore: ReturnType<typeof createAppStore> =
  storeGlobals.__teachcastStore ?? createAppStore();
if (process.env.NODE_ENV !== "production") {
  storeGlobals.__teachcastStore = useAppStore;
}

/** Convenience helper: the session's last N messages (text only) as LLM history. */
export function recentSessionHistory(): LLMHistory[] {
  const { sessionMessages } = useAppStore.getState();
  return sessionMessages
    .filter((m) => !m.error && m.text.trim())
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.text }));
}

export interface LLMHistory {
  role: "user" | "assistant";
  content: string;
}
