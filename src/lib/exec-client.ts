"use client";

/**
 * Execution-run client (M7) — pumps a POST /api/execute SSE run into the UI.
 *
 * Events land where they belong:
 *   exec   -> the store's execRun log (rendered in the chat panel)
 *   cursor -> the cursorBus (the LLM cursor overlay on the stage mirror)
 *
 * The run is user-abortable (AbortController) and every terminal state is
 * honest: the run log shows exactly what ran, what was skipped and what
 * failed, verbatim from the server.
 */

import { cursorBus, parseCursorEvent } from "./llm-cursor";
import { useAppStore } from "./store";
import { uid, type ExecLogEntry } from "./types";

let activeController: AbortController | null = null;

export function isExecRunning(): boolean {
  return !!activeController;
}

export function abortExecRun(): void {
  activeController?.abort();
  activeController = null;
}

/** Starts a run; resolves when the stream ends (the store carries the result). */
export async function startExecRun(workflowId: string, workflowName: string): Promise<void> {
  if (activeController) abortExecRun();

  const controller = new AbortController();
  activeController = controller;
  const store = useAppStore.getState();
  store.setExecRun({
    workflowId,
    workflowName,
    status: "running",
    startedAt: Date.now(),
    log: [{ id: uid(), type: "msg", role: "assistant", text: `Running “${workflowName}” on the managed browser — watch the amber cursor on the stage.` }],
  });

  try {
    const res = await fetch("/api/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => null);
      const message = data?.error || `Execution could not start (HTTP ${res.status})`;
      useAppStore.getState().patchExecRun({ status: "failed" });
      useAppStore.getState().pushExecLog({ id: uid(), type: "msg", role: "assistant", text: `Run failed to start: ${message}` });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const handleLine = (line: string) => {
      if (!line.startsWith("data: ")) return;
      const payload = line.slice(6);
      if (payload === "[DONE]") return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(payload);
      } catch {
        return;
      }
      const s = useAppStore.getState();
      if (ev.exec && typeof ev.exec === "object") {
        const e = ev.exec as Record<string, unknown>;
        if (e.type === "run") {
          s.pushExecLog({
            id: uid(),
            type: "msg",
            role: "assistant",
            text: `Surface: ${String(e.surface ?? "managed browser")} · ${String(e.total ?? "?")} step(s).`,
          });
        } else if (e.type === "step") {
          const status = e.status as "running" | "done" | "skipped" | "failed";
          const entry: ExecLogEntry = {
            id: uid(),
            type: "step",
            index: Number(e.index ?? 0),
            total: Number(e.total ?? 0),
            label: String(e.label ?? ""),
            status,
            detail: typeof e.detail === "string" ? e.detail : undefined,
          };
          if (status === "running") {
            /* replace any prior "running" row for this index instead of stacking */
            const log = (s.execRun?.log ?? []).filter(
              (l) => !(l.type === "step" && l.index === entry.index && l.status === "running")
            );
            useAppStore.setState((st) => (st.execRun ? { execRun: { ...st.execRun, log: [...log, entry] } } : {}));
          } else {
            s.pushExecLog(entry);
          }
        } else if (e.type === "note") {
          /* M8: throttle deferrals and other mid-run notices — visible in the
             run log, exactly as the server phrased them. */
          const text = String(e.text ?? "").trim();
          if (text) s.pushExecLog({ id: uid(), type: "msg", role: "assistant", text });
        } else if (e.type === "done") {
          const ok = e.ok === true;
          s.patchExecRun({ status: ok ? "finished" : "failed" });
          s.pushExecLog({
            id: uid(),
            type: "msg",
            role: "assistant",
            text: ok
              ? `Run finished: ${String(e.ran ?? 0)} executed, ${String(e.skipped ?? 0)} skipped.`
              : `Run FAILED: ${String(e.failed ?? 0)} step(s) failed, ${String(e.ran ?? 0)} executed, ${String(e.skipped ?? 0)} skipped${e.error ? ` — ${String(e.error)}` : ""}.`,
          });
        }
        return;
      }
      if (ev.cursor !== undefined) {
        const parsed = parseCursorEvent(ev.cursor);
        if (parsed) cursorBus.dispatch(parsed);
        return;
      }
      /* tool activity is folded into the step detail stream as plain lines —
         the full structured events stay available for debugging */
      if (ev.tool_result && typeof ev.tool_result === "object") {
        const t = ev.tool_result as { ok?: boolean; output?: string };
        if (t.ok === false && t.output) {
          s.pushExecLog({ id: uid(), type: "msg", role: "assistant", text: `tool error: ${t.output.slice(0, 240)}` });
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) handleLine(line);
      }
    }

    /* stream ended — make sure the run does not stay "running" */
    const s = useAppStore.getState();
    if (s.execRun?.status === "running") s.patchExecRun({ status: "failed" });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    const s = useAppStore.getState();
    if (s.execRun) {
      s.patchExecRun({ status: aborted ? "aborted" : "failed" });
      s.pushExecLog({
        id: uid(),
        type: "msg",
        role: "assistant",
        text: aborted ? "Run aborted by the operator." : `Run failed: ${err instanceof Error ? err.message : "stream error"}`,
      });
    }
  } finally {
    if (activeController === controller) activeController = null;
  }
}
