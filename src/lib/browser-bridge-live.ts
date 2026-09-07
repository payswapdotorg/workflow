/**
 * Production wiring for the managed-browser CDP bridge.
 *
 * discover:  `agent-browser --session teachcast-managed get cdp-url`
 * connect:   the NATIVE WebSocket first (Bun and Node 22+ both ship one —
 *            a bundled `ws` under Bun's Next standalone server mishandles
 *            the 101 upgrade), with the real `ws` package (kept external,
 *            never bundled) as the fallback for older Node.
 * keepalive: a cheap CLI read every 5 minutes — dashboard/CLI activity is
 *            what keeps the agent-browser daemon from idle-exiting while the
 *            operator is watching the stage.
 *
 * The bridge itself (src/lib/browser-bridge.ts) is dependency-injected and
 * unit-tested; this module only supplies real dependencies and the singleton.
 */
import { execFile } from "child_process";
import { createBrowserBridge, type BrowserBridge, type BridgeSocket, type BridgeTarget } from "@/lib/browser-bridge";
import { MANAGED_BROWSER_SESSION } from "@/lib/tools";

function runCli(args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "agent-browser",
      ["--session", MANAGED_BROWSER_SESSION, ...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        resolve({ ok: !err, output: out });
      }
    );
  });
}

/** The managed session's CDP endpoint + the CLI's ACTIVE tab URL (the page
 *  the operator's console/exec commands actually drive), or null when the
 *  managed browser is not running. */
async function discover(): Promise<BridgeTarget | null> {
  const [cdp, page] = await Promise.all([runCli(["get", "cdp-url"], 10_000), runCli(["get", "url"], 10_000)]);
  const m = cdp.output.match(/ws:\/\/\S+/);
  if (!m) return null;
  const pageUrl = page.ok && page.output.trim() ? page.output.split("\n")[0].trim().slice(0, 2000) : null;
  return { cdpUrl: m[0], pageUrl };
}

/** A keepalive ping (a cheap CLI read counts as daemon activity). */
function keepalive(): void {
  void runCli(["get", "url"], 15_000);
}

/* ------------------------------------------------------------------ */
/* Socket adapters — both satisfy BridgeSocket                          */
/* ------------------------------------------------------------------ */

type MessageLike = { data: unknown };

/** Adapter over the WHATWG WebSocket (Bun / Node 22+ native). */
function connectNative(Native: new (url: string) => WebSocket, cdpUrl: string): BridgeSocket {
  const w = new Native(cdpUrl);
  try {
    w.binaryType = "arraybuffer";
  } catch {
    /* binaryType is advisory; CDP speaks text frames */
  }
  const open: Array<() => void> = [];
  const close: Array<() => void> = [];
  const error: Array<(err: unknown) => void> = [];
  const message: Array<(data: string) => void> = [];
  w.addEventListener("open", () => open.forEach((cb) => cb()));
  w.addEventListener("close", () => close.forEach((cb) => cb()));
  w.addEventListener("error", (ev) => error.forEach((cb) => cb((ev as ErrorEvent)?.error ?? new Error("native websocket error"))));
  w.addEventListener("message", (ev) => {
    const d = (ev as MessageEvent).data as unknown;
    if (typeof d === "string") {
      message.forEach((cb) => cb(d));
    } else if (d instanceof ArrayBuffer) {
      const text = Buffer.from(d).toString("utf8");
      message.forEach((cb) => cb(text));
    } else if (d && typeof (d as { arrayBuffer?: unknown }).arrayBuffer === "function") {
      (d as { arrayBuffer: () => Promise<ArrayBuffer> })
        .arrayBuffer()
        .then((ab) => {
          const text = Buffer.from(ab).toString("utf8");
          message.forEach((cb) => cb(text));
        })
        .catch(() => {});
    }
  });
  return {
    send: (data) => w.send(data),
    close: (code, reason) => {
      try {
        w.close(code, reason);
      } catch {
        /* already closing */
      }
    },
    onOpen: (cb) => open.push(cb),
    onClose: (cb) => close.push(cb),
    onError: (cb) => error.push(cb),
    onMessage: (cb) => message.push(cb),
  };
}

/** Adapter over the `ws` package (external — see next.config.ts). */
function connectWsPackage(WebSocketCtor: new (url: string, opts?: Record<string, unknown>) => { on(ev: string, cb: (...args: unknown[]) => void): void; send(data: string): void; close(code?: number, reason?: string): void }, cdpUrl: string): BridgeSocket {
  const ws = new WebSocketCtor(cdpUrl, { perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = { open: [], close: [], error: [], message: [] };
  ws.on("open", () => handlers.open.forEach((cb) => cb()));
  ws.on("close", () => handlers.close.forEach((cb) => cb()));
  ws.on("error", (err) => handlers.error.forEach((cb) => cb(err)));
  ws.on("message", (data) => {
    const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
    handlers.message.forEach((cb) => cb(text));
  });
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        /* already closing */
      }
    },
    onOpen: (cb) => handlers.open.push(cb as (...args: unknown[]) => void),
    onClose: (cb) => handlers.close.push(cb as (...args: unknown[]) => void),
    onError: (cb) => handlers.error.push(cb as (...args: unknown[]) => void),
    onMessage: (cb) => handlers.message.push(cb as (...args: unknown[]) => void),
  };
}

async function connect(cdpUrl: string): Promise<BridgeSocket> {
  const Native = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof Native === "function") {
    return connectNative(Native as unknown as new (url: string) => WebSocket, cdpUrl);
  }
  const { default: WebSocketCtor } = await import("ws");
  return connectWsPackage(WebSocketCtor as unknown as new (url: string, opts?: Record<string, unknown>) => { on(ev: string, cb: (...args: unknown[]) => void): void; send(data: string): void; close(code?: number, reason?: string): void }, cdpUrl);
}

let live: BrowserBridge | null = null;

/** The singleton bridge used by /api/browser-live and /api/browser-input. */
export function getLiveBridge(): BrowserBridge {
  if (!live) {
    live = createBrowserBridge({
      discover,
      connect,
      keepalive,
      log: (...args) => console.log(...args),
    });
  }
  return live;
}
