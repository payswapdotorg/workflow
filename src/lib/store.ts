"use client";

import { create } from "zustand";
import type {
  ChatMessage,
  RecordedStep,
  ReplayLogEntry,
  ReplayStatus,
  SettingsDTO,
  StepKind,
  StepPayload,
  View,
  WorkflowDTO,
  WorkflowSummaryDTO,
} from "./types";
import { uid } from "./types";

/* ------------------------------------------------------------------ */
/* Replay log helpers                                                  */
/* ------------------------------------------------------------------ */

export function pushReplayMsg(
  log: ReplayLogEntry[],
  msg: ChatMessage
): ReplayLogEntry[] {
  return [...log, { id: uid(), type: "msg", msg }];
}

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

  /* replay */
  replayWorkflow: WorkflowDTO | null;
  replayStatus: ReplayStatus;
  replayCursor: number;
  replayDoneCount: number;
  replayLog: ReplayLogEntry[];
  setReplayWorkflow: (w: WorkflowDTO | null) => void;
  setReplayStatus: (s: ReplayStatus) => void;
  setReplayCursor: (i: number) => void;
  setReplayDoneCount: (n: number) => void;
  resetReplayRun: () => void;
  pushReplayStepEntry: (stepIndex: number) => void;
  markReplayStepDone: (stepIndex: number) => void;
  pushReplayMessage: (m: ChatMessage) => void;
  appendReplayMessage: (msgId: string, delta: string) => void;
  patchReplayMessage: (msgId: string, patch: Partial<ChatMessage>) => void;
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

    /* ---------------- replay ----------------- */
    replayWorkflow: null,
    replayStatus: "idle",
    replayCursor: -1,
    replayDoneCount: 0,
    replayLog: [],
    setReplayWorkflow: (replayWorkflow) =>
      set({ replayWorkflow, replayStatus: "idle", replayCursor: -1, replayDoneCount: 0, replayLog: [] }),
    setReplayStatus: (replayStatus) => set({ replayStatus }),
    setReplayCursor: (replayCursor) => set({ replayCursor }),
    setReplayDoneCount: (replayDoneCount) => set({ replayDoneCount }),
    resetReplayRun: () =>
      set((s) => {
        const wf = s.replayWorkflow;
        return {
          replayLog: wf
            ? [{ id: uid(), type: "step" as const, step: wf.steps[0], stepIndex: 0, done: false }]
            : [],
          replayCursor: wf ? 0 : -1,
          replayDoneCount: 0,
          replayStatus: "running" as ReplayStatus,
        };
      }),
    pushReplayStepEntry: (stepIndex) =>
      set((s) => {
        const wf = s.replayWorkflow;
        if (!wf || !wf.steps[stepIndex]) return {};
        return {
          replayLog: [...s.replayLog, { id: uid(), type: "step" as const, step: wf.steps[stepIndex], stepIndex, done: false }],
        };
      }),
    markReplayStepDone: (stepIndex) =>
      set((s) => ({
        replayLog: s.replayLog.map((e) =>
          e.type === "step" && e.stepIndex === stepIndex ? { ...e, done: true } : e
        ),
      })),
    pushReplayMessage: (m) =>
      set((s) => ({ replayLog: [...s.replayLog, { id: uid(), type: "msg" as const, msg: m }] })),
    appendReplayMessage: (msgId, delta) =>
      set((s) => ({
        replayLog: s.replayLog.map((e) =>
          e.type === "msg" && e.msg.id === msgId ? { ...e, msg: { ...e.msg, text: e.msg.text + delta } } : e
        ),
      })),
    patchReplayMessage: (msgId, patch) =>
      set((s) => ({
        replayLog: s.replayLog.map((e) =>
          e.type === "msg" && e.msg.id === msgId ? { ...e, msg: { ...e.msg, ...patch } } : e
        ),
      })),
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
