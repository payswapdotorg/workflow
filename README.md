# TeachCast — Computer-Use Teaching Studio

Share your real screen, teach a real LLM a workflow through a live narrated session, save that workflow as a launchable app, then replay it step by step against your live screen while the LLM analyzes frames and narrates progress.

## What it does

- **Session** — a split view: your live screen on the left (browser Screen Capture API, streamed locally), a teaching chat on the right. Every chat message and manual snapshot captures a canvas frame of your screen at that exact moment and records it as an event with a timestamp. The assistant has the full agent toolset and can act on the computer when you ask it to.
- **Library** — saved workflows appear as app cards (name, description, step count, last run). Install a workflow to make it launchable.
- **Replay** — launching a workflow replays it step by step against your live screen: progress bar, per-step cards with the active step highlighted, Pause/Resume/Stop controls, and per-step LLM narration analyzing live frames. The narrator can **act on the computer** to perform steps (create files, run commands, drive a browser). You can chat with the LLM mid-replay.
- **Settings** — connect any OpenAI-compatible provider (endpoint + model + API key). The key is stored server-side (SQLite via Prisma) and never exposed to the browser. Without a custom provider, TeachCast uses a real built-in LLM (text-only, no mocks).

## Requirements

- Node.js / Bun
- Desktop Chrome, Edge, or Firefox for screen sharing (the app must run in a top-level tab — use the "Open in new tab" button when embedded)

## Getting started

```bash
bun install
bun run db:push     # create the SQLite database
bun run dev         # http://localhost:3000
```

Production:

```bash
bun run build
bun run start
```

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

## Agent toolset

TeachCast's LLM mirrors the chat.z.ai agent toolset and can act on the computer, not just narrate:

| Tool | What it does |
|------|--------------|
| `read_file` | read a workspace file or list a directory |
| `write_file` | create / overwrite / append a workspace file |
| `run_shell` | run a bash command (workspace cwd, 30s default timeout) |
| `run_code` | execute Python or Node.js scripts |
| `browser_control` | drive a real Chromium: open, snapshot, click, type, url, close |

Tools are enabled in teaching chat, replay narration, and replay chat. Custom OpenAI-compatible providers use native function calling; providers without function-call support automatically fall back to a JSON tool protocol. Tool executions stream into the UI as live activity rows with expandable output. All file/code tools are rooted at the auto-created `workspace/` directory; path traversal outside it is blocked.

## Privacy

Frames and chat stay in your browser except for the text (and frames you send to your configured provider) during LLM calls. Nothing is mocked: the screen stream is your real screen, the LLM responses come from a real provider, and workflows persist in SQLite.
