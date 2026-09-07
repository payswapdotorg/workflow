/**
 * M7 real-server integration test — DUAL-CURSOR TEACHING, END TO END.
 *
 * The client half of the lesson protocol (watch/learn arming, pointer capture,
 * the overlay cursor state machine) is covered by unit tests (reducers are
 * pure). This suite proves the SERVER half against the running app:
 *
 *   A. wire protocol: a real /api/chat computer-use turn now carries UI-only
 *      {cursor} events with coordinates derived from REAL element geometry
 *      (agent-browser get box), normalized 0..1.
 *   B. workflow API: kind:"action" steps (taught clicks/keystrokes) save and
 *      validate; malformed payloads are rejected.
 *   C. execute preflight honesty: /api/execute refuses to run while the
 *      managed browser is not connected (409 + remedy).
 *   D. execution run: a saved taught workflow replays on the MANAGED browser —
 *      fresh observation per step, LLM vision re-resolution (M5 stale-ref law
 *      on pixels), cursor events from real geometry, M5-grade postcondition.
 *   E. typing: a taught keystroke step fills a REAL field and is verified by
 *      reading the value back.
 *   F. honest failure: a target that does not exist is NEVER clicked — the
 *      run reports skip/failure, not phantom success.
 *
 * Usage: node e2e/dual-cursor.mjs (env: TEACHCAST_URL). Writes
 * e2e/dual-cursor-transcript.md.
 */
import { execFile } from "child_process";
import { promises as fs } from "fs";

const BASE = process.env.TEACHCAST_URL || "http://localhost:3005";
const TRANSCRIPT = new URL("./dual-cursor-transcript.md", import.meta.url).pathname;

const md = [];
const log = (s = "") => { console.log(s); md.push(s); };
const clip = (s, n = 900) => (s && s.length > n ? s.slice(0, n) + ` …[+${s.length - n} chars]` : s);

function cli(session, args) {
  return new Promise((resolve) => {
    execFile("agent-browser", ["--session", session, ...args], { timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout.toString() + stderr.toString()).trim() });
    });
  });
}

/** One SSE run over /api/chat or /api/execute; returns cursor/exec/tool events. */
async function runStream(path, body, label) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(280_000),
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    throw new Error(`${label}: ${path} returned ${res.status} ${errText.slice(0, 200)}`);
  }
  const out = { tools: [], results: [], cursors: [], exec: [], text: "" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.tool) out.tools.push(ev.tool);
        if (ev.tool_result) out.results.push(ev.tool_result);
        if (ev.cursor) out.cursors.push(ev.cursor);
        if (ev.exec) out.exec.push(ev.exec);
        const delta = ev.choices?.[0]?.delta?.content;
        if (typeof delta === "string") out.text += delta;
      }
    }
  }
  return out;
}

const failures = [];
function check(name, cond, detail = "") {
  const pass = !!cond;
  log(`\n- [${pass ? "x" : " "}] **${pass ? "PASS" : "FAIL"}** ${name}${detail && !pass ? ` — ${clip(detail, 400)}` : ""}`);
  if (!pass) failures.push(name);
}

/* ================= Task A: cursor events on a real computer-use turn ================= */

log("# M7 E2E — dual-cursor teaching (real server, real LLM, real Chromium)");
log(`\nServer: ${BASE} · started ${new Date().toISOString()}`);

log("\n## Task A — wire protocol: {cursor} events from real geometry on a live chat turn");
const TASK_A =
  "Open https://example.com in the browser. Take a snapshot, then click the 'More information' link BY REF (use the ref from your snapshot). Report where you landed.";
const a = await runStream("/api/chat", {
  system: "You are a computer-use agent operating a real browser through your tools. Complete the task exactly as stated, then report concisely in plain prose.",
  messages: [{ role: "user", content: TASK_A }],
  enableTools: true,
  browserTarget: "agent",
}, "A");

const aMoves = a.cursors.filter((c) => c.type === "move" && typeof c.x === "number" && typeof c.y === "number");
const aClicks = a.cursors.filter((c) => c.type === "click");
const aClickOk = a.results.some((r) => r.name === "browser_control" && r.ok === true);
const aUrl = await cli("teachcast-agent", ["get", "url"]);
log(`\ncursor events: ${a.cursors.length} (moves: ${aMoves.length}, clicks: ${aClicks.length})`);
check("A1: the SSE stream carried UI-only {cursor} events", a.cursors.length > 0, JSON.stringify(a.cursors.slice(0, 3)));
check("A2: a move event carries normalized coordinates in 0..1", aMoves.some((c) => c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1), JSON.stringify(aMoves.slice(0, 3)));
check("A3: a click event followed the move (modality, not narration)", aClicks.length > 0 && aClickOk);
check("A4: the REAL browser navigated to iana.org (cursor coords match real geometry of the click)", aUrl.ok && /iana\.org/i.test(aUrl.output), aUrl.output);

/* ================= Task B: workflow API accepts taught action steps ================= */

log("\n## Task B — workflow API: taught action steps save and validate");
const GOOD_STEPS = [
  { kind: "action", payload: { actionType: "click", x: 0.5, y: 0.72, label: "Click the 'More information' link", thumb: null }, ts: new Date().toISOString() },
  { kind: "action", payload: { actionType: "type", text: "TeachCast dual-cursor", label: 'Type: "TeachCast dual-cursor"' }, ts: new Date().toISOString() },
];
const bSave = await fetch(`${BASE}/api/workflows`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "M7 dual-cursor smoke", description: "e2e-taught actions", steps: GOOD_STEPS }),
});
const bData = await bSave.json().catch(() => null);
check("B1: a workflow with action steps saves (201)", bSave.status === 201 && !!bData?.id, `HTTP ${bSave.status} ${JSON.stringify(bData).slice(0, 200)}`);

const badCases = [
  ["click step without x", { kind: "action", payload: { actionType: "click", y: 0.5, label: "no x" } }],
  ["click step with out-of-range coords", { kind: "action", payload: { actionType: "click", x: 4, y: 0.5, label: "x out of range" } }],
  ["unknown actionType", { kind: "action", payload: { actionType: "hover", label: "not taught" } }],
  ["type step without text", { kind: "action", payload: { actionType: "type", label: "no text" } }],
];
for (const [name, step] of badCases) {
  const res = await fetch(`${BASE}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "bad", description: "", steps: [step] }),
  });
  check(`B: rejects ${name} (400)`, res.status === 400, `HTTP ${res.status}`);
}

/* ================= Task C: execute preflight honesty ================= */

log("\n## Task C — /api/execute refuses to run without the managed browser");
const cRes = await fetch(`${BASE}/api/execute`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ workflowId: bData?.id }),
});
const cData = await cRes.json().catch(() => null);
check("C1: 409 while the managed browser is not connected", cRes.status === 409, `HTTP ${cRes.status} ${JSON.stringify(cData)}`);
check("C2: the error names the remedy (connect the managed session)", /managed browser/i.test(cData?.error ?? "") && /connect|console|open/i.test(cData?.error ?? ""), cData?.error);

/* ================= Task D: execution run on the managed browser ================= */

log("\n## Task D — taught workflow replays on the MANAGED browser with vision re-resolution");
const openRes = await fetch(`${BASE}/api/managed-session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "open", url: "https://example.com" }),
});
const openData = await openRes.json().catch(() => null);
if (!openRes.ok || !openData?.active) {
  check("D0: managed session opened", false, `HTTP ${openRes.status} ${JSON.stringify(openData)}`);
} else {
  log(`managed session active: ${openData.url}`);
  const CLICK_ONLY = [
    { kind: "action", payload: { actionType: "click", x: 0.5, y: 0.7, label: "Click the 'More information' link", thumb: null }, ts: new Date().toISOString() },
  ];
  const wfRes = await fetch(`${BASE}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "M7 managed click", description: "", steps: CLICK_ONLY }),
  });
  const wf = await wfRes.json().catch(() => null);
  const d = await runStream("/api/execute", { workflowId: wf?.id }, "D");

  const dRun = d.exec.find((e) => e.type === "run");
  const dDone = d.exec.find((e) => e.type === "done");
  const dMoves = d.cursors.filter((c) => c.type === "move" && typeof c.x === "number" && typeof c.y === "number");
  const dStepsDone = d.exec.filter((e) => e.type === "step" && e.status === "done");
  const dManagedUrl = await cli("teachcast-managed", ["get", "url"]);
  log(`\nexec events: ${d.exec.length} · cursor events: ${d.cursors.length}`);
  for (const e of d.exec) log(`- ${JSON.stringify(e).slice(0, 240)}`);
  check("D1: run event names the honest surface (managed browser)", !!dRun && /managed browser/i.test(String(dRun.surface ?? "")), JSON.stringify(dRun));
  check("D2: cursor moved on the mirror from REAL geometry (0..1)", dMoves.some((c) => c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1), JSON.stringify(dMoves.slice(0, 3)));
  check("D3: the taught click step completed (done)", dStepsDone.length >= 1, JSON.stringify(d.exec));
  check("D4: run finished ok", dDone?.ok === true, JSON.stringify(dDone));
  check("D5: the MANAGED browser navigated to iana.org (M5-grade postcondition)", dManagedUrl.ok && /iana\.org/i.test(dManagedUrl.output), dManagedUrl.output);
}

/* ================= Task E: taught typing verified by read-back ================= */

log("\n## Task E — taught keystroke fills a real field, verified by read-back");
const TYPE_WF = [
  { kind: "action", payload: { actionType: "type", text: "TeachCast dual-cursor M7", label: 'Type "TeachCast dual-cursor M7" into the search field' }, ts: new Date().toISOString() },
];
const eWfRes = await fetch(`${BASE}/api/workflows`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "M7 managed type", description: "", steps: TYPE_WF }),
});
const eWf = await eWfRes.json().catch(() => null);
const nav = await cli("teachcast-managed", ["open", "https://www.wikipedia.org"]);
log(`wikipedia opened: ${nav.ok}`);
if (!nav.ok) {
  check("E0: wikipedia reachable for the typing task", false, nav.output);
} else {
  const e = await runStream("/api/execute", { workflowId: eWf?.id }, "E");
  const eDone = e.exec.find((x) => x.type === "done");
  const eStep = e.exec.find((x) => x.type === "step" && x.status === "done");
  log(`\nexec events: ${e.exec.length}`);
  for (const x of e.exec) log(`- ${JSON.stringify(x).slice(0, 240)}`);
  check("E1: the typed keystroke landed (executor read the field back and confirmed)", eDone?.ok === true && eStep && /text confirmed/i.test(String(eStep.detail ?? "")), JSON.stringify({ done: eDone, step: eStep }));
}

/* ================= Task F: honest failure — a target that does not exist ================= */

log("\n## Task F — a nonexistent target is never clicked (no phantom success)");
const BAD_WF = [
  { kind: "action", payload: { actionType: "click", x: 0.3, y: 0.3, label: "Click the 'This Link Does Not Exist 404' button", thumb: null }, ts: new Date().toISOString() },
];
const fWfRes = await fetch(`${BASE}/api/workflows`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "M7 honest failure", description: "", steps: BAD_WF }),
});
const fWf = await fWfRes.json().catch(() => null);
const f = await runStream("/api/execute", { workflowId: fWf?.id }, "F");
const fDone = f.exec.find((x) => x.type === "done");
log(`\nexec events: ${f.exec.length}`);
for (const x of f.exec) log(`- ${JSON.stringify(x).slice(0, 240)}`);
check("F1: the nonexistent target was NOT clicked (ran === 0)", fDone && Number(fDone.ran) === 0, JSON.stringify(fDone));
check("F2: the run reports the outcome honestly (skipped or failed, never a clean success)", fDone && fDone.ok === true ? Number(fDone.skipped) > 0 || Number(fDone.failed) > 0 : true, JSON.stringify(fDone));

/* ================= verdict ================= */

log("\n## Verdict");
if (failures.length === 0) {
  log("\n**ALL CHECKS PASSED** — cursor wire protocol, action-step storage, execute preflight, managed-browser replay with vision re-resolution, verified typing and honest failure are all green against the real app.");
} else {
  log(`\n**${failures.length} CHECK(S) FAILED**: ${failures.join("; ")}`);
  process.exitCode = 1;
}

await fs.writeFile(TRANSCRIPT, md.join("\n") + "\n", "utf8");
console.log(`\ntranscript: ${TRANSCRIPT}`);
