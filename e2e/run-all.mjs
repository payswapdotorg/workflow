/**
 * M6 verify runner — boots a HERMETIC dev instance, runs every e2e suite,
 * tears everything down. `bun run verify` = unit tests + production build +
 * this script.
 *
 * Hermetic by construction:
 *   - its own throwaway SQLite database (db/e2e-<ts>.db, deleted after)
 *   - its own port (default 3100, env E2E_PORT) — never touches a running
 *     operator instance
 *   - ENABLE_DEBUG_ROUTES=1 so the api-timeout suite can exercise the hang
 *     guard (the route 404s without the flag)
 *
 * Suites, in order:
 *   1. e2e/api-timeout.mjs      (route guard + health endpoint)
 *   2. e2e/library-staleness.mjs (M6 fix 1, real browser)
 *   3. e2e/computer-use.mjs      (M5 acceptance: real LLM tool loop + refs)
 *
 * Prerequisites: agent-browser on PATH (suites 2-3), network access (suite 3
 * drives example.com/iana.org through the real LLM).
 */
import { spawn, execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.E2E_PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = path.join(ROOT, "e2e", ".server.log");
const DB = path.join(ROOT, "db", `e2e-${Date.now()}.db`);

const suites = [
  "e2e/api-timeout.mjs",
  "e2e/library-staleness.mjs",
  "e2e/computer-use.mjs",
];

const log = (s = "") => console.log(s);

function closeSession(session) {
  return new Promise((resolve) => {
    execFile("agent-browser", ["--session", session, "close"], { timeout: 20_000 }, () => resolve());
  });
}

async function waitForHealthy(budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(4_000) });
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

async function main() {
  log(`=== TeachCast e2e runner ===`);
  log(`base: ${BASE}`);
  log(`db:   ${DB} (throwaway)`);
  let server = null;
  let logFd = null;
  const failures = [];

  try {
    /* 1. schema into the throwaway database */
    await fs.mkdir(path.dirname(DB), { recursive: true });
    await new Promise((resolve, reject) => {
      const p = spawn("npx", ["prisma", "db", "push", "--accept-data-loss", "--skip-generate"], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: `file:${DB}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const out = [];
      p.stdout.on("data", (d) => out.push(d));
      p.stderr.on("data", (d) => out.push(d));
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`prisma db push exited ${code}\n${out.join("")}`))));
    });
    log("schema pushed to throwaway db");

    /* 2. boot the dev server in its own process group */
    logFd = await fs.open(LOG, "w");
    server = spawn("node", ["node_modules/next/dist/bin/next", "dev", "-p", String(PORT)], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: `file:${DB}`,
        ENABLE_DEBUG_ROUTES: "1",
      },
      detached: true,
      stdio: ["ignore", logFd.fd, logFd.fd],
    });
    log(`server pid ${server.pid} (log: e2e/.server.log)`);

    /* 3. wait for health (cold dev compile takes a while) */
    log("waiting for /api/health ...");
    const healthy = await waitForHealthy(180_000);
    if (!healthy) throw new Error("server never became healthy within 180s (see e2e/.server.log)");
    log("server healthy\n");

    /* 4. suites */
    for (const suite of suites) {
      log(`\n--- ${suite} ---`);
      const code = await new Promise((resolve) => {
        const p = spawn("node", [suite], {
          cwd: ROOT,
          env: { ...process.env, TEACHCAST_URL: BASE },
          stdio: "inherit",
        });
        p.on("exit", resolve);
      });
      if (code !== 0) failures.push(suite);
    }
  } catch (e) {
    failures.push(`runner: ${e?.message ?? e}`);
  } finally {
    /* 5. teardown: suites close their own browser sessions; free the agent
       session the computer-use suite drives, then the server, then the db */
    await closeSession("teachcast-agent");
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM"); /* negative pid = whole group */
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 1_000));
    if (logFd) await logFd.close().catch(() => {});
    await fs.rm(DB, { force: true }).catch(() => {});
  }

  log("");
  if (failures.length) {
    log(`=== e2e FAILED: ${failures.length} suite(s) — ${failures.join(", ")} ===`);
    process.exit(1);
  }
  log(`=== e2e: all ${suites.length} suites passed ===`);
  process.exit(0);
}

main();
