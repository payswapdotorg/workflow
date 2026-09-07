/**
 * Managed-browser CDP bridge (operator live control).
 *
 * The operator's directive (2026-09-07): "you had to connect through a
 * websocket to the browser, that's how I was able to resolve the captcha for
 * you and log into chat.z.ai — with the current state of the replay, I can't
 * operate any browser since it doesn't show."
 *
 * This module is that websocket connection, kept honest about its lifecycle:
 *
 *  - discover() asks the agent-browser CLI for the managed session's CDP
 *    endpoint (`agent-browser --session teachcast-managed get cdp-url`).
 *  - connect() opens the CDP websocket, attaches to the session's page
 *    target (flat protocol) and starts a JPEG screencast of the viewport.
 *  - Frames are broadcast to subscribers (the SSE route) — coalesced so a
 *    repaint burst never floods the operator.
 *  - input() forwards operator mouse/keyboard onto the page through the CDP
 *    Input domain: clicks, drags, wheel, full key events and insertText.
 *  - The bridge self-heals: websocket death or a browser relaunch re-runs
 *    discovery (the CDP port changes on relaunch) while subscribers remain.
 *  - Zero subscribers for the idle window tears the screencast down; a CLI
 *    keepalive ping keeps the managed daemon from idle-exiting while the
 *    operator is actually watching.
 *
 * Dependency-injectable like browser-tool.ts: createBrowserBridge takes the
 * CLI discovery, the socket factory and the keepalive ping as dependencies,
 * so tests script every state transition. Node builtins only, no path
 * aliases — tests import this file directly under TS type stripping.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(cb: () => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
  onMessage(cb: (data: string) => void): void;
}

export interface BridgeFrame {
  /** data:image/jpeg;base64,... — ready for an <img> src */
  frame: string;
  /** remote viewport width in device pixels (screencast metadata) */
  w: number;
  /** remote viewport height in device pixels */
  h: number;
  /** page scale factor (1 in plain headless) */
  psf: number;
  ts: number;
}

export interface BridgeState {
  phase: "idle" | "connecting" | "connected" | "retrying";
  url: string | null;
  detail: string | null;
}

export interface BridgeSubscriber {
  onFrame?: (f: BridgeFrame) => void;
  onState?: (s: BridgeState) => void;
}

export type WireInput =
  | { kind: "click" | "dblclick" | "rightclick"; x: number; y: number }
  | { kind: "down" | "up"; x: number; y: number; button?: "left" | "right"; count?: number }
  | { kind: "move"; x: number; y: number; buttons?: number }
  | { kind: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; key: string; code: string; vk: number | null; modifiers?: number; text?: string | null }
  | { kind: "keycombo"; key: string; code: string; vk: number | null; modifiers?: number }
  | { kind: "text"; text: string };

export interface InputResult {
  ok: boolean;
  error?: string;
}

export interface BridgeTarget {
  /** The managed browser's CDP websocket endpoint. */
  cdpUrl: string;
  /** The CLI's ACTIVE tab URL — the page the operator's commands act on.
  *  Attaching to any other tab shows the operator the wrong browser. */
  pageUrl: string | null;
}

export interface BridgeDeps {
  /** Resolve the managed browser's CDP endpoint + active page (null = not running). */
  discover: () => Promise<BridgeTarget | null>;
  /** Open a socket to the CDP endpoint (not yet attached); may be async so
   *  the production wiring can lazily load a fallback socket library. */
  connect: (cdpUrl: string) => BridgeSocket | Promise<BridgeSocket>;
  /** Optional daemon-keepalive ping (a cheap CLI read counts as activity). */
  keepalive?: () => void;
  log?: (...args: unknown[]) => void;
  /** Reconnect cadence while a subscriber is waiting (default 3000ms). */
  retryMs?: number;
  /** Tear-down delay after the last subscriber leaves (default 90000ms). */
  idleDisconnectMs?: number;
  /** Keepalive cadence while connected (default 300000ms). */
  keepaliveMs?: number;
  /** Min spacing between broadcast frames (default 80ms). */
  frameMinIntervalMs?: number;
  /** Per-command response timeout (default 10000ms). */
  cmdTimeoutMs?: number;
}

interface CdpEvent {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
  sessionId?: string;
}

const MOUSE_BUTTON_CODE: Record<string, string> = { left: "left", right: "right", middle: "middle" };
const MOUSE_BUTTON_MASK: Record<string, number> = { left: 1, right: 2, middle: 4 };

/** Timers must never keep the host process alive (node --test exits clean). */
function unref(t: unknown): void {
  (t as { unref?: () => void } | undefined | null)?.unref?.();
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createBrowserBridge(deps: BridgeDeps) {
  const log = deps.log ?? (() => {});
  const retryMs = deps.retryMs ?? 3_000;
  const idleDisconnectMs = deps.idleDisconnectMs ?? 90_000;
  const keepaliveMs = deps.keepaliveMs ?? 300_000;
  const frameMinIntervalMs = deps.frameMinIntervalMs ?? 80;
  const cmdTimeoutMs = deps.cmdTimeoutMs ?? 10_000;

  let phase: BridgeState["phase"] = "idle";
  let stateUrl: string | null = null;
  let stateDetail: string | null = null;
  let socket: BridgeSocket | null = null;
  let pageSessionId: string | null = null;
  let nextCmdId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  const subscribers = new Set<BridgeSubscriber>();

  /* frame coalescing: latest frame wins, min spacing between broadcasts */
  let lastFrameSentAt = 0;
  let pendingFrame: BridgeFrame | null = null;
  let pendingFrameTimer: ReturnType<typeof setTimeout> | null = null;

  /* lifecycle timers */
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  let ensureRunning = false;
  let stopped = false;

  /* ---------------------------------------------------------------- */

  function snapshotState(): BridgeState {
    return { phase, url: stateUrl, detail: stateDetail };
  }

  function notifyState() {
    const s = snapshotState();
    for (const sub of subscribers) sub.onState?.(s);
  }

  function setState(next: BridgeState["phase"], detail: string | null) {
    phase = next;
    stateDetail = detail;
    notifyState();
  }

  /* the latest delivered frame — a new subscriber (page load, view switch,
     reconnect) sees the browser IMMEDIATELY, even while the remote page is
     static and generating no repaint events */
  let lastFrame: BridgeFrame | null = null;

  function broadcastFrame(f: BridgeFrame) {
    lastFrame = f;
    for (const sub of subscribers) sub.onFrame?.(f);
  }

  function scheduleFrame(f: BridgeFrame) {
    const now = Date.now();
    if (pendingFrameTimer === null && now - lastFrameSentAt >= frameMinIntervalMs) {
      lastFrameSentAt = now;
      broadcastFrame(f);
      return;
    }
    pendingFrame = f;
    if (pendingFrameTimer === null) {
      pendingFrameTimer = setTimeout(() => {
        pendingFrameTimer = null;
        if (pendingFrame) {
          lastFrameSentAt = Date.now();
          broadcastFrame(pendingFrame);
          pendingFrame = null;
        }
      }, Math.max(16, frameMinIntervalMs - (now - lastFrameSentAt)));
      unref(pendingFrameTimer);
    }
  }

  /* ---------------- command correlation ---------------- */

  function send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (!socket) return Promise.reject(new Error("bridge socket is closed"));
    const id = nextCmdId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, cmdTimeoutMs);
      unref(timer);
      pending.set(id, { resolve, reject, timer });
      const msg: CdpEvent = { id, method, params: params ?? {} };
      if (sessionId) msg.sessionId = sessionId;
      socket?.send(JSON.stringify(msg));
    });
  }

  /* ---------------- attach + screencast ---------------- */

  async function attachAndStream(activeUrl: string | null): Promise<void> {
    const targets = (await send("Target.getTargets")) as { targetInfos?: Array<Record<string, unknown>> };
    const pages = (targets.targetInfos ?? []).filter((t) => t.type === "page");
    const scored = pages
      .map((t) => ({ t, url: String(t.url ?? "") }))
      .sort((a, b) => score(b.url) - score(a.url));
    /* THE LAW: the CLI's active tab wins — it is the surface the operator's
       commands (console chat, exec runs) actually drive. Scored fallback only
       when the active URL is unknown or matches nothing. */
    const match = activeUrl ? scored.find((s) => s.url === activeUrl) : undefined;
    const best = match ?? scored[0];
    if (!best || !best.t.targetId) throw new Error("no page target in the managed browser");

    const attached = (await send("Target.attachToTarget", { targetId: best.t.targetId, flatten: true })) as { sessionId?: string };
    if (!attached?.sessionId) throw new Error("Target.attachToTarget returned no sessionId");
    pageSessionId = attached.sessionId;
    await send("Page.enable", {}, pageSessionId);
    await send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 }, pageSessionId);
    if (typeof best.url === "string" && /^https?:/.test(best.url)) {
      stateUrl = best.url;
    }
    setState("connected", null);
    log("[browser-bridge] attached to", best.url, "— screencast live");

    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => deps.keepalive?.(), keepaliveMs);
    unref(keepaliveTimer);
  }

  /* prefer a real page the operator/CLI is on: http(s) first, newest wins */
  function score(url: string): number {
    if (/^https?:\/\//i.test(url) && !/^https?:\/\/(localhost|127\.)/i.test(url)) return 4;
    if (/^https?:\/\//i.test(url)) return 3;
    if (url === "about:blank") return 1;
    return url ? 2 : 0;
  }

  /* ---------------- socket lifecycle ---------------- */

  function teardownSocket(reason: string) {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`bridge closed: ${reason}`));
    }
    pending.clear();
    pageSessionId = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* best effort */
      }
      socket = null;
    }
  }

  function handleEvent(msg: CdpEvent) {
    const method = msg.method ?? "";
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (method === "Page.screencastFrame") {
      const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : pageSessionId ?? undefined;
      const data = String(params.data ?? "");
      const meta = (params.metadata ?? {}) as Record<string, unknown>;
      if (data && sessionId) {
        /* the ack MUST be session-scoped or Chrome stops sending frames */
        void send("Page.screencastFrameAck", {}, sessionId).catch(() => {});
        scheduleFrame({
          frame: `data:image/jpeg;base64,${data}`,
          w: Number(meta.deviceWidth ?? 0) || 1280,
          h: Number(meta.deviceHeight ?? 0) || 720,
          psf: Number(meta.pageScaleFactor ?? 1) || 1,
          ts: Date.now(),
        });
      }
      return;
    }
    if (method === "Page.frameNavigated") {
      const frame = (params.frame ?? {}) as Record<string, unknown>;
      if (frame.parentId === undefined) {
        const url = String(frame.url ?? "");
        if (url && url !== stateUrl) {
          stateUrl = url;
          notifyState();
        }
      }
      return;
    }
    if (method === "Target.targetDestroyed" || method === "Target.targetCrashed") {
      /* our page target died (tab closed / browser relaunch) — reconnect */
      scheduleReconnect("page target gone");
    }
  }

  function onSocketMessage(data: string) {
    let msg: CdpEvent;
    try {
      msg = JSON.parse(data) as CdpEvent;
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(String(msg.error.message ?? "CDP error")));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) handleEvent(msg);
  }

  function onSocketDead(detail: string) {
    if (phase !== "connected" && phase !== "connecting") return;
    teardownSocket(detail);
    scheduleReconnect(detail);
  }

  function scheduleReconnect(detail: string) {
    teardownSocket(detail);
    if (stopped) {
      setState("idle", null);
      return;
    }
    if (subscribers.size === 0) {
      setState("idle", detail);
      return;
    }
    setState("retrying", detail);
    if (retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void ensure();
      }, retryMs);
      unref(retryTimer);
    }
  }

  /* ---------------- ensure loop ---------------- */

  async function ensure(): Promise<void> {
    if (stopped || ensureRunning) return;
    if (subscribers.size === 0) return;
    ensureRunning = true;
    try {
      if (socket && phase === "connected") return;
      if (phase !== "idle" && phase !== "retrying") return;
      setState("connecting", null);

      const target = await deps.discover();
      if (!target) {
        setState("retrying", "managed browser not connected (console → Connect chat.z.ai)");
        if (retryTimer === null) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void ensure();
          }, retryMs);
          unref(retryTimer);
        }
        return;
      }

      const sock = await deps.connect(target.cdpUrl);
      socket = sock;
      sock.onMessage((d) => onSocketMessage(d));
      sock.onError((err) => {
        log("[browser-bridge] socket error", err);
        onSocketDead(String((err as Error)?.message ?? err ?? "socket error"));
      });
      sock.onClose(() => onSocketDead("cdp socket closed"));
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("cdp connect timeout")), cmdTimeoutMs);
        unref(t);
        sock.onOpen(() => {
          clearTimeout(t);
          resolve();
        });
        /* if the socket dies before open, onClose already scheduled the
           reconnect; resolve so this attempt unwinds cleanly */
        sock.onClose(() => {
          clearTimeout(t);
          resolve();
        });
      });
      if (!socket || socket !== sock) return; /* superseded or died pre-open */
      await attachAndStream(target.pageUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scheduleReconnect(message);
    } finally {
      ensureRunning = false;
    }
  }

  function armIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (subscribers.size === 0) {
        stopped = false;
        teardownSocket("idle: no subscribers");
        phase = "idle";
        stateUrl = null;
        stateDetail = null;
        notifyState();
        log("[browser-bridge] idle disconnect — screencast stopped");
      }
    }, idleDisconnectMs);
    unref(idleTimer);
  }

  /* ---------------- input ---------------- */

  function mousePressRelease(kind: "click" | "dblclick" | "rightclick" | "down" | "up", x: number, y: number, button: "left" | "right", count = 1): Array<["mousePressed" | "mouseReleased" | "mouseMoved", Record<string, unknown>]> {
    const mask = MOUSE_BUTTON_MASK[button];
    const code = MOUSE_BUTTON_CODE[button];
    const calls: Array<["mousePressed" | "mouseReleased" | "mouseMoved", Record<string, unknown>]> = [];
    if (kind === "down") {
      calls.push(["mousePressed", { x, y, button: code, buttons: mask, clickCount: count }]);
    } else if (kind === "up") {
      calls.push(["mouseReleased", { x, y, button: code, buttons: 0, clickCount: count }]);
    } else if (kind === "dblclick") {
      calls.push(["mousePressed", { x, y, button: code, buttons: mask, clickCount: 1 }]);
      calls.push(["mouseReleased", { x, y, button: code, buttons: 0, clickCount: 1 }]);
      calls.push(["mousePressed", { x, y, button: code, buttons: mask, clickCount: 2 }]);
      calls.push(["mouseReleased", { x, y, button: code, buttons: 0, clickCount: 2 }]);
    } else {
      const b = kind === "rightclick" ? "right" : "left";
      const btn = MOUSE_BUTTON_CODE[b];
      const m = MOUSE_BUTTON_MASK[b];
      calls.push(["mousePressed", { x, y, button: btn, buttons: m, clickCount: count }]);
      calls.push(["mouseReleased", { x, y, button: btn, buttons: 0, clickCount: count }]);
    }
    return calls;
  }

  async function input(evt: WireInput): Promise<InputResult> {
    if (phase !== "connected" || !socket) {
      return { ok: false, error: "managed browser not connected" };
    }
    try {
      switch (evt.kind) {
        case "click":
        case "dblclick":
        case "rightclick":
        case "down":
        case "up": {
          let button: "left" | "right" = "left";
          if (evt.kind === "rightclick") button = "right";
          if ((evt.kind === "down" || evt.kind === "up") && evt.button === "right") button = "right";
          const count = evt.kind === "down" || evt.kind === "up" ? Math.max(1, Math.min(3, Math.round(evt.count ?? 1))) : 1;
          for (const [type, params] of mousePressRelease(evt.kind, evt.x, evt.y, button, count)) {
            await send("Input.dispatchMouseEvent", { type, ...params }, pageSessionId ?? undefined);
          }
          return { ok: true };
        }
        case "move": {
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: evt.x, y: evt.y, button: "none", buttons: evt.buttons ?? 0 }, pageSessionId ?? undefined);
          return { ok: true };
        }
        case "scroll": {
          await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: evt.x, y: evt.y, button: "none", buttons: 0, deltaX: evt.deltaX, deltaY: evt.deltaY }, pageSessionId ?? undefined);
          return { ok: true };
        }
        case "key": {
          const vk = evt.vk ?? 0;
          const down: Record<string, unknown> = { type: "keyDown", key: evt.key, code: evt.code || evt.key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: evt.modifiers ?? 0 };
          if (evt.text) down.text = evt.text;
          await send("Input.dispatchKeyEvent", down, pageSessionId ?? undefined);
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: evt.key, code: evt.code || evt.key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: evt.modifiers ?? 0 }, pageSessionId ?? undefined);
          return { ok: true };
        }
        case "keycombo": {
          const vk = evt.vk ?? 0;
          await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: evt.key, code: evt.code || evt.key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: evt.modifiers ?? 0 }, pageSessionId ?? undefined);
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: evt.key, code: evt.code || evt.key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: evt.modifiers ?? 0 }, pageSessionId ?? undefined);
          return { ok: true };
        }
        case "text": {
          await send("Input.insertText", { text: evt.text }, pageSessionId ?? undefined);
          return { ok: true };
        }
        default:
          return { ok: false, error: "unknown input kind" };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scheduleReconnect(message);
      return { ok: false, error: message };
    }
  }

  /* ---------------- public surface ---------------- */

  function subscribe(sub: BridgeSubscriber): () => void {
    subscribers.add(sub);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    stopped = false;
    sub.onState?.(snapshotState());
    /* instant first paint: hand the newcomer the last live frame */
    if (lastFrame) sub.onFrame?.(lastFrame);
    void ensure();
    return () => {
      subscribers.delete(sub);
      if (subscribers.size === 0) armIdleTimer();
    };
  }

  function stop() {
    stopped = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (pendingFrameTimer) {
      clearTimeout(pendingFrameTimer);
      pendingFrameTimer = null;
    }
    pendingFrame = null;
    teardownSocket("stopped");
    phase = "idle";
    stateUrl = null;
    stateDetail = null;
    notifyState();
  }

  return {
    /* subscribe returns the unsubscribe function */
    subscribe,
    input,
    status: snapshotState,
    stop,
  };
}

export type BrowserBridge = ReturnType<typeof createBrowserBridge>;
