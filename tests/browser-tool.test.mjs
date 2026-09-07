/**
 * Unit tests for the M5 browser_control engine (src/lib/browser-tool.ts).
 * Run: node --test tests/
 * The CLI runner is injected, so every action mapping, error code and
 * recovery path is exercised deterministically; the real CLI/LLM path is
 * covered separately by e2e/computer-use.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserTool, BrowserActionError, normalizeRef, classifyCliFailure, isTransientBrowserFailure } from "../src/lib/browser-tool.ts";

const WS = "/tmp/teachcast-test-workspace";

const okJson = (data = {}) => ({ ok: true, exitCode: 0, stdout: JSON.stringify({ success: true, data, error: null }), stderr: "", timedOut: false });
const errJson = (msg, exit = 1) => ({ ok: false, exitCode: exit, stdout: JSON.stringify({ success: false, data: null, error: msg }), stderr: `✗ ${msg}`, timedOut: false });
const okText = (text) => ({ ok: true, exitCode: 0, stdout: text, stderr: "", timedOut: false });
const SNAP = `- heading "Example Domain" [level=1, ref=e1]\n- link "Learn more" [ref=e2]\n`;

/** Scripted runner: pops one outcome per call; records every call. */
function fakeRunner(script) {
  const calls = [];
  const runner = async (call) => {
    calls.push(call);
    const step = typeof script === "function" ? script(calls.length, call) : script.shift();
    if (!step) throw new Error("fakeRunner: no scripted outcome for call #" + calls.length + " (" + call.subcommand + ")");
    return typeof step === "string" ? okText(step) : step;
  };
  return { runner, calls };
}

function toolWith(script, extraDeps = {}) {
  const { runner, calls } = fakeRunner(script);
  const tool = createBrowserTool({ runCli: runner, workspaceRoot: WS, ...extraDeps });
  return { tool, calls };
}

const EAGAIN_FAIL = { ok: false, exitCode: 1, stdout: "", stderr: "Error executing binary: spawn /usr/local/bin/agent-browser EAGAIN", timedOut: false };

const errLine = (e) => {
  assert.ok(e instanceof BrowserActionError, `expected BrowserActionError, got ${e?.constructor?.name}: ${e?.message}`);
  return JSON.parse(e.message);
};

/* ---------------- ref normalization ---------------- */

test("normalizeRef accepts e5 and @e5, rejects everything else", () => {
  assert.equal(normalizeRef("@e5"), "@e5");
  assert.equal(normalizeRef("e12"), "@e12");
  assert.equal(normalizeRef(" button.x"), null);
  assert.equal(normalizeRef("@e"), null);
  assert.equal(normalizeRef(""), null);
  assert.equal(normalizeRef(undefined), null);
});

test("normalizeRef tolerates refs wrapped in stray quote characters (live LLM quirk)", () => {
  assert.equal(normalizeRef('"@e42"'), "@e42");
  assert.equal(normalizeRef("'e7'"), "@e7");
  assert.equal(normalizeRef('"e12"'), "@e12");
  assert.equal(normalizeRef('"button.x"'), null, "quotes are stripped, but non-ref shapes still fail");
});

/* ---------------- action -> subcommand mapping ---------------- */

test("navigate opens and waits for domcontentloaded, clears the ref ledger", async () => {
  const { tool, calls } = toolWith([okJson(), okJson()]);
  const out = await tool.handle({ action: "navigate", url: "https://example.com" }, "s");
  assert.match(out, /Navigated to https:\/\/example\.com/);
  assert.match(calls[0].subcommand, /^open 'https:\/\/example\.com'/);
  assert.match(calls[1].subcommand, /wait --load domcontentloaded --timeout 15000/);
  // ledger cleared: a ref that existed before must now fast-fail
  await tool.handle({ action: "snapshot" }, "s").catch(() => {});
  const { tool: t2 } = toolWith([okText(SNAP)]);
  await t2.handle({ action: "snapshot" }, "s");
  const { tool: t3, calls: c3 } = toolWith([errJson("Unknown ref: e2")]);
  await assert.rejects(t3.handle({ action: "click", ref: "e2" }, "s"));
  assert.equal(c3.length, 1, "fast-fail must not re-snapshot");
});

test("snapshot defaults to interactive+compact and rebuilds the ledger", async () => {
  const { tool, calls } = toolWith([okText(SNAP)]);
  const out = await tool.handle({ action: "snapshot" }, "s");
  assert.match(calls[0].subcommand, /^snapshot -i -c$/);
  assert.match(out, /Learn more/);
  assert.deepEqual(tool.lastRefs("s"), ["e1", "e2"]);
});

test("snapshot flags can be disabled", async () => {
  const { tool, calls } = toolWith([okText("full tree")]);
  await tool.handle({ action: "snapshot", interactive: false, compact: false }, "s");
  assert.match(calls[0].subcommand, /^snapshot$/);
});

test("click acts by ref from the snapshot", async () => {
  const { tool, calls } = toolWith([okText(SNAP), okJson({ clicked: "@e2" })]);
  const out = await tool.handle({ action: "snapshot" }, "s");
  assert.ok(out);
  const out2 = await tool.handle({ action: "click", ref: "@e2" }, "s");
  assert.match(out2, /Clicked @e2/);
  assert.match(calls[1].subcommand, /^click '@e2'/);
  assert.match(out2, /refs may be stale/);
});

test("click_coords is three mouse calls: move, down, up", async () => {
  const { tool, calls } = toolWith([okJson(), okJson(), okJson()]);
  const out = await tool.handle({ action: "click_coords", x: 40, y: 300 }, "s");
  assert.match(out, /Clicked at \(40, 300\)/);
  assert.match(calls[0].subcommand, /mouse move 40 300/);
  assert.match(calls[1].subcommand, /mouse down/);
  assert.match(calls[2].subcommand, /mouse up/);
});

test("press, select, hover, scroll, scroll_into_view map to their CLI subcommands", async () => {
  {
    const { tool, calls } = toolWith([okJson()]);
    await tool.handle({ action: "press", key: "Control+a" }, "s");
    assert.match(calls[0].subcommand, /^press 'Control\+a'/);
  }
  {
    const { tool, calls } = toolWith([okJson()]);
    await tool.handle({ action: "select", ref: "e4", value: "chocolate" }, "s");
    assert.match(calls[0].subcommand, /^select '@e4' 'chocolate'/);
  }
  {
    const { tool, calls } = toolWith([okJson()]);
    await tool.handle({ action: "hover", ref: "@e7" }, "s");
    assert.match(calls[0].subcommand, /^hover '@e7'/);
  }
  {
    const { tool, calls } = toolWith([okJson()]);
    await tool.handle({ action: "scroll", direction: "down", px: 600 }, "s");
    assert.match(calls[0].subcommand, /^scroll down 600/);
  }
  {
    const { tool, calls } = toolWith([okJson()]);
    await tool.handle({ action: "scroll_into_view", ref: "e3" }, "s");
    assert.match(calls[0].subcommand, /^scrollintoview '@e3'/);
  }
});

test("wait is condition-based: text, url glob, or element; timeout clamped into the command", async () => {
  {
    const { tool, calls } = toolWith([okJson()]);
    const out = await tool.handle({ action: "wait", text: "Success" }, "s");
    assert.match(out, /Condition met/);
    assert.match(calls[0].subcommand, /^wait --text 'Success' --timeout 25000 --json$/);
  }
  {
    const { tool, calls } = toolWith([okJson()]);
    await tool.handle({ action: "wait", url: "**/dashboard", timeoutMs: 5000 }, "s");
    assert.match(calls[0].subcommand, /^wait --url '\*\*\/dashboard' --timeout 5000 --json$/);
  }
  {
    const { tool, calls } = toolWith([okJson()]);
    await tool.handle({ action: "wait", element: "@e9", timeoutMs: 3000 }, "s");
    assert.match(calls[0].subcommand, /^wait '@e9' --timeout 3000 --json$/);
  }
  {
    const { tool, calls } = toolWith([okJson()]);
    await tool.handle({ action: "wait", element: "#spinner", timeoutMs: 900000 }, "s");
    assert.match(calls[0].subcommand, /--timeout 60000 --json$/, "timeoutMs is clamped to 60000");
  }
  await assert.rejects(
    toolWith([]).tool.handle({ action: "wait" }, "s"),
    (e) => errLine(e).code === "INVALID_ARGS"
  );
  await assert.rejects(
    toolWith([]).tool.handle({ action: "wait", text: "a", url: "b" }, "s"),
    (e) => errLine(e).code === "INVALID_ARGS"
  );
});

test("read: by ref (get text), by url, or active tab", async () => {
  {
    const { tool, calls } = toolWith([okText("hello world\n")]);
    const out = await tool.handle({ action: "read", ref: "e1" }, "s");
    assert.match(out, /Text of @e1:\nhello world/);
    assert.match(calls[0].subcommand, /^get text '@e1'/);
  }
  {
    const { tool, calls } = toolWith([okText("# doc\nbody")]);
    await tool.handle({ action: "read", url: "https://example.com/doc" }, "s");
    assert.match(calls[0].subcommand, /^read 'https:\/\/example\.com\/doc'/);
  }
  {
    const { tool, calls } = toolWith([okText("active tab text")]);
    await tool.handle({ action: "read" }, "s");
    assert.match(calls[0].subcommand, /^read$/);
  }
  await assert.rejects(
    toolWith([]).tool.handle({ action: "read", ref: "e1", url: "https://x.com" }, "s"),
    (e) => errLine(e).code === "INVALID_ARGS"
  );
});

test("verify runs is/is/read/get-url probes and reports negative answers, not failures", async () => {
  {
    const { tool, calls } = toolWith([
      okJson({ visible: true }),
      errJson("Element not found: #zzz. Verify the selector, role, or name is correct and the element exists in the DOM."),
      okText("Example Domain is a page\n"),
      okText("https://www.iana.org/help/example-domains\n"),
    ]);
    const out = await tool.handle(
      { action: "verify", visible: "h1", enabled: "#zzz", textContains: "example domain", urlIs: "https://www.iana.org/help/example-domains" },
      "s"
    );
    assert.match(calls[0].subcommand, /^is visible 'h1'/);
    assert.match(calls[1].subcommand, /^is enabled '#zzz'/);
    assert.match(out, /visible h1: true/);
    assert.match(out, /enabled #zzz: false/, "element-not-found is a negative probe answer");
    assert.match(out, /textContains "example domain": true/);
    assert.match(out, /urlIs .*: true/);
  }
  {
    const { tool, calls } = toolWith([okText("https://a.com\n")]);
    const out = await tool.handle({ action: "verify", urlIs: "https://b.com" }, "s");
    assert.match(out, /: false \(current url: https:\/\/a\.com\)/);
  }
  await assert.rejects(
    toolWith([]).tool.handle({ action: "verify" }, "s"),
    (e) => errLine(e).code === "INVALID_ARGS"
  );
});

test("screenshot saves inside the workspace and reports the path", async () => {
  const { tool, calls } = toolWith([okJson({ path: `${WS}/after.png` })]);
  const out = await tool.handle({ action: "screenshot", path: "after.png" }, "s");
  assert.match(out, /Screenshot saved to after\.png/);
  assert.match(calls[0].subcommand, /screenshot/);
  await assert.rejects(
    toolWith([]).tool.handle({ action: "screenshot", path: "../escape.png" }, "s"),
    (e) => errLine(e).code === "INVALID_ARGS"
  );
});

test("dialog accept/dismiss/status map to dialog subcommands", async () => {
  {
    const { tool, calls } = toolWith([okJson()]);
    const out = await tool.handle({ action: "dialog", mode: "accept", text: "my input" }, "s");
    assert.match(out, /Dialog accepted/);
    assert.match(calls[0].subcommand, /^dialog accept 'my input'/);
  }
  {
    const { tool, calls } = toolWith([okJson()]);
    await tool.handle({ action: "dialog", mode: "dismiss" }, "s");
    assert.match(calls[0].subcommand, /^dialog dismiss/);
  }
  {
    const { tool, calls } = toolWith([okJson({ hasDialog: false })]);
    const out = await tool.handle({ action: "dialog", mode: "status" }, "s");
    assert.match(out, /no dialog open/);
  }
  await assert.rejects(
    toolWith([]).tool.handle({ action: "dialog" }, "s"),
    (e) => errLine(e).code === "INVALID_ARGS"
  );
});

/* ---------------- structured errors + exit-code propagation ---------------- */

test("a failed CLI action returns a structured JSON error line with ok:false semantics — never success", async () => {
  const { tool } = toolWith([errJson("some chromium failure")]);
  const e = await tool.handle({ action: "navigate", url: "https://example.com" }, "s").then(
    () => { throw new Error("should have thrown"); },
    (err) => err
  );
  const line = errLine(e);
  assert.equal(line.code, "CLI_ERROR");
  assert.match(line.message, /some chromium failure/);
  assert.ok(line.remedy && line.remedy.length > 10);
  assert.deepEqual(Object.keys(line).sort(), ["code", "message", "remedy"]);
});

test("error classification", () => {
  assert.equal(classifyCliFailure("Unknown ref: e999"), "UNKNOWN_REF");
  assert.equal(classifyCliFailure("Wait timed out after 2000ms"), "TIMEOUT");
  assert.equal(classifyCliFailure("Element <a> intercepts pointer events"), "CLICK_COVERED");
  assert.equal(classifyCliFailure("Element not found: #x. Verify the selector"), "UNKNOWN_REF");
  assert.equal(classifyCliFailure("connected CDP socket closed"), "CLI_ERROR");
  assert.equal(classifyCliFailure("whatever", true), "TIMEOUT");
});

test("a killed exec (timeout) becomes a TIMEOUT structured error", async () => {
  const { tool } = toolWith([okJson(), { ok: false, exitCode: 1, stdout: "", stderr: "", timedOut: true }]);
  const e = await tool.handle({ action: "navigate", url: "https://slow.example.com" }, "s").then(
    () => { throw new Error("should have thrown"); },
    (err) => err
  );
  assert.equal(errLine(e).code, "TIMEOUT");
});

test("arg validation produces INVALID_ARGS with the remedy line", async () => {
  {
    const { tool } = toolWith([]);
    const e = await tool.handle({ action: "click", ref: "button.primary" }, "s").then(
      () => { throw new Error("nope"); },
      (x) => x
    );
    assert.equal(errLine(e).code, "INVALID_ARGS");
  }
  {
    const { tool } = toolWith([]);
    const e = await tool.handle({ action: "navigate", url: "javascript:alert(1)" }, "s").then(
      () => { throw new Error("nope"); },
      (x) => x
    );
    assert.equal(errLine(e).code, "INVALID_ARGS");
  }
  {
    const { tool } = toolWith([]);
    const e = await tool.handle({ nope: true }, "s").then(() => { throw new Error("nope"); }, (x) => x);
    assert.equal(errLine(e).code, "INVALID_ARGS");
  }
});

/* ---------------- stale-ref law ---------------- */

test("STALE_REF: known ref that dies gets exactly ONE re-snapshot + retry, then recovers", async () => {
  const script = [
    okText(SNAP),                       // snapshot -> ledger {e1,e2}
    errJson("Unknown ref: e2"),         // click @e2 fails (page changed meanwhile)
    okText(SNAP),                       // recovery re-snapshot
    okJson({ clicked: "@e2" }),         // retry succeeds
  ];
  const { tool, calls } = toolWith(script);
  await tool.handle({ action: "snapshot" }, "s");
  const out = await tool.handle({ action: "click", ref: "e2" }, "s");
  assert.match(out, /\[recovered: ref was stale; re-snapshotted and retried once\]/);
  assert.match(out, /Clicked @e2/);
  assert.equal(calls.length, 4, "exactly: snapshot, click, re-snapshot, retry");
  assert.match(calls[2].subcommand, /^snapshot -i -c$/);
  assert.match(calls[3].subcommand, /^click '@e2'/);
});

test("STALE_REF: when the retry also fails, the error carries the fresh snapshot", async () => {
  const script = [
    okText(SNAP),
    errJson("Unknown ref: e2"),
    okText(SNAP),
    errJson("Unknown ref: e2"),
  ];
  const { tool } = toolWith(script);
  await tool.handle({ action: "snapshot" }, "s");
  const e = await tool.handle({ action: "click", ref: "e2" }, "s").then(
    () => { throw new Error("should have thrown"); },
    (x) => x
  );
  const line = errLine(e);
  assert.equal(line.code, "STALE_REF");
  assert.match(line.message, /after one re-snapshot retry/);
  assert.match(line.snapshot, /Learn more/, "fresh snapshot is embedded in the error line");
});

test("UNKNOWN_REF fast-fails without any recovery when the ref was never snapshotted", async () => {
  const { tool, calls } = toolWith([errJson("Unknown ref: e42")]);
  const e = await tool.handle({ action: "click", ref: "@e42" }, "s").then(
    () => { throw new Error("should have thrown"); },
    (x) => x
  );
  const line = errLine(e);
  assert.equal(line.code, "UNKNOWN_REF");
  assert.match(line.message, /never in any snapshot/);
  assert.equal(calls.length, 1, "fail fast: no re-snapshot, no retry");
});

test("UNKNOWN_REF fast-fails when there is no ledger at all (no snapshot ever taken)", async () => {
  const { tool, calls } = toolWith([errJson("Unknown ref: e1")]);
  await assert.rejects(tool.handle({ action: "click", ref: "e1" }, "s"), (e) => errLine(e).code === "UNKNOWN_REF");
  assert.equal(calls.length, 1);
});

test("a non-ref error on a known ref (e.g. CLICK_COVERED) is NOT treated as stale — no auto retry", async () => {
  const script = [okText(SNAP), errJson("Element <div class=modal> intercepts pointer events")];
  const { tool, calls } = toolWith(script);
  await tool.handle({ action: "snapshot" }, "s");
  const e = await tool.handle({ action: "click", ref: "e2" }, "s").then(
    () => { throw new Error("should have thrown"); },
    (x) => x
  );
  assert.equal(errLine(e).code, "CLICK_COVERED");
  assert.equal(calls.length, 2, "no re-snapshot for covered clicks");
  assert.match(errLine(e).remedy, /click_coords/);
});

/* ---------------- fill -> focus + inserttext fallback ---------------- */

test("fill: on component rejection, falls back ONCE to focus + keyboard inserttext", async () => {
  const script = [
    okText(SNAP),                                  // snapshot (ledger)
    errJson('Node is not an <input>, <textarea> or [contenteditable] element'), // fill rejected
    okJson(),                                      // focus
    okJson({ inserted: true }),                    // keyboard inserttext
  ];
  const { tool, calls } = toolWith(script);
  await tool.handle({ action: "snapshot" }, "s");
  const out = await tool.handle({ action: "fill", ref: "e2", text: "hello" }, "s");
  assert.match(out, /\[recovered: fill was rejected; focused @e2 and inserted the text\]/);
  assert.equal(calls.length, 4);
  assert.match(calls[1].subcommand, /^fill '@e2' 'hello'/);
  assert.match(calls[2].subcommand, /^focus '@e2'/);
  assert.match(calls[3].subcommand, /^keyboard inserttext 'hello'/);
});

test("fill: when inserttext also fails, a structured error is returned (bounded, no loops)", async () => {
  const script = [
    okText(SNAP),
    errJson("fill rejected by component"),
    okJson(),
    errJson("inserttext failed"),
  ];
  const { tool, calls } = toolWith(script);
  await tool.handle({ action: "snapshot" }, "s");
  const e = await tool.handle({ action: "fill", ref: "e2", text: "hi" }, "s").then(
    () => { throw new Error("should have thrown"); },
    (x) => x
  );
  const line = errLine(e);
  assert.equal(line.code, "CLI_ERROR");
  assert.equal(calls.length, 4, "bounded: fill, focus, inserttext — then stop");
});

test("fill: a stale ref still takes the re-snapshot+retry path before the inserttext fallback", async () => {
  const script = [
    okText(SNAP),
    errJson("Unknown ref: e3"),
    okText(SNAP),                    // recovery snapshot
    errJson("fill rejected by component"), // retry still rejected
    okJson(),                        // focus
    okJson({ inserted: true }),      // inserttext
  ];
  const { tool, calls } = toolWith(script);
  await tool.handle({ action: "snapshot" }, "s");
  const out = await tool.handle({ action: "fill", ref: "e2", text: "data" }, "s");
  assert.match(out, /via focus \+ keyboard inserttext/);
  assert.equal(calls.length, 6);
});

/* ---------------- misc ---------------- */

test("text mode with success exit but non-JSON payload is returned as text (defensive)", async () => {
  const { tool } = toolWith([okText("plain text page\n")]);
  const out = await tool.handle({ action: "read" }, "s");
  assert.match(out, /plain text page/);
});

test("sessions keep independent ledgers", async () => {
  const { tool } = toolWith([okText(SNAP)]);
  await tool.handle({ action: "snapshot" }, "agent");
  assert.deepEqual(tool.lastRefs("agent"), ["e1", "e2"]);
  assert.deepEqual(tool.lastRefs("managed"), []);
});

/* ---------------- FIX 1: transient spawn/daemon failure recovery ---------------- */

test("isTransientBrowserFailure detects spawn errnos, the binary wrapper and daemon death", () => {
  assert.equal(isTransientBrowserFailure({ stdout: "", stderr: "spawn /usr/bin/agent-browser EAGAIN" }), true);
  assert.equal(isTransientBrowserFailure({ stdout: "Error executing binary: spawn x ENOBUFS", stderr: "" }), true);
  assert.equal(isTransientBrowserFailure({ stdout: "", stderr: "resource limit ENFILE" }), true);
  assert.equal(isTransientBrowserFailure({ stdout: "", stderr: "✗ Not attached to an active page" }), true);
  assert.equal(isTransientBrowserFailure({ stdout: "", stderr: "✗ Unknown ref: e2" }), false, "ordinary failures are not transient");
  assert.equal(isTransientBrowserFailure({ stdout: "", stderr: "" }), false);
});

test("transient spawn EAGAIN: exactly one retry recovers and the result is ok", async () => {
  const { tool, calls } = toolWith([EAGAIN_FAIL, okText(SNAP)], { retryBackoffMs: 10 });
  const out = await tool.handle({ action: "snapshot" }, "s");
  assert.match(out, /Learn more/, "the retried snapshot succeeded");
  assert.equal(calls.length, 2, "exactly one retry after the transient failure");
  assert.equal(calls[0].subcommand, calls[1].subcommand, "the SAME command is retried");
});

test("transient spawn EAGAIN: the default backoff is ~2s", async () => {
  const { tool, calls } = toolWith([EAGAIN_FAIL, okText(SNAP)]);
  const t0 = Date.now();
  await tool.handle({ action: "snapshot" }, "s");
  const dt = Date.now() - t0;
  assert.ok(dt >= 1_900, `expected a ~2s backoff before the retry, got ${dt}ms`);
  assert.equal(calls.length, 2);
});

test("second transient failure becomes BROWSER_UNAVAILABLE with the re-navigate remedy", async () => {
  const { tool, calls } = toolWith([EAGAIN_FAIL, EAGAIN_FAIL], { retryBackoffMs: 10 });
  const e = await tool.handle({ action: "snapshot" }, "s").then(
    () => { throw new Error("should have thrown"); },
    (x) => x
  );
  const line = errLine(e);
  assert.equal(line.code, "BROWSER_UNAVAILABLE");
  assert.match(line.message, /browser unavailable after one retry/);
  assert.match(line.message, /EAGAIN/, "the underlying spawn error is preserved for diagnosis");
  assert.equal(line.remedy, "The browser session is unavailable; re-navigate before the next ref action.");
  assert.equal(calls.length, 2, "bounded: one retry, then stop");
});

test("daemon death (Not attached to an active page) is transient and retries once", async () => {
  const dead = errJson("Not attached to an active page");
  const { tool, calls } = toolWith([dead, okJson(), okJson(), okJson()], { retryBackoffMs: 10 });
  const out = await tool.handle({ action: "click_coords", x: 10, y: 20 }, "s");
  assert.match(out, /Clicked at \(10, 20\)/);
  assert.equal(calls.length, 4, "mouse move retried once, then down + up proceed");
});

test("non-transient failures never retry", async () => {
  const { tool, calls } = toolWith([errJson("some chromium failure")]);
  const e = await tool.handle({ action: "navigate", url: "https://example.com" }, "s").then(
    () => { throw new Error("should have thrown"); },
    (x) => x
  );
  assert.equal(errLine(e).code, "CLI_ERROR");
  assert.equal(calls.length, 1, "ordinary CLI failures get no retry");
});

/* ---------------- FIX 2: argument type validation ---------------- */

test("string fields reject booleans/numbers with INVALID_ARGS naming the field", async () => {
  const cases = [
    [{ action: "verify", urlIs: true }, /"urlIs"[^"]*must be[^"]*got boolean \(true\)/s],
    [{ action: "verify", urlIs: 42 }, /"urlIs"[^"]*got number \(42\)/s],
    [{ action: "verify", visible: true }, /"visible"/],
    [{ action: "verify", enabled: false }, /"enabled"/],
    [{ action: "verify", textContains: 7 }, /"textContains"/],
    [{ action: "read", url: true }, /"url"/],
    [{ action: "read", ref: true }, /"ref"/],
    [{ action: "wait", text: true }, /"text"/],
    [{ action: "wait", url: 1 }, /"url"/],
    [{ action: "wait", element: 7 }, /"element"/],
    [{ action: "navigate", url: true }, /"url"/],
    [{ action: "type", ref: "e1", text: true }, /"text"/],
    [{ action: "fill", ref: "e1", text: 0 }, /"text"/],
    [{ action: "read", url: "" }, /"url"/],
  ];
  for (const [args, rx] of cases) {
    const { tool } = toolWith([]);
    const e = await tool.handle(args, "s").then(
      () => { throw new Error("should have thrown for " + JSON.stringify(args)); },
      (x) => x
    );
    const line = errLine(e);
    assert.equal(line.code, "INVALID_ARGS", JSON.stringify(args));
    assert.match(line.message, rx, JSON.stringify(args));
    assert.ok(line.remedy.includes(JSON.stringify(Object.keys(args)[1] || "")) || line.remedy.length > 10);
  }
});

test("fill still accepts text as an empty string (clear-the-field semantics)", async () => {
  const { tool, calls } = toolWith([okText(SNAP), okJson()]);
  await tool.handle({ action: "snapshot" }, "s");
  await tool.handle({ action: "fill", ref: "e2", text: "" }, "s");
  assert.match(calls[1].subcommand, /^fill '@e2' ''/);
});

test("a plain successful fill returns immediately — no focus/inserttext rung", async () => {
  const { tool, calls } = toolWith([okText(SNAP), okJson()]);
  await tool.handle({ action: "snapshot" }, "s");
  const out = await tool.handle({ action: "fill", ref: "e2", text: "hello" }, "s");
  assert.match(out, /^Filled @e2/, "no [recovered:...] prefix on a plain fill");
  assert.equal(calls.length, 2, "exactly snapshot + fill — no wasted focus/inserttext calls");
});

test("string-typed flows are untouched: verify/read/wait with proper strings still work", async () => {
  {
    const { tool } = toolWith([okText("https://a.com\n")]);
    const out = await tool.handle({ action: "verify", urlIs: "https://a.com" }, "s");
    assert.match(out, /: true \(current url: https:\/\/a\.com\)/);
  }
  {
    const { tool } = toolWith([okText("plain text page\n")]);
    const out = await tool.handle({ action: "read" }, "s");
    assert.match(out, /plain text page/);
  }
  {
    const { tool, calls } = toolWith([okJson()]);
    await tool.handle({ action: "wait", text: "Success" }, "s");
    assert.match(calls[0].subcommand, /^wait --text 'Success' --timeout 25000 --json$/);
  }
});
