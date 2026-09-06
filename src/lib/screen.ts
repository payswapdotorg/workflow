import type { LLMMessage, LLMMessagePart } from "./types";

/* ------------------------------------------------------------------ */
/* Live frame capture                                                  */
/* ------------------------------------------------------------------ */

let activeVideo: HTMLVideoElement | null = null;

/** Called by the ScreenStage component so captureFrame() always reads the visible <video>. */
export function setActiveVideoEl(el: HTMLVideoElement | null) {
  activeVideo = el;
}

/** Unregister on unmount — only clears if this element is still the active one. */
export function clearActiveVideoEl(el: HTMLVideoElement | null) {
  if (activeVideo === el) activeVideo = null;
}

/**
 * Snap the current frame of the shared screen into a JPEG data URL.
 * Returns null when no stream/video is ready.
 */
export function captureFrame(maxWidth = 1280, quality = 0.72): string | null {
  const video = activeVideo;
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Streaming LLM client (SSE over /api/chat)                           */
/* ------------------------------------------------------------------ */

export async function streamChat(opts: {
  system: string;
  messages: LLMMessage[];
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
  /** Max total wall-clock time for the whole stream (default 120s). */
  totalTimeoutMs?: number;
  /** Max silence between chunks before the stream is considered hung (default 45s). */
  idleTimeoutMs?: number;
}): Promise<string> {
  /* Watchdogs: a wedged SSE (open but silent) used to leave the UI stuck in
     "thinking…" forever — which also made Enter-to-send look dead because
     sends are blocked while the assistant is "thinking". These timeouts
     guarantee the stream always settles. */
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort);
  if (opts.signal?.aborted) controller.abort();

  const totalTimer = setTimeout(
    () => controller.abort(new DOMException("LLM stream timed out", "TimeoutError")),
    opts.totalTimeoutMs ?? 120_000
  );
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new DOMException("LLM stream stalled", "TimeoutError")),
      opts.idleTimeoutMs ?? 45_000
    );
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: opts.system, messages: opts.messages }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let msg = `LLM request failed (HTTP ${res.status})`;
      try {
        const j = await res.json();
        if (j?.error) msg = j.error;
      } catch {
        /* keep default */
      }
      throw new Error(msg);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Provider replied with a plain JSON completion
      const data = await res.json();
      const text: string = data?.choices?.[0]?.message?.content ?? "";
      if (text) opts.onDelta(text);
      return text;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    resetIdle();

    for (;;) {
      const { done, value } = await reader.read();
      resetIdle();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return full;
        try {
          const json = JSON.parse(payload);
          const delta: unknown = json?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            full += delta;
            opts.onDelta(delta);
          }
        } catch {
          /* ignore malformed keepalive lines */
        }
      }
    }
    return full;
  } catch (err) {
    /* translate abort-caused failures into readable errors */
    if (controller.signal.aborted && !opts.signal?.aborted) {
      const reason = controller.signal.reason;
      const detail = reason instanceof DOMException ? reason.message : "timed out";
      throw new Error(`LLM stream ${detail}. Please try again.`);
    }
    throw err;
  } finally {
    if (totalTimer) clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function textPart(text: string): LLMMessagePart {
  return { type: "text", text };
}

export function imagePart(dataUrl: string): LLMMessagePart {
  return { type: "image_url", image_url: { url: dataUrl } };
}

export function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function supportsScreenCapture(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
}

export async function startScreenShare(): Promise<MediaStream> {
  if (!supportsScreenCapture()) {
    throw new Error(
      "Screen capture is not available in this context. Open TeachCast in its own browser tab (desktop Chrome, Edge or Firefox) and try again."
    );
  }
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 15 },
    audio: false,
  });
}
