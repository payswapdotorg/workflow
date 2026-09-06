export type View = "session" | "library" | "replay" | "settings";

export type StepKind = "message" | "snapshot";

/** Free-form per-kind payload. `image` is a JPEG data URL captured from the live screen. */
export interface StepPayload {
  text?: string;
  image?: string;
  note?: string;
}

/** Step {kind: message|snapshot, payload, ts} */
export interface StepDTO {
  id: string;
  kind: StepKind;
  payload: StepPayload;
  ts: string;
  order: number;
}

/** Step as recorded live in a teaching session (before it belongs to a workflow). */
export interface RecordedStep {
  id: string;
  kind: StepKind;
  payload: StepPayload;
  ts: string;
}

export interface WorkflowSummaryDTO {
  id: string;
  name: string;
  description: string;
  installed: boolean;
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

export type ReplayLogEntry =
  | { id: string; type: "step"; step: StepDTO; stepIndex: number; done: boolean }
  | { id: string; type: "msg"; msg: ChatMessage };

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function stepInstruction(step: StepDTO | RecordedStep): string {
  return step.payload.text || step.payload.note || (step.kind === "snapshot" ? "Visual checkpoint" : "");
}
