# TeachCast — Computer-Use Teaching Studio

Share your real screen, teach a real LLM a workflow through a live narrated session, save that workflow as a launchable app, then replay it step by step against your live screen while the LLM analyzes frames and narrates progress.

## What it does

- **Session** — a split view: your live screen on the left (browser Screen Capture API, streamed locally), a teaching chat on the right. Every chat message and manual snapshot captures a canvas frame of your screen at that exact moment and records it as an event with a timestamp.
- **Library** — saved workflows appear as app cards (name, description, step count, last run). Install a workflow to make it launchable.
- **Replay** — launching a workflow replays it step by step against your live screen: progress bar, per-step cards with the active step highlighted, Pause/Resume/Stop controls, and per-step LLM narration analyzing live frames. You can chat with the LLM mid-replay.
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
| Settings | `src/app/api/settings/route.ts` | endpoint/model/key stored server-side, key masked in responses |

## Privacy

Frames and chat stay in your browser except for the text (and frames you send to your configured provider) during LLM calls. Nothing is mocked: the screen stream is your real screen, the LLM responses come from a real provider, and workflows persist in SQLite.
