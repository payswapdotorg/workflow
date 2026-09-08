import { create } from "zustand";
import type {
  BuildInfo,
  BuildPhase,
  ChatMessage,
  ChatSummary,
  StatusResponse,
} from "@/lib/types";

interface TeachCastState {
  chats: ChatSummary[];
  activeChatId: string | null;
  messages: ChatMessage[];
  chatsLoading: boolean;
  threadLoading: boolean;
  sending: boolean;
  error: string | null;
  build: BuildInfo | null;
  init: () => Promise<void>;
  selectChat: (id: string) => Promise<void>;
  createChat: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  refreshChats: () => Promise<void>;
  refreshMessages: (chatId: string) => Promise<void>;
  clearError: () => void;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const useTeachCast = create<TeachCastState>()((set, get) => {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollChatId: string | null = null;
  let lastPhase: BuildPhase | null = null;

  function isActivePhase(phase: BuildPhase): boolean {
    return phase !== "ready" && phase !== "error";
  }

  function stopPolling() {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
    pollChatId = null;
    lastPhase = null;
  }

  async function tickPolling(chatId: string): Promise<void> {
    if (pollChatId !== chatId) return;
    let status: StatusResponse;
    try {
      status = await fetchJson<StatusResponse>(`/api/teachcast-status?chatId=${chatId}`);
    } catch {
      return; // transient poll failure; next tick retries
    }
    if (pollChatId !== chatId) return;

    const nextBuild: BuildInfo | null = status.hasBuild
      ? {
          phase: status.phase,
          detail: status.detail,
          progress: status.progress,
          slug: status.slug ?? null,
          updatedAt: status.updatedAt ?? null,
        }
      : null;
    const current = get().build;
    const unchanged =
      current === null || nextBuild === null
        ? current === nextBuild
        : current.phase === nextBuild.phase &&
          current.progress === nextBuild.progress &&
          current.detail === nextBuild.detail &&
          current.slug === nextBuild.slug;
    if (!unchanged) set({ build: nextBuild });

    const phaseChanged = status.phase !== lastPhase;
    if (isActivePhase(status.phase) || (phaseChanged && status.hasBuild)) {
      await get().refreshMessages(chatId);
    }
    if (phaseChanged) {
      lastPhase = status.phase;
      await get().refreshChats();
    }
  }

  function startPolling(chatId: string) {
    if (pollChatId === chatId && pollTimer !== null) return;
    if (pollTimer !== null) clearInterval(pollTimer);
    pollChatId = chatId;
    lastPhase = null;
    pollTimer = setInterval(() => void tickPolling(chatId), 1000);
    void tickPolling(chatId);
  }

  return {
    chats: [],
    activeChatId: null,
    messages: [],
    chatsLoading: true,
    threadLoading: false,
    sending: false,
    error: null,
    build: null,

    init: async () => {
      try {
        const data = await fetchJson<{ chats: ChatSummary[] }>("/api/chats");
        set({ chats: data.chats, chatsLoading: false });
        if (data.chats.length > 0) await get().selectChat(data.chats[0].id);
      } catch {
        set({
          chatsLoading: false,
          error: "Could not load your chats — check the dev server and retry.",
        });
      }
    },

    selectChat: async (id) => {
      stopPolling();
      set({ activeChatId: id, messages: [], build: null, threadLoading: true, error: null });
      try {
        const data = await fetchJson<{ chat: ChatSummary; messages: ChatMessage[] }>(
          `/api/chats/${id}/messages`
        );
        set({ messages: data.messages, build: data.chat.build, threadLoading: false });
      } catch {
        set({ threadLoading: false, error: "Could not load this conversation." });
      }
      startPolling(id);
    },

    createChat: async () => {
      try {
        const data = await fetchJson<{ chat: ChatSummary }>("/api/chats", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        stopPolling();
        set({
          chats: [data.chat, ...get().chats],
          activeChatId: data.chat.id,
          messages: [],
          build: null,
          threadLoading: false,
          error: null,
        });
        startPolling(data.chat.id);
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : "Could not start a new chat.",
        });
      }
    },

    sendMessage: async (text) => {
      const { activeChatId, sending } = get();
      const trimmed = text.trim();
      if (!activeChatId || trimmed.length === 0 || sending) return;
      const optimistic: ChatMessage = {
        id: `pending-${Date.now()}`,
        role: "user",
        text: trimmed,
        createdAt: new Date().toISOString(),
      };
      set({ sending: true, error: null, messages: [...get().messages, optimistic] });
      try {
        const data = await fetchJson<{ message: ChatMessage }>(
          `/api/chats/${activeChatId}/messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: trimmed }),
          }
        );
        set({
          messages: get().messages.map((m) => (m.id === optimistic.id ? data.message : m)),
        });
        lastPhase = null; // a new prompt restarts the phase machine for this chat
        await get().refreshChats();
      } catch (error) {
        set({
          messages: get().messages.filter((m) => m.id !== optimistic.id),
          error: error instanceof Error ? error.message : "Could not send the message.",
        });
      } finally {
        set({ sending: false });
      }
    },

    refreshChats: async () => {
      try {
        const data = await fetchJson<{ chats: ChatSummary[] }>("/api/chats");
        set({ chats: data.chats });
      } catch {
        // transient — the next poll retries
      }
    },

    refreshMessages: async (chatId) => {
      if (get().activeChatId !== chatId) return;
      try {
        const data = await fetchJson<{ chat: ChatSummary; messages: ChatMessage[] }>(
          `/api/chats/${chatId}/messages`
        );
        const pending = get().messages.filter((m) => m.id.startsWith("pending-"));
        set({ messages: [...data.messages, ...pending] });
      } catch {
        // transient — the next poll retries
      }
    },

    clearError: () => set({ error: null }),
  };
});
