export type View = "session" | "library" | "replay" | "settings";

export type StepKind = "message" | "snapshot" | "action";

/** Free-form per-kind payload. `image` is a JPEG data URL captured from the live screen. */
export interface StepPayload {
  text?: string;
  image?: string;
  note?: string;
}

/** M7 action step — a taught click/keystroke with its capture-space context.
 *  x/y are NORMALIZED (0..1) hints from the demonstration; on execution they
 *  are RE-RESOLVED against a fresh snapshot (never blindly replayed). `thumb`
 *  is the frame grabbed at teaching time — the visual context the executor
 *  re-grounds against. */
export interface ActionStepPayload {
  actionType: "click" | "type";
  x?: number;
  y?: number;
  text?: string;
  label: string;
  thumb?: string | null;
}

/** Step {kind: message|snapshot|action, payload, ts} */
export interface StepDTO {
  id: string;
  kind: StepKind;
  payload: StepPayload & Partial<ActionStepPayload>;
  ts: string;
  order: number;
}

/** Step as recorded live in a teaching session (before it belongs to a workflow). */
export interface RecordedStep {
  id: string;
  kind: StepKind;
  payload: StepPayload & Partial<ActionStepPayload>;
  ts: string;
}

export interface WorkflowSummaryDTO {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  autoLaunch: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  stepCount: number;
}

export interface WorkflowDTO {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  autoLaunch: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  steps: StepDTO[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  image?: string;
  ts: number;
  streaming?: boolean;
  error?: boolean;
  /** Agent tool activity performed by the assistant while producing this message. */
  toolCalls?: ToolEvent[];
}

/** A real agent tool execution (file read/write, shell, browser control, code run). */
export interface ToolEvent {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  output?: string;
  status: "running" | "done";
}

export interface SettingsDTO {
  endpoint: string;
  model: string;
  hasKey: boolean;
  keyMasked: string | null;
  usingFallback: boolean;
}

export interface CompiledStep {
  index: number;
  instruction: string;
}

export interface CompileResult {
  name: string;
  description: string;
  steps: CompiledStep[];
}

/** OpenAI chat content part (schema-compatible subset). */
export interface LLMMessagePart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | LLMMessagePart[];
}

export type ReplayStatus = "idle" | "running" | "paused" | "finished" | "stopped";

/* ------------------------------------------------------------------ */
/* Long-running session health (watchdog-driven)                       */
/* ------------------------------------------------------------------ */

export type SessionHealthState = "idle" | "streaming" | "hung";

/** Live snapshot of the session watchdog, rendered by the status panel. */
export interface SessionHealthSnapshot {
  state: SessionHealthState;
  /** Which surface owns the active turn: "session" | "replay" | "console". */
  kind: string | null;
  startedTs: number | null;
  lastActivityTs: number | null;
  hangThresholdMs: number;
  lastRecoveryTs: number | null;
  /** True when the watchdog suppressed an auto-reload because a recovery ran recently. */
  suppressed: boolean;
}

/** Boot-time recovery payload (written before a watchdog reload, consumed on boot). */
export interface RecoveryRecord {
  kind: string;
  text: string;
  resubmit: boolean;
  ts: number;
}

/* ------------------------------------------------------------------ */
/* Managed external session (M4 — chat.z.ai supervised from the console)*/
/* ------------------------------------------------------------------ */

export interface ManagedSessionStatus {
  active: boolean;
  url: string | null;
  /** Live page title of the managed browser (empty until connected). */
  title: string | null;
  /** Latest a11y text snapshot of the managed page. */
  snapshot: string | null;
  /** Latest REAL frame of the managed page (PNG screenshot as data URL). */
  frame: string | null;
  snapshotAt: string | null;
  error: string | null;
}

export type ReplayLogEntry =
  | { id: string; type: "step"; step: StepDTO; stepIndex: number; done: boolean }
  | { id: string; type: "msg"; msg: ChatMessage };

/* ------------------------------------------------------------------ */
/* M7 — workflow execution on the managed browser (/api/execute)       */
/* ------------------------------------------------------------------ */

export type ExecLogEntry =
  | { id: string; type: "step"; index: number; total: number; label: string; status: "running" | "done" | "skipped" | "failed"; detail?: string }
  | { id: string; type: "msg"; role: "assistant"; text: string };

export interface ExecRunState {
  workflowId: string;
  workflowName: string;
  status: "running" | "finished" | "failed" | "aborted";
  startedAt: number;
  log: ExecLogEntry[];
}

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function stepInstruction(step: StepDTO | RecordedStep): string {
  if (step.kind === "action") return (step.payload as Partial<ActionStepPayload>).label || step.payload.text || "Taught action";
  return step.payload.text || step.payload.note || (step.kind === "snapshot" ? "Visual checkpoint" : "");
}
