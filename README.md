# TeachCast — Computer-Use Teaching Studio

Share your real screen, teach a real LLM a workflow through a live narrated session, save that workflow as a launchable app, then replay it step by step against your live screen while the LLM analyzes frames and narrates progress.

## What it does

- **Session** — a split view: your live screen on the left (browser Screen Capture API, streamed locally), a teaching chat on the right. Every chat message and manual snapshot captures a canvas frame of your screen at that exact moment and records it as an event with a timestamp. The assistant has the full agent toolset and can act on the computer when you ask it to.
- **Library** — saved workflows appear as app cards (name, description, step count, last run). Install a workflow to make it launchable.
- **Replay** — launching a workflow replays it step by step against your live screen: progress bar, per-step cards with the active step highlighted, Pause/Resume/Stop controls, and per-step LLM narration analyzing live frames. The narrator can **act on the computer** to perform steps (create files, run commands, drive a browser). You can chat with the LLM mid-replay.
- **Settings** — connect any OpenAI-compatible provider (endpoint + model + API key). The key is stored server-side (SQLite via Prisma) and never exposed to the browser. Without a custom provider, TeachCast uses a real built-in LLM (text-only, no mocks).

## Requirements

- Node.js 20+ (or Bun 1.2+)
- `agent-browser` CLI on PATH — required for the browser tools and the managed-session console (the computer-use half of TeachCast); everything else works without it
- Desktop Chrome, Edge, or Firefox for screen sharing (the app must run in a top-level tab — use the "Open in new tab" button when embedded)

## Getting started (fresh clone)

```bash
cp .env.example .env        # DATABASE_URL for the SQLite database
bun install                 # or: npm install
bun run db:generate         # prisma client
bun run db:push             # create the SQLite database (db/ is gitignored)
bun run dev                 # http://localhost:3000
```

No LLM keys are needed to boot: provider settings (endpoint / model / key) are configured in the app under **Settings** and stored server-side; without a configured provider TeachCast uses its real built-in fallback LLM.

Production:

```bash
bun run build
bun run start
```

## Verify everything

One command runs the whole battery — unit tests, a production build, and the e2e suites against a hermetic dev instance (throwaway SQLite database, own port, auto teardown):

```bash
bun run verify              # = npm test + npm run build + npm run e2e
npm test                    # unit tests only (node --test tests/)
npm run e2e                 # e2e suites only (boots its own server on :3100)
```

The e2e suites are real integration tests: `e2e/api-timeout.mjs` proves the route hang guard over HTTP, `e2e/library-staleness.mjs` drives a real browser against the Library, and `e2e/computer-use.mjs` runs the M5 acceptance task end to end (real LLM, real tool loop, real Chromium). They need `agent-browser` on PATH and network access. The architect's independent harness can be run the same way: `python3 e2e/architect-suite.py --base http://127.0.0.1:3100`.

## The operator's loop

TeachCast turns a live demonstration into a re-runnable app:

1. **Teach** — Session view: share your screen, perform the task while narrating it in the chat. Every message and manual snapshot records a real frame + text event.
2. **Save** — hit Save: the LLM compiles your recorded events into a named workflow (review/edit before saving). The new workflow appears in the Library immediately — no view toggling needed.
3. **Install** — Library: press Install on the card to make it launchable. Optionally claim the exclusive **launch-on-start** slot so TeachCast boots straight into it.
4. **Launch** — Library: press Launch; TeachCast switches to the Replay view for that workflow.
5. **Replay** — share your screen again and press Start: the workflow replays step by step against your live screen with per-step LLM narration, and the narrator can act on the computer (files, shell, browser) to actually perform each step. Chat mid-replay to steer it.

## Architecture

| Area | Where | Notes |
|------|-------|-------|
| Data model | `prisma/schema.prisma` | `Workflow {id, name, description, steps[]}`, `Step {kind: message \| snapshot, payload, ts}` |
| Client state | `src/lib/store.ts` | zustand; the store instance survives HMR via a dev-only globalThis cache |
| Screen capture | `src/lib/screen.ts`, `src/components/teachcast/screen-stage.tsx` | `getDisplayMedia`, canvas frame snapshots, permission watchdog, graceful track-ended handling |
| Streaming chat | `src/app/api/chat/route.ts` | OpenAI-compatible SSE passthrough for custom providers; real built-in LLM fallback |
| Workflow compile | `src/app/api/compile/route.ts` | the LLM compiles recorded events into named, replayable steps |
| Replay engine | `src/lib/replay-engine.ts` | module-level runner: pause/resume/stop, per-step narration, run marking |
| Agent toolset | `src/lib/tool-catalog.ts`, `src/lib/tools.ts`, `src/app/api/tools/exec/route.ts` | mirrors the chat.z.ai agent toolset — `read_file`, `write_file`, `run_shell`, `run_code`, `browser_control` — executed for real on the host, rooted at `workspace/` |
| Settings | `src/app/api/settings/route.ts` | endpoint/model/key stored server-side, key masked in responses |
| Route hang guard | `src/lib/api-guard.ts` | every non-streaming JSON route is wrapped in a response deadline; structured 503 instead of silence |
| Health | `src/app/api/health/route.ts` | db ping (hard dep) + browser daemon probe (soft dep), self-bounded checks |

## Agent toolset

TeachCast's LLM mirrors the chat.z.ai agent toolset and can act on the computer, not just narrate:

| Tool | What it does |
|------|--------------|
| `read_file` | read a workspace file or list a directory |
| `write_file` | create / overwrite / append a workspace file |
| `run_shell` | run a bash command (workspace cwd, 30s default timeout) |
| `run_code` | execute Python or Node.js scripts |
| `browser_control` | drive a real Chromium by refs from live snapshots: `navigate, snapshot, click, click_coords, fill, type, press, select, hover, scroll, scroll_into_view, wait, read, verify, screenshot, dialog` |

Tools are enabled in teaching chat, replay narration, and replay chat. Custom OpenAI-compatible providers use native function calling; providers without function-call support automatically fall back to a JSON tool protocol. Tool executions stream into the UI as live activity rows with expandable output. All file/code tools are rooted at the auto-created `workspace/` directory; path traversal outside it is blocked.

### browser_control failure codes

Every `browser_control` failure returns one compact JSON line `{code, message, remedy}` — a failed action is never reported as success, and CLI exit codes propagate:

| Code | Meaning | Remedy returned to the model |
|------|---------|------------------------------|
| `UNKNOWN_REF` | the ref was never in any snapshot (refs are never guessable) | run `snapshot` first and act on a ref it printed |
| `STALE_REF` | the ref died with the last page change; the tool re-snapshotted and retried once, then reports with the fresh snapshot embedded | re-snapshot and pick the current ref for the same element |
| `CLICK_COVERED` | another element intercepts the pointer | close overlays, `scroll_into_view`, or `click_coords` as a last resort |
| `TIMEOUT` | the wait condition never became true within the budget | check the condition or verify the page state |
| `BROWSER_UNAVAILABLE` | transient host/daemon failure (spawn `EAGAIN`/`ENOBUFS`/`ENFILE`, "Error executing binary", dead daemon "Not attached to an active page") persisted after one ~2s backoff retry | the browser session is unavailable; re-navigate before the next ref action |
| `CLI_ERROR` | the browser command itself failed | read the message; re-snapshot if the page may have changed |
| `INVALID_ARGS` | arguments failed validation (unknown action, or wrong type — e.g. a boolean where a string is required) | fix the arguments to match the action's schema |

## Production hardening (M6)

**No silent API hangs.** Under host memory pressure a Prisma call once never settled, leaving clients waiting forever. Every non-streaming JSON route now runs under `withRouteTimeout()` (`src/lib/api-guard.ts`): if the handler does not settle within its budget the client receives a structured `503 {error:{code:"ROUTE_TIMEOUT",message,remedy}}`, and the server logs the runaway. Budgets are tuned per route: data routes 30s, tool execution and managed-session 60s, workflow compile 120s. The streaming `/api/chat` route is bounded instead by its own SSE watchdogs (15s keepalive, 45s idle abort, 120s total abort).

**Health endpoint.** `GET /api/health` reports component status with self-bounded checks so it can never hang itself: `db` (a failed ping degrades the response to 503 — it is a hard dependency) and `browser` (the agent-browser daemon probe — a soft dependency, reported but never degrading).

**Library freshness.** The Library revalidates while it is open: store workflow mutations (save / install / delete / launch-on-start / replay run-mark) bump a version that triggers a background refetch, re-entering the Library via its nav button refetches, and external changes (another tab, an LLM tool call, the API) are caught by focus/visibility revalidation and a gentle 10s poll while the list is on screen.

## Long-running sessions (M3)

TeachCast is built to stay open for hours. Three systems keep that honest:

- **Session watchdog** (`src/lib/session-watchdog.ts`) — while a turn is active, the UI requires real progress (deltas, tool events) at least every 6 minutes (tunable via `localStorage.teachcast.hangThresholdMs`). On a hang (frozen message + active spinner), it saves the sent text, reloads the app, restores it, and resubmits. A 3-minute cooldown suppresses reload loops; a suppressed hang surfaces in the status panel with a manual "Reload & recover now" action. The server feeds SSE keepalive comments during long tool runs so legitimate work is never mistaken for a hang.
- **Session status panel** (header activity icon) — live turn clock, last-real-progress age, hang threshold, screen-share and replay state, and recovery controls.
- **Launch-on-start** — an installed workflow can claim the exclusive "launch on start" slot (Library → card menu). TeachCast then boots straight into the Replay view for it, pre-armed: share your screen and press Start. (Browsers require a user gesture for `getDisplayMedia`, so the one click stays with you.)

## Managed-session console (M3 groundwork)

The header Console button opens the operator's side panel:

- **Live replay mirror** — samples the shared screen at 2 fps into a canvas with a real frame counter.
- **Operator → LLM** — a message-only line to the LLM (current frame attached, tools enabled); messages are not recorded as workflow steps.
- **Managed session** — a dedicated agent-browser session (`teachcast-managed`, separate from the toolset's own browser) with connect / snapshot / disconnect controls. Groundwork for the LLM supervising an external chat.z.ai session from this panel; the LLM-facing tool wiring lands in a follow-up milestone (`/api/managed-session`).

## Privacy

Frames and chat stay in your browser except for the text (and frames you send to your configured provider) during LLM calls. Nothing is mocked: the screen stream is your real screen, the LLM responses come from a real provider, and workflows persist in SQLite.
