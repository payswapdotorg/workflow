/**
 * Unit tests for the managed-browser CDP bridge (src/lib/browser-bridge.ts).
 * Run: node --test tests/
 * The socket factory, CLI discovery and keepalive ping are injected, so the
 * full attach/screencast/input/reconnect lifecycle is exercised
 * deterministically against a scripted fake websocket that answers the
 * CDP handshake asynchronously (like a real socket).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserBridge } from "../src/lib/browser-bridge.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake BridgeSocket that records everything sent and — when `auto` is on —
 * answers the CDP handshake (getTargets / attachToTarget / Page.* / Input.*)
 * on a macrotask, exactly like a real websocket round-trip.
 */
class FakeSocket {
  constructor(pageUrl = "https://chat.z.ai/") {
    this.sent = [];
    this.openCbs = [];
    this.closeCbs = [];
    this.errorCbs = [];
    this.messageCbs = [];
    this.closed = false;
    this.auto = false;
    this.pageUrl = pageUrl;
    this.sessionId = "sess-1";
    /* the fake browser's tab strip: the ACTIVE page, a chrome://newtab
       (a real agent-browser Chrome carries both), and an iframe */
    this.targets = [
      { type: "page", targetId: "t1", url: pageUrl === "chrome://newtab/" ? "https://background.example/" : pageUrl },
      { type: "page", targetId: "tnewtab", url: "chrome://newtab/" },
      { type: "iframe", targetId: "t2", url: "https://x/" },
    ];
  }
  send(data) {
    const m = JSON.parse(data);
    this.sent.push(m);
    if (this.auto && typeof m.id === "number") {
      if (m.method === "Target.getTargets") {
        setTimeout(() => this.receive({ id: m.id, result: { targetInfos: this.targets } }), 0);
      } else if (m.method === "Target.attachToTarget") {
        setTimeout(() => this.receive({ id: m.id, result: { sessionId: this.sessionId } }), 0);
      } else {
        setTimeout(() => this.receive({ id: m.id, result: {} }), 0);
      }
    }
  }
  close() {
    this.closed = true;
  }
  onOpen(cb) { this.openCbs.push(cb); }
  onClose(cb) { this.closeCbs.push(cb); }
  onError(cb) { this.errorCbs.push(cb); }
  onMessage(cb) { this.messageCbs.push(cb); }
  /* test-side drivers */
  open() { this.auto = true; this.openCbs.forEach((cb) => cb()); }
  dead() { this.closeCbs.forEach((cb) => cb()); }
  receive(msg) { this.messageCbs.forEach((cb) => cb(JSON.stringify(msg))); }
  replies() { return this.sent.filter((m) => typeof m.id === "number"); }
  events() { return this.sent.filter((m) => typeof m.id !== "number"); }
}

/** Wire a bridge whose connect() returns a fresh socket per attempt. */
function makeBridge(opts = {}) {
  const sockets = [];
  const discoverCalls = [];
  const keepaliveCalls = [];
  let discoverResult = opts.discoverResult ?? { cdpUrl: "ws://127.0.0.1:9999/devtools/browser/abc", pageUrl: opts.pageUrl ?? "https://chat.z.ai/" };
  const bridge = createBrowserBridge({
    discover: async () => {
      discoverCalls.push(1);
      return typeof discoverResult === "function" ? discoverResult() : discoverResult;
    },
    connect: (url) => {
      assert.match(url, /^ws:\/\//);
      const s = new FakeSocket(opts.pageUrl ?? "https://chat.z.ai/");
      s.__url = url;
      sockets.push(s);
      return s;
    },
    keepalive: () => keepaliveCalls.push(1),
    log: () => {},
    retryMs: 5,
    idleDisconnectMs: opts.idleDisconnectMs ?? 20,
    keepaliveMs: opts.keepaliveMs ?? 1_000_000,
    frameMinIntervalMs: opts.frameMinIntervalMs ?? 0,
    cmdTimeoutMs: 500,
  });
  return {
    bridge,
    get socket() { return sockets[sockets.length - 1]; },
    sockets,
    discoverCalls,
    keepaliveCalls,
    setDiscover: (v) => { discoverResult = v; },
  };
}

async function connectBridge(h) {
  const states = [];
  const frames = [];
  const unsub = h.bridge.subscribe({ onState: (s) => states.push(s), onFrame: (f) => frames.push(f) });
  await sleep(10);
  h.socket.open(); /* auto-handshake answers on macrotasks */
  await sleep(40);
  return { states, frames, unsub };
}

/* ---------------- the active-tab law ---------------- */

test("the bridge attaches to the CLI's ACTIVE tab, not a background newtab", async () => {
  const h = makeBridge({ pageUrl: "data:text/html,<input id=q>" });
  const { unsub } = await connectBridge(h);
  const attach = h.socket.sent.find((m) => m.method === "Target.attachToTarget");
  assert.equal(attach.params.targetId, "t1", "the tab matching the CLI's active URL wins over chrome://newtab/");
  unsub();
});

test("when the active tab IS the newtab, the bridge follows it there", async () => {
  const h = makeBridge({ pageUrl: "chrome://newtab/" });
  const { unsub } = await connectBridge(h);
  const attach = h.socket.sent.find((m) => m.method === "Target.attachToTarget");
  assert.equal(attach.params.targetId, "tnewtab", "the CLI's active tab is followed even when it ranks low");
  unsub();
});

/* ---------------- attach + screencast ---------------- */

test("subscribe connects, attaches to the page target and starts the screencast", async () => {
  const h = makeBridge();
  const { frames, unsub } = await connectBridge(h);

  assert.equal(h.bridge.status().phase, "connected");
  assert.equal(h.bridge.status().url, "https://chat.z.ai/");

  const attach = h.socket.sent.find((m) => m.method === "Target.attachToTarget");
  assert.ok(attach, "attached via the flat protocol");
  assert.equal(attach.params.targetId, "t1", "attaches to the real page target, not the iframe");
  assert.equal(attach.params.flatten, true);

  const start = h.socket.sent.find((m) => m.method === "Page.startScreencast");
  assert.ok(start, "Page.startScreencast sent");
  assert.equal(start.sessionId, "sess-1", "page-domain commands carry the flat sessionId");
  assert.equal(start.params.format, "jpeg");
  assert.equal(start.params.everyNthFrame, 1);

  /* a screencast frame is acked and broadcast with its metadata */
  h.socket.receive({ method: "Page.screencastFrame", sessionId: "sess-1", params: { data: "QUJD", metadata: { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1 } } });
  await sleep(10);
  const ack = h.socket.sent.find((m) => m.method === "Page.screencastFrameAck");
  assert.ok(ack, "frame acknowledged");
  assert.equal(ack.sessionId, "sess-1");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].frame, "data:image/jpeg;base64,QUJD");
  assert.equal(frames[0].w, 1280);
  assert.equal(frames[0].h, 720);

  unsub();
});

test("main-frame navigation updates the state url", async () => {
  const h = makeBridge();
  const { unsub } = await connectBridge(h);

  h.socket.receive({ method: "Page.frameNavigated", sessionId: "sess-1", params: { frame: { id: "f1", url: "https://chat.z.ai/c/abc" } } });
  await sleep(5);
  assert.equal(h.bridge.status().url, "https://chat.z.ai/c/abc");
  h.socket.receive({ method: "Page.frameNavigated", sessionId: "sess-1", params: { frame: { id: "sub", parentId: "f1", url: "https://frame.example/" } } });
  await sleep(5);
  assert.equal(h.bridge.status().url, "https://chat.z.ai/c/abc", "sub-frame navigation is ignored");
  unsub();
});

/* ---------------- input dispatch ---------------- */

test("input click dispatches a press+release pair at the mapped coordinates", async () => {
  const h = makeBridge();
  const { unsub } = await connectBridge(h);
  const sentBefore = h.socket.sent.length;

  const res = await h.bridge.input({ kind: "click", x: 130, y: 240 });
  assert.equal(res.ok, true);
  const mice = h.socket.sent.slice(sentBefore).filter((m) => m.method === "Input.dispatchMouseEvent");
  assert.equal(mice.length, 2);
  assert.equal(mice[0].sessionId, "sess-1", "input commands are session-scoped (browser-level Input is rejected)");
  assert.equal(mice[0].params.type, "mousePressed");
  assert.equal(mice[0].params.button, "left");
  assert.equal(mice[0].params.clickCount, 1);
  assert.equal(mice[0].params.x, 130);
  assert.equal(mice[1].params.type, "mouseReleased");
  unsub();
});

test("input down/up honor count and button for native double-clicks and drags", async () => {
  const h = makeBridge();
  const { unsub } = await connectBridge(h);

  await h.bridge.input({ kind: "down", x: 10, y: 20, count: 2 });
  await h.bridge.input({ kind: "up", x: 10, y: 20, count: 2 });
  await h.bridge.input({ kind: "down", x: 30, y: 40, button: "right" });
  const mice = h.socket.sent.filter((m) => m.method === "Input.dispatchMouseEvent");
  assert.equal(mice[0].params.clickCount, 2, "second rapid press carries clickCount 2");
  assert.equal(mice[1].params.clickCount, 2);
  assert.equal(mice[2].params.button, "right", "right button forwarded");
  assert.equal(mice[2].params.buttons, 2);
  unsub();
});

test("input move/scroll forward buttons mask and wheel deltas", async () => {
  const h = makeBridge();
  const { unsub } = await connectBridge(h);
  await h.bridge.input({ kind: "move", x: 5, y: 6, buttons: 1 });
  await h.bridge.input({ kind: "scroll", x: 5, y: 6, deltaX: 0, deltaY: 120 });
  const mice = h.socket.sent.filter((m) => m.method === "Input.dispatchMouseEvent");
  assert.equal(mice[0].params.type, "mouseMoved");
  assert.equal(mice[0].params.buttons, 1);
  assert.equal(mice[1].params.type, "mouseWheel");
  assert.equal(mice[1].params.deltaY, 120);
  unsub();
});

test("input key dispatches keyDown with text + keyUp; text uses insertText", async () => {
  const h = makeBridge();
  const { unsub } = await connectBridge(h);

  await h.bridge.input({ kind: "key", key: "Enter", code: "Enter", vk: 13, text: "\r" });
  let keys = h.socket.sent.filter((m) => m.method === "Input.dispatchKeyEvent");
  assert.equal(keys.length, 2);
  assert.equal(keys[0].sessionId, "sess-1", "key events are session-scoped");
  assert.equal(keys[0].params.type, "keyDown");
  assert.equal(keys[0].params.text, "\r");
  assert.equal(keys[0].params.windowsVirtualKeyCode, 13);
  assert.equal(keys[1].params.type, "keyUp");

  const sent = h.socket.sent.length;
  await h.bridge.input({ kind: "text", text: "captcha-solved" });
  const insert = h.socket.sent.slice(sent).find((m) => m.method === "Input.insertText");
  assert.ok(insert);
  assert.equal(insert.sessionId, "sess-1", "insertText is session-scoped");
  assert.equal(insert.params.text, "captcha-solved");
  unsub();
});

test("input keycombo uses rawKeyDown (no text) so pages see the shortcut", async () => {
  const h = makeBridge();
  const { unsub } = await connectBridge(h);
  await h.bridge.input({ kind: "keycombo", key: "a", code: "KeyA", vk: 65, modifiers: 2 });
  const keys = h.socket.sent.filter((m) => m.method === "Input.dispatchKeyEvent");
  assert.equal(keys[0].params.type, "rawKeyDown");
  assert.equal(keys[0].params.modifiers, 2);
  unsub();
});

test("input before connect is rejected without touching a socket", async () => {
  const h = makeBridge();
  const res = await h.bridge.input({ kind: "click", x: 1, y: 1 });
  assert.equal(res.ok, false);
  assert.match(res.error, /not connected/);
});

/* ---------------- lifecycle + self-healing ---------------- */

test("socket death reconnects through a fresh discovery round", async () => {
  const h = makeBridge();
  const { unsub } = await connectBridge(h);
  const oldSocket = h.socket;
  assert.equal(h.bridge.status().phase, "connected");

  oldSocket.dead();
  await sleep(25);
  assert.ok(["retrying", "connecting"].includes(h.bridge.status().phase), `death surfaces honestly (phase=${h.bridge.status().phase})`);

  /* the retry round dials a NEW socket (browser relaunch = new CDP port) */
  const fresh = h.socket;
  assert.notEqual(fresh, oldSocket, "a fresh socket was dialed");
  fresh.open();
  await sleep(40);
  assert.equal(h.bridge.status().phase, "connected");
  assert.ok(h.discoverCalls.length >= 2, "re-discovered after the relaunch");
  unsub();
});

test("a dead page target schedules a reconnect instead of hanging", async () => {
  const h = makeBridge();
  const { unsub } = await connectBridge(h);
  h.socket.receive({ method: "Target.targetDestroyed", params: { targetId: "t1" } });
  await sleep(20);
  assert.notEqual(h.bridge.status().phase, "connected");
  unsub();
});

test("discovery failure (managed browser absent) retries while subscribed, then recovers", async () => {
  const h = makeBridge({ idleDisconnectMs: 1_000_000 });
  h.setDiscover(() => null);
  const states = [];
  const unsub = h.bridge.subscribe({ onState: (s) => states.push(s) });
  await sleep(25);
  assert.ok(states.some((s) => s.phase === "retrying"), "absent browser is a retrying state, not an error");
  assert.ok(states.some((s) => /not connected/.test(s.detail ?? "")), "the remedy travels with the state");

  h.setDiscover({ cdpUrl: "ws://127.0.0.1:1234/devtools/browser/x", pageUrl: "https://chat.z.ai/" });
  await sleep(25);
  h.socket.open();
  await sleep(40);
  assert.equal(h.bridge.status().phase, "connected", "recovers the moment the managed browser appears");
  unsub();
});

test("zero subscribers tears the screencast down after the idle window", async () => {
  const h = makeBridge({ idleDisconnectMs: 15 });
  const { unsub } = await connectBridge(h);
  unsub();
  await sleep(40);
  assert.equal(h.bridge.status().phase, "idle");
  assert.ok(h.socket.closed, "socket closed when nobody watches");
});

test("keepalive pings fire on the configured cadence while connected", async () => {
  const h = makeBridge({ keepaliveMs: 10 });
  const { unsub } = await connectBridge(h);
  await sleep(50);
  assert.ok(h.keepaliveCalls.length >= 2, "daemon-keepalive CLI pings run while the operator watches");
  unsub();
});

/* ---------------- frame coalescing ---------------- */

test("a frame burst is coalesced, not flooded", async () => {
  const h = makeBridge({ frameMinIntervalMs: 50 });
  const { frames, unsub } = await connectBridge(h);
  const before = frames.length;
  for (let i = 0; i < 8; i++) {
    h.socket.receive({ method: "Page.screencastFrame", sessionId: "sess-1", params: { data: `RnJhbWUke ${i}`, metadata: { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1 } } });
    await sleep(5);
  }
  await sleep(80);
  assert.ok(frames.length - before <= 3, `coalesced to ${frames.length - before} broadcasts, not 8`);
  unsub();
});

test("a new subscriber receives the cached last frame instantly (static page)", async () => {
  const h = makeBridge();
  const { unsub } = await connectBridge(h);
  /* one frame flows while subscriber #1 watches */
  h.socket.receive({ method: "Page.screencastFrame", sessionId: "sess-1", params: { data: "U1RBVElD", metadata: { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1 } } });
  await sleep(10);

  /* the page goes quiet — no repaints — and a NEW viewer opens the app */
  const lateFrames = [];
  const unsub2 = h.bridge.subscribe({ onFrame: (f) => lateFrames.push(f) });
  assert.equal(lateFrames.length, 1, "the newcomer gets the last live frame immediately, without waiting for a repaint");
  assert.equal(lateFrames[0].frame, "data:image/jpeg;base64,U1RBVElD");
  unsub2();
  unsub();
});
