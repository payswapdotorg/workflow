import { NextRequest } from "next/server";
import { getLiveBridge } from "@/lib/browser-bridge-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live browser stream — SSE downstream of the CDP screencast bridge.
 *
 * Events:
 *   event: state  {phase, url, detail}      — lifecycle + navigation
 *   event: frame  {frame, w, h, psf, ts}    — JPEG data-URL frames
 *
 * NOT wrapped in withRouteTimeout on purpose: this is a long-lived stream,
 * the same exemption /api/chat (SSE) carries. Liveness is enforced by the
 * heartbeat comment below (proxy keep-alive) and by the client, which falls
 * back to the snapshot mirror if frames stop arriving.
 */
export async function GET(req: NextRequest) {
  const bridge = getLiveBridge();
  const encoder = new TextEncoder();

  let closed = false;
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const unsubscribe = bridge.subscribe({
        onState: (s) => send("state", s),
        onFrame: (f) => send("frame", f),
      });

      /* greet the client with the current state immediately */
      send("state", bridge.status());

      const heartbeat = setInterval(() => write(`: keepalive ${Date.now()}\n\n`), 15_000);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal.addEventListener("abort", () => cleanup?.());
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
