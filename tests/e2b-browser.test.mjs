/**
 * Unit tests for the E2B browser backend (src/lib/e2b-browser.ts) — M8.
 * Run: node --test tests/e2b-browser.test.mjs
 *
 * The e2b SDK is injected, so find-or-create, bootstrap, quoting, exit-code
 * and timeout mapping are all exercised deterministically against a scripted
 * fake — no network, no E2B_API_KEY. The real sandbox path is covered by
 * e2e (drive the managed console with E2B_* env set).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createE2bBrowser,
  e2bBrowserEnabled,
  e2bQuote,
  E2B_METADATA_KIND,
} from "../src/lib/e2b-browser.ts";

/* ------------------------------------------------------------------ */
/* The fake SDK                                                          */
/* ------------------------------------------------------------------ */

const BOOTSTRAP_HINT = "agent-browser install";

function makeFakeSdk(overrides = {}) {
  const state = {
    created: [], // {template, opts}
    connected: [], // sandboxId
    listed: 0,
    killed: [],
    setTimeoutCalls: [], // {sandboxId, timeoutMs}
    runs: [], // {sandboxId, cmd, opts}
    existing: [], // what list() reports
    dead: new Set(), // sandboxIds whose isRunning() is false
  };

  function runCommand(sandboxId, cmd, opts) {
    state.runs.push({ sandboxId, cmd, opts });
    const handler = overrides.run;
    if (typeof handler === "function") {
      return handler({ sandboxId, cmd, opts, callIndex: state.runs.length });
    }
    return { exitCode: 0, stdout: `ok: ${cmd.slice(0, 40)}`, stderr: "" };
  }

  function makeSandbox(id) {
    return {
      sandboxId: id,
      commands: {
        run: (cmd, opts) => Promise.resolve().then(() => runCommand(id, cmd, opts)),
      },
      files: {
        read: (path, opts) =>
          Promise.resolve(
            overrides.readFile
              ? overrides.readFile({ path, opts })
              : new Uint8Array([1, 2, 3, 4])
          ),
      },
      isRunning: () => Promise.resolve(!state.dead.has(id)),
    };
  }

  const nextId = (() => {
    let n = 0;
    return () => `sbx-${++n}`;
  })();

  const api = {
    Sandbox: {
      create: async (template, opts) => {
        const id = nextId();
        state.created.push({ id, template, opts });
        return makeSandbox(id);
      },
      connect: async (sandboxId) => {
        if (state.dead.has(sandboxId)) throw new Error("sandbox not found");
        state.connected.push(sandboxId);
        return makeSandbox(sandboxId);
      },
      list: async (opts) => {
        state.listed += 1;
        return {
          hasNext: false,
          nextItems: async () => state.existing.map((m) => ({ sandboxId: m.sandboxId, metadata: m.metadata })),
        };
      },
      setTimeout: async (sandboxId, timeoutMs) => {
        state.setTimeoutCalls.push({ sandboxId, timeoutMs });
      },
      kill: async (sandboxId) => {
        state.killed.push(sandboxId);
        return true;
      },
    },
  };

  return { sdk: api, state };
}

/** A fake that makes every non-bootstrap command succeed with text output. */
const defaultFake = () => makeFakeSdk();

const browser = (deps, config = {}) => createE2bBrowser({ ...deps, config });

/* ------------------------------------------------------------------ */
/* Backend selection (pure env logic)                                    */
/* ------------------------------------------------------------------ */

test("e2bBrowserEnabled: default local, explicit e2b, key-presence, explicit local override", () => {
  assert.equal(e2bBrowserEnabled({}), false, "nothing set -> local (backwards compatible)");
  assert.equal(e2bBrowserEnabled({ BROWSER_BACKEND: "e2b" }), true);
  assert.equal(e2bBrowserEnabled({ E2B_API_KEY: "e2b-sk-1" }), true, "key alone activates E2B");
  assert.equal(
    e2bBrowserEnabled({ E2B_API_KEY: "e2b-sk-1", BROWSER_BACKEND: "local" }),
    false,
    "explicit local beats the key"
  );
  assert.equal(e2bBrowserEnabled({ E2B_API_KEY: "  " }), false, "blank key is no key");
});

/* ------------------------------------------------------------------ */
/* Quoting                                                               */
/* ------------------------------------------------------------------ */

test("e2bQuote: single-quote wrapping, embedded quotes escaped", () => {
  assert.equal(e2bQuote("snapshot --text"), "'snapshot --text'");
  assert.equal(e2bQuote("it's"), "'it'\\''s'");
  assert.equal(e2bQuote(""), "''");
});

/* ------------------------------------------------------------------ */
/* runCli: command translation + outcome mapping                          */
/* ------------------------------------------------------------------ */

test("runCli: builds the exact agent-browser command with session quoting", async () => {
  const { sdk, state } = defaultFake();
  const b = browser({ sdk }, { apiKey: "k" });
  const r = await b.runCli({ session: "teachcast-agent", subcommand: "snapshot --text --compact", timeoutMs: 5000 });
  assert.equal(r.ok, true);
  const cliCalls = state.runs.filter((x) => x.cmd.startsWith("agent-browser"));
  assert.equal(cliCalls.length, 1);
  assert.equal(cliCalls[0].cmd, "agent-browser --session 'teachcast-agent' snapshot --text --compact");
  assert.equal(cliCalls[0].opts.timeoutMs, 5000);
});

test("runCli: a zero exit is ok:true with exit code 0", async () => {
  const { sdk } = makeFakeSdk({
    run: () => ({ exitCode: 0, stdout: "- link \"x\" [ref=e1]", stderr: "" }),
  });
  const b = browser({ sdk }, { apiKey: "k" });
  const r = await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  assert.deepEqual([r.ok, r.exitCode, r.timedOut], [true, 0, false]);
  assert.match(r.stdout, /ref=e1/);
});

test("runCli: CommandExitError-like throw maps to a non-zero CliOutcome, never ok", async () => {
  const exitErr = Object.assign(new Error("non-zero"), { exitCode: 3, stdout: "", stderr: "✗ covered" });
  const { sdk } = makeFakeSdk({ run: ({ cmd }) => (cmd.includes(BOOTSTRAP_HINT) ? { exitCode: 0, stdout: "", stderr: "" } : Promise.reject(exitErr)) });
  const b = browser({ sdk }, { apiKey: "k" });
  const r = await b.runCli({ session: "s", subcommand: "click @e5", timeoutMs: 1000 });
  assert.deepEqual([r.ok, r.exitCode, r.timedOut], [false, 3, false]);
  assert.match(r.stderr, /covered/);
});

test("runCli: TimeoutError maps to timedOut:true with exit code 124", async () => {
  const timeoutErr = Object.assign(new Error("command timed out"), { name: "TimeoutError" });
  const { sdk } = makeFakeSdk({ run: ({ cmd }) => (cmd.includes(BOOTSTRAP_HINT) ? { exitCode: 0, stdout: "", stderr: "" } : Promise.reject(timeoutErr)) });
  const b = browser({ sdk }, { apiKey: "k" });
  const r = await b.runCli({ session: "s", subcommand: "wait 999999", timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, 124);
});

test("runCli: any other throw becomes a structured non-zero outcome, never a rejection", async () => {
  const { sdk } = makeFakeSdk({ run: ({ cmd }) => (cmd.includes(BOOTSTRAP_HINT) ? { exitCode: 0, stdout: "", stderr: "" } : Promise.reject(new Error("sandbox exploded"))) });
  const b = browser({ sdk }, { apiKey: "k" });
  const r = await b.runCli({ session: "s", subcommand: "open x", timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /sandbox exploded/);
});

test("runCli without E2B_API_KEY refuses loudly and never creates a sandbox", async () => {
  const { sdk, state } = defaultFake();
  const b = browser({ sdk }, {}); // no apiKey, no env
  const r = await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 127);
  assert.match(r.stderr, /E2B_API_KEY/);
  assert.equal(state.created.length, 0, "no sandbox may be provisioned without the key");
  assert.equal(state.runs.length, 0);
});

/* ------------------------------------------------------------------ */
/* Sandbox lifecycle: find-or-create, reuse, eviction, keep-alive        */
/* ------------------------------------------------------------------ */

test("sandbox is created once with metadata + timeout and reused afterwards", async () => {
  const { sdk, state } = defaultFake();
  const b = browser({ sdk }, { apiKey: "k", sandboxTimeoutMs: 42_000 });
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  assert.equal(state.created.length, 1, "second call must reuse the cached sandbox");
  assert.equal(state.created[0].template, "base");
  assert.deepEqual(state.created[0].opts.metadata, { kind: E2B_METADATA_KIND });
  assert.equal(state.created[0].opts.timeoutMs, 42_000);
  assert.equal(b.sandboxId(), state.created[0].id);
});

test("a pre-existing teachcast sandbox from list() is connected, not recreated", async () => {
  const { sdk, state } = defaultFake();
  state.existing = [{ sandboxId: "sbx-live", metadata: { kind: E2B_METADATA_KIND } }];
  const b = browser({ sdk }, { apiKey: "k" });
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  assert.equal(state.connected.length >= 1, true, "must connect to the listed sandbox");
  assert.equal(state.created.length, 0, "must not create a second sandbox");
  assert.equal(state.runs[state.runs.length - 1].sandboxId, "sbx-live");
});

test("sandboxes with foreign metadata are ignored by find-or-create", async () => {
  const { sdk, state } = defaultFake();
  state.existing = [
    { sandboxId: "sbx-other", metadata: { kind: "someone-elses" } },
    { sandboxId: "sbx-none", metadata: {} },
  ];
  const b = browser({ sdk }, { apiKey: "k" });
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  assert.equal(state.connected.length, 0);
  assert.equal(state.created.length, 1, "falls through to create");
});

test("a cached-but-dead sandbox is evicted and re-found via list()", async () => {
  const { sdk, state } = defaultFake();
  const b = browser({ sdk }, { apiKey: "k" });
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  const firstId = state.created[0].id;
  state.dead.add(firstId);
  state.existing = [{ sandboxId: "sbx-live2", metadata: { kind: E2B_METADATA_KIND } }];
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  assert.equal(state.created.length, 1, "still only one create");
  assert.ok(state.connected.includes("sbx-live2"), "the live sandbox is reconnected");
});

test("every command bumps the sandbox lifetime (keep-alive)", async () => {
  const { sdk, state } = defaultFake();
  const b = browser({ sdk }, { apiKey: "k", sandboxTimeoutMs: 77_000 });
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  assert.equal(state.setTimeoutCalls.length, 2);
  assert.ok(state.setTimeoutCalls.every((c) => c.timeoutMs === 77_000));
});

/* ------------------------------------------------------------------ */
/* Bootstrap                                                             */
/* ------------------------------------------------------------------ */

test("bootstrap runs once per sandbox and installs agent-browser + marker", async () => {
  const { sdk, state } = defaultFake();
  const b = browser({ sdk }, { apiKey: "k" });
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  const bootstraps = state.runs.filter((x) => x.cmd.includes(BOOTSTRAP_HINT));
  assert.equal(bootstraps.length, 1, "bootstrap must be one-shot");
  assert.match(bootstraps[0].cmd, /teachcast-agent-browser/);
  assert.match(bootstraps[0].cmd, /npm install -g agent-browser/);
  assert.ok(bootstraps[0].opts.timeoutMs >= 60_000, "bootstrap gets a generous budget");
});

test("a failing bootstrap raises a loud error naming the fix", async () => {
  const { sdk } = makeFakeSdk({
    run: ({ cmd }) =>
      cmd.includes(BOOTSTRAP_HINT)
        ? { exitCode: 1, stdout: "", stderr: "npm ENOTFOUND" }
        : { exitCode: 0, stdout: "ok", stderr: "" },
  });
  const b = browser({ sdk }, { apiKey: "k" });
  await assert.rejects(
    () => b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 }),
    /bootstrap failed.*e2b-template/s
  );
});

test("skipBootstrap (custom template) goes straight to commands", async () => {
  const { sdk, state } = defaultFake();
  const b = browser({ sdk }, { apiKey: "k", skipBootstrap: true });
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  assert.equal(state.runs.filter((x) => x.cmd.includes(BOOTSTRAP_HINT)).length, 0);
});

test("after reset() the bootstrap runs again for a fresh sandbox", async () => {
  const { sdk, state } = defaultFake();
  const b = browser({ sdk }, { apiKey: "k" });
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  b.reset();
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  assert.equal(state.created.length, 2);
  assert.equal(state.runs.filter((x) => x.cmd.includes(BOOTSTRAP_HINT)).length, 2);
});

/* ------------------------------------------------------------------ */
/* runArgs + readFileBase64 (managed console surface)                     */
/* ------------------------------------------------------------------ */

test("runArgs quotes each argv token and joins stdout/stderr", async () => {
  const { sdk, state } = defaultFake();
  const b = browser({ sdk }, { apiKey: "k" });
  const r = await b.runArgs(["--session", "teachcast-managed", "open", "https://chat.z.ai"], 30_000);
  assert.equal(r.ok, true);
  const cmd = state.runs[state.runs.length - 1].cmd;
  assert.equal(cmd, "agent-browser '--session' 'teachcast-managed' 'open' 'https://chat.z.ai'");
});

test("readFileBase64 returns base64 bytes from the sandbox, null on failure", async () => {
  const { sdk } = defaultFake();
  const b = browser({ sdk }, { apiKey: "k" });
  const b64 = await b.readFileBase64("/tmp/managed-1.png");
  assert.equal(b64, Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64"));

  const broken = makeFakeSdk({ readFile: () => Promise.reject(new Error("no file")) });
  const b2 = browser({ sdk: broken.sdk }, { apiKey: "k" });
  assert.equal(await b2.readFileBase64("/tmp/managed-2.png"), null);
});

test("kill tears the sandbox down and clears state", async () => {
  const { sdk, state } = defaultFake();
  const b = browser({ sdk }, { apiKey: "k" });
  await b.runCli({ session: "s", subcommand: "snapshot", timeoutMs: 1000 });
  const id = b.sandboxId();
  assert.equal(await b.kill(), true);
  assert.deepEqual(state.killed, [id]);
  assert.equal(b.sandboxId(), null);
});
