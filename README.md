# TeachCast v2

A chat-driven app builder. Describe an app in the chat and the build agent scaffolds it
in a live workspace: file tree, build status and preview update while it runs.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui (New York) · Prisma + SQLite · zustand

## Scripts

- `bun run dev` — dev server on port 3170 (Turbopack, single instance)
- `bun run lint` — ESLint
- `bun run db:push` — sync the Prisma schema to `db/custom.db`
- `bun run db:seed` — seed the welcome chat (idempotent)

## Delivery surface

- `GET /api/teachcast-status` — build phase, detail and progress
- `GET /api/source` — complete source tree as JSON
- `GET /api/workspace-preview` — placeholder preview served to the workspace iframe
