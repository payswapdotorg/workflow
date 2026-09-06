"use client";

import { captureFrame, imagePart, streamChat, textPart } from "./screen";
import { REPLAY_CHAT_SYSTEM, REPLAY_NARRATION_SYSTEM } from "./prompts";
import { useAppStore } from "./store";
import { stepInstruction, uid, type LLMMessage, type LLMMessagePart, type StepDTO, type WorkflowDTO } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function markRun(workflowId: string) {
  fetch(`/api/workflows/${workflowId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markRun: true }),
  }).catch(() => {});
}

/**
 * Module-level replay runner. Lives outside React so a running replay survives
 * navigating between views; state is mirrored into the zustand store.
 */
class ReplayEngine {
  private runId = 0;
  private paused = false;

  private isStale(id: number) {
    return id !== this.runId;
  }

  private async waitWhilePaused(id: number) {
    while (this.paused && !this.isStale(id)) {
      await sleep(150);
    }
  }

  isBusy(): boolean {
    const s = useAppStore.getState().replayStatus;
    return s === "running" || s === "paused";
  }

  async start(workflow: WorkflowDTO) {
    if (this.isBusy()) return;
    this.runId += 1;
    const id = this.runId;
    this.paused = false;

    const st = useAppStore.getState();
    st.setReplayWorkflow(workflow); // also resets log/cursor/progress
    st.setReplayStatus("running");

    const steps = workflow.steps;
    if (steps.length === 0) {
      st.setReplayStatus("finished");
      return;
    }

    for (let i = 0; i < steps.length; i++) {
      if (this.isStale(id)) return;
      st.setReplayCursor(i);
      st.pushReplayStepEntry(i);

      await this.waitWhilePaused(id);
      if (this.isStale(id)) return;

      await this.narrateStep(workflow, steps[i], i, id);
      if (this.isStale(id)) return;

      st.markReplayStepDone(i);
      st.setReplayDoneCount(i + 1);

      await sleep(700);
      await this.waitWhilePaused(id);
      if (this.isStale(id)) return;
    }

    if (this.isStale(id)) return;
    st.setReplayStatus("finished");
    markRun(workflow.id);
  }

  private async narrateStep(workflow: WorkflowDTO, step: StepDTO, index: number, id: number) {
    const st = useAppStore.getState();
    const frame = captureFrame();
    const n = workflow.steps.length;

    const parts: LLMMessagePart[] = [];
    let text = `Workflow: "${workflow.name}" — ${workflow.description || "(no description)"}\n`;
    text += `Current step ${index + 1} of ${n} [${step.kind}]: ${stepInstruction(step) || "(no instruction)"}\n`;
    text += frame
      ? "The first attached image is the current live frame of the shared screen."
      : "No live frame is available right now (screen sharing may be off). Narrate from the instruction alone and mention the frame is unavailable.";
    parts.push(textPart(text));
    if (frame) parts.push(imagePart(frame));
    if (step.kind === "snapshot" && step.payload.image) {
      parts.push(textPart("The teacher's reference screenshot captured at this point in the original session:"));
      parts.push(imagePart(step.payload.image));
    }

    const msgId = uid();
    st.pushReplayMessage({ id: msgId, role: "assistant", text: "", ts: Date.now(), streaming: true });
    try {
      await streamChat({
        system: REPLAY_NARRATION_SYSTEM,
        messages: [{ role: "user", content: parts }],
        onDelta: (d) => {
          if (!this.isStale(id)) useAppStore.getState().appendReplayMessage(msgId, d);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "LLM call failed";
      useAppStore.getState().patchReplayMessage(msgId, { text: `LLM narration failed: ${message}`, error: true });
    }
    if (this.isStale(id)) return;
    useAppStore.getState().patchReplayMessage(msgId, { streaming: false });
  }

  pause() {
    if (useAppStore.getState().replayStatus !== "running") return;
    this.paused = true;
    useAppStore.getState().setReplayStatus("paused");
  }

  resume() {
    if (useAppStore.getState().replayStatus !== "paused") return;
    this.paused = false;
    useAppStore.getState().setReplayStatus("running");
  }

  stop(workflowId?: string) {
    if (!this.isBusy()) return;
    this.runId += 1; // invalidates the running loop
    this.paused = false;
    useAppStore.getState().setReplayStatus("stopped");
    if (workflowId) markRun(workflowId);
  }

  /** Free-form user chat while a replay is active (or paused). */
  async sendUserMessage(text: string) {
    const st = useAppStore.getState();
    const wf = st.replayWorkflow;
    if (!wf) return;
    const frame = captureFrame();

    const userId = uid();
    st.pushReplayMessage({ id: userId, role: "user", text, image: frame ?? undefined, ts: Date.now() });

    const history: LLMMessage[] = st.replayLog
      .filter((e): e is Extract<typeof e, { type: "msg" }> => e.type === "msg" && !e.msg.error && !!e.msg.text.trim())
      .slice(-10)
      .map((e) => ({ role: e.msg.role, content: e.msg.text }));

    const last: LLMMessagePart[] = [textPart(text)];
    if (frame) last.push(imagePart(frame));
    history.push({ role: "user", content: last });

    const asstId = uid();
    st.pushReplayMessage({ id: asstId, role: "assistant", text: "", ts: Date.now(), streaming: true });
    try {
      await streamChat({
        system: REPLAY_CHAT_SYSTEM,
        messages: history,
        onDelta: (d) => useAppStore.getState().appendReplayMessage(asstId, d),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "LLM call failed";
      useAppStore.getState().patchReplayMessage(asstId, { text: `LLM call failed: ${message}`, error: true });
    }
    useAppStore.getState().patchReplayMessage(asstId, { streaming: false });
  }
}

export const replayEngine = new ReplayEngine();
