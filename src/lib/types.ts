export type BuildPhase =
  | "analyzing"
  | "scaffolding"
  | "building"
  | "verifying"
  | "ready"
  | "error";

export interface BuildInfo {
  phase: BuildPhase;
  detail: string;
  progress: number;
  slug: string | null;
  updatedAt: string | null;
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  build: BuildInfo | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  createdAt: string;
}

export interface StatusResponse {
  phase: BuildPhase;
  detail: string;
  progress: number;
  chatId?: string;
  hasBuild: boolean;
  slug?: string | null;
  updatedAt?: string | null;
  publishedUrl?: string;
}
