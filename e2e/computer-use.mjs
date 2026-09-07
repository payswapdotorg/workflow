/**
 * M5 real-server integration test — production computer use, END TO END.
 *
 * Drives the running TeachCast app's /api/chat (real LLM, real tool loop,
 * real agent-browser Chromium) and asserts the architect's acceptance tasks:
 *
 *   A. acceptance: open https://example.com -> snapshot -> click "Learn more"
 *      BY REF -> wait -> verify the URL changed -> report.
 *   B. wait-condition: condition-based wait (--text) succeeds.
 *   C. structured failure: click a bogus ref -> tool_result ok:false with
 *      {"code":"UNKNOWN_REF",...}.
 *
 * Usage: node e2e/computer-use.mjs  (env: TEACHCAST_URL, default
 * http://localhost:3005). Writes e2e/computer-use-transcript.md.
 */
import { execFile } from "child_process";
import { promises as fs } from "fs";

const BASE = process.env.TEACHCAST_URL || "http://localhost:3005";
const TRANSCRIPT = new URL("./computer-use-transcript.md", import.meta.url).pathname;

const md = [];
const log = (s = "") => { console.log(s); md.push(s); };
const clip = (s, n = 900) => (s && s.length > n ? s.slice(0, n) + ` …[+${s.length - n} chars]` : s);

function cli(args) {
  return new Promise((resolve) => {
    execFile("agent-browser", ["--session", "teachcast-agent", ...args], { timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout.toString() + stderr.toString()).trim() });
    });
  });
}

/** One /api/chat tool-loop run over SSE. Returns tools, results, final text. */
async function runChat(userText, label) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system: "You are a computer-use agent operating a real browser through your tools. Complete the task exactly as stated, then report concisely in plain prose.",
      messages: [{ role: "user", content: userText }],
      enableTools: true,
      browserTarget: "agent",
    }),
    signal: AbortSignal.timeout(280_000),
  });
  if (!res.ok || !res.body) throw new Error(`${label}: /api/chat returned ${res.status}`);
  const out = { tools: [], results: [], text: "" };
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
        const delta = ev.choices?.[0]?.delta?.content;
        if (typeof delta === "string") out.text += delta;
      }
    }
  }
  return out;
}

const browserCalls = (run) => run.tools.filter((t) => t.name === "browser_control");
const browserResults = (run) => run.results.filter((r) => r.name === "browser_control");
const okById = (run) => new Map(browserResults(run).map((r) => [r.id, r]));

function dumpRun(run) {
  log(`\n**Tool calls (${run.tools.length}):**`);
  for (const t of run.tools) log(`- \`${t.name}\` ${clip(JSON.stringify(t.args), 300)}`);
  log(`\n**Tool results (${run.results.length}):**`);
  for (const r of run.results) log(`- \`${r.name}\` ok=${r.ok} → ${clip((r.output ?? "").replace(/\n/g, " ⏎ "), 400)}`);
  log(`\n**Final text:**`);
  log("> " + run.text.trim().replace(/\n/g, "\n> "));
}

const failures = [];
function check(name, cond, detail = "") {
  const pass = !!cond;
  log(`\n- [${pass ? "x" : " "}] **${pass ? "PASS" : "FAIL"}** ${name}${detail && !pass ? ` — ${detail}` : ""}`);
  if (!pass) failures.push(name);
}

/* ================= Task A: the acceptance task ================= */

log("# M5 E2E — production computer use (real server, real LLM, real Chromium)");
log(`\nServer: ${BASE} · started ${new Date().toISOString()}`);

log("\n## Task A — acceptance: open → snapshot → click 'Learn more' BY REF → wait → verify → report");
const TASK_A =
  "Open https://example.com in the browser. Take a snapshot, then click the 'Learn more' link BY REF (use the ref from your snapshot). " +
  "Wait for the new page to load, verify the URL changed away from example.com, and report the new URL and the new page's main heading.";
const a = await runChat(TASK_A, "A");
dumpRun(a);

const aCalls = browserCalls(a);
const aSnap = aCalls.find((t) => t.args?.action === "snapshot");
const aClick = aCalls.find((t) => t.args?.action === "click" && /^@?e\d+$/.test(String(t.args?.ref ?? "")));
const aMap = okById(a);
check("A1: took a snapshot before acting", !!aSnap);
check("A2: clicked by ref from the snapshot", !!aClick && !!aSnap && a.tools.findIndex((t) => t === aSnap) < a.tools.findIndex((t) => t === aClick));
check("A3: the by-ref click succeeded (tool_result ok:true)", !!aClick && aMap.get(aClick.id)?.ok === true, aClick ? JSON.stringify(aMap.get(aClick.id)?.output).slice(0, 200) : "no by-ref click");
check("A4: report names the real destination (iana)", /iana/i.test(a.text), a.text.slice(0, 200));
const urlAfter = await cli(["get", "url"]);
check("A5: the REAL browser navigated to iana.org", urlAfter.ok && /iana\.org/i.test(urlAfter.output), urlAfter.output);

/* ================= Task B: condition-based wait ================= */

log("\n## Task B — wait-condition case (no fixed sleeps in the toolset)");
const TASK_B =
  "Open https://example.com in the browser. Then use browser_control with action 'wait' and a TEXT condition to wait until the text 'Example Domain' appears on the page. Report the wait result.";
const b = await runChat(TASK_B, "B");
dumpRun(b);

const bWait = browserCalls(b).find((t) => t.args?.action === "wait" && !!t.args?.text);
const bMap = okById(b);
check("B1: used wait with a text condition", !!bWait, JSON.stringify(browserCalls(b).map((t) => t.args)));
check("B2: the wait succeeded (tool_result ok:true)", !!bWait && bMap.get(bWait.id)?.ok === true);
check("B3: report confirms the condition was met", /(condition|wait|met|success)/i.test(b.text), b.text.slice(0, 200));

/* ================= Task C: structured failure ================= */

log("\n## Task C — structured failure: bogus ref → UNKNOWN_REF, ok:false");
const TASK_C =
  "Using browser_control with action 'click', click the element with ref '@e42' right now, without taking any snapshot first. Then report exactly what the tool returned.";
const c = await runChat(TASK_C, "C");
dumpRun(c);

const cFail = browserResults(c).find((r) => r.ok === false && /"code":"UNKNOWN_REF"/.test(r.output ?? ""));
check("C1: a browser_control tool_result has ok:false", browserResults(c).some((r) => r.ok === false));
check("C2: the failure carries the structured {code:UNKNOWN_REF,...} line", !!cFail, JSON.stringify(browserResults(c).map((r) => [r.ok, (r.output ?? "").slice(0, 120)])));
check("C3: no phantom success — the model reports the failure, not a click", /(fail|error|unknown ref|could not|unable)/i.test(c.text), c.text.slice(0, 200));

/* ================= verdict ================= */

log("\n## Verdict");
if (failures.length === 0) {
  log("\n**ALL CHECKS PASSED** — acceptance task, wait-condition case and structured-failure case all green against the real app.");
} else {
  log(`\n**${failures.length} CHECK(S) FAILED**: ${failures.join("; ")}`);
  process.exitCode = 1;
}

await fs.writeFile(TRANSCRIPT, md.join("\n") + "\n", "utf8");
console.log(`\ntranscript: ${TRANSCRIPT}`);
