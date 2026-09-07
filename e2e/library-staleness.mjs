/**
 * M6 integration test — Library staleness (the live-reproduced production bug).
 *
 * The Library used to refetch ONLY when the view CHANGED. With the Library
 * already open, workflows created (or deleted) through the API never appeared
 * or kept showing forever. The fix: background revalidation while Library is
 * active — store-mutation version bumps, focus/visibility revalidation and a
 * gentle 10s poll — so external changes converge without any view toggling.
 *
 * This test drives a REAL browser (agent-browser) against the running app:
 *   1. open the app, navigate to Library
 *   2. POST /api/workflows (external mutation, Library stays open)
 *   3. WITHOUT any click/navigation: the new row must appear (<= ~25s)
 *   4. DELETE the same workflow via the API
 *   5. WITHOUT any click: the row must disappear (<= ~25s)
 *
 * Usage: node e2e/library-staleness.mjs  (env: TEACHCAST_URL, default
 * http://localhost:3005). Exits 0 on pass, 1 on fail.
 */
import { execFile } from "child_process";

const BASE = process.env.TEACHCAST_URL || "http://localhost:3005";
const SESSION = "tc-libstaleness-" + Math.random().toString(36).slice(2, 8);
const NAME = `staleness-${Date.now().toString(36)}`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${String(detail).slice(0, 300)}`}`);
  return ok;
};

function cli(args, timeout = 30_000) {
  return new Promise((resolve) => {
    execFile("agent-browser", ["--session", SESSION, ...args], { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout.toString() + stderr.toString()).trim() });
    });
  });
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

/** Poll a page condition WITHOUT touching the view (no clicks, no navigation). */
async function waitForPageCondition(expr, budgetMs, label) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < budgetMs) {
    const r = await cli(["eval", expr]);
    last = r.output;
    if (r.ok && last.includes("YES")) {
      console.log(`      ${label} converged after ${Math.round((Date.now() - start) / 1000)}s`);
      return true;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  console.log(`      ${label} did NOT converge within ${Math.round(budgetMs / 1000)}s (last: ${last.slice(0, 120)})`);
  return false;
}

let createdId = null;
let ok = true;

try {
  // -- 1. open the app and go to Library --------------------------------
  const open = await cli(["open", BASE]);
  if (!check("open app", open.ok, open.output)) throw new Error("cannot open app");
  await cli(["wait", "--load", "domcontentloaded"]);

  // find the Library nav ref from a fresh snapshot (never reuse stale refs)
  const snap = await cli(["snapshot", "--interactive", "--compact"]);
  let libRef = null;
  for (const line of snap.output.split("\n")) {
    if (line.includes('"Library"') && line.includes("ref=")) {
      libRef = line.split("ref=")[1].split("]")[0].trim();
      break;
    }
  }
  if (!check("library nav ref found", !!libRef, snap.output.slice(0, 300))) throw new Error("no Library ref");

  const click = await cli(["click", `@${libRef}`]);
  if (!check("navigate to Library", click.ok, click.output)) throw new Error("nav click failed");
  const seen = await cli(["wait", "--text", "Workflow Library", "--timeout", "15000"]);
  if (!check("library rendered", seen.ok, seen.output)) throw new Error("library heading never appeared");

  // -- 2. external create while Library is open --------------------------
  const created = await api("POST", "/api/workflows", {
    name: NAME,
    description: "Created while the Library view was already open (no view toggle afterwards).",
    steps: [{ kind: "message", payload: { text: "Step one" } }],
  });
  createdId = created.json?.id;
  if (!check("external create (API)", created.status >= 200 && created.status < 300 && createdId, created.text.slice(0, 200))) {
    throw new Error("create failed");
  }

  // -- 3. the row must appear WITHOUT any click/navigation ----------------
  const listed = await waitForPageCondition(
    `document.body?.innerText?.includes(${JSON.stringify(NAME)}) ? "YES" : "NO"`,
    25_000,
    "created row appears"
  );
  ok = check("created workflow appears with Library open (no view toggle)", listed);

  // -- 4. external delete while Library is open ---------------------------
  const deleted = await api("DELETE", `/api/workflows/${createdId}`);
  if (!check("external delete (API)", deleted.status >= 200 && deleted.status < 300, deleted.text.slice(0, 200))) {
    throw new Error("delete failed");
  }

  // -- 5. the row must disappear WITHOUT any click/navigation -------------
  const gone = await waitForPageCondition(
    `document.body?.innerText?.includes(${JSON.stringify(NAME)}) ? "NO_LONGER" : "YES_GONE"`,
    25_000,
    "deleted row disappears"
  );
  ok = ok && check("deleted workflow disappears with Library open (no view toggle)", gone);
  if (gone) createdId = null;
} catch (e) {
  ok = false;
  console.log(`FAIL  unexpected error — ${e?.message ?? e}`);
} finally {
  // cleanup: remove the test workflow, close the browser session
  if (createdId) await api("DELETE", `/api/workflows/${createdId}`).catch(() => {});
  await cli(["close"], 15_000);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n=== library-staleness: ${passed}/${results.length} checks passed ===`);
process.exit(ok && passed === results.length ? 0 : 1);
