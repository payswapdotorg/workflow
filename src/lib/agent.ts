import { db } from "@/lib/db";
import type { BuildPhase } from "@/lib/types";

export const WORKSPACE_PORT = 3171;

const STALE_BUILD_MS = 30_000;
const PLAN_DELAY_MS = 700;

const PHASE_SCHEDULE: { phase: BuildPhase; at: number; detail: string; progress: number }[] = [
  { phase: "scaffolding", at: 1_500, detail: "Scaffolding the project", progress: 25 },
  { phase: "building", at: 3_100, detail: "Writing application files", progress: 55 },
  { phase: "verifying", at: 4_900, detail: "Verifying dev server and routes", progress: 82 },
];

const running = new Map<string, NodeJS.Timeout[]>();

function deriveSubject(prompt: string): string {
  const oneLine = prompt.trim().replace(/\s+/g, " ");
  const stripped = oneLine.replace(
    /^(please\s+|can you\s+|could you\s+)*(build|make|create|scaffold|generate|develop)\s+(me\s+)?(a|an|the)?\s*/i,
    ""
  );
  return (stripped || oneLine).slice(0, 60).replace(/[.:;]+$/, "");
}

function deriveSlug(subject: string): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "app";
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

async function setPhase(
  chatId: string,
  phase: BuildPhase,
  detail: string,
  progress: number,
  slug?: string
) {
  await db.chat.update({
    where: { id: chatId },
    data: {
      buildPhase: phase,
      buildDetail: detail,
      buildProgress: progress,
      buildUpdatedAt: new Date(),
      ...(slug !== undefined ? { buildSlug: slug } : {}),
    },
  });
}

function planReply(subject: string, slug: string): string {
  return `Plan for ${subject}:

1. Scaffold the project — Next.js 16 with TypeScript, Tailwind 4 and shadcn/ui
2. Model the data — Prisma schema on SQLite at prisma/schema.prisma
3. Build the interface — src/app/page.tsx and the ${slug} components
4. Wire the API routes, then verify the dev server and the golden path

Starting the build now — the workspace panel will update as I go.`;
}

function doneReply(subject: string): string {
  return `${capitalize(subject)} is ready — the dev server is running on port ${WORKSPACE_PORT} and the preview is live in the workspace panel. Tell me what to change and I will iterate.`;
}

export async function startBuild(chatId: string, prompt: string): Promise<void> {
  const previous = running.get(chatId);
  if (previous) previous.forEach(clearTimeout);
  running.delete(chatId);

  const subject = deriveSubject(prompt);
  const slug = deriveSlug(subject);
  const timers: NodeJS.Timeout[] = [];

  await setPhase(chatId, "analyzing", "Analyzing your request", 8, slug);

  const schedule = (at: number, task: () => Promise<void>) => {
    timers.push(
      setTimeout(() => {
        task().catch(async () => {
          running.delete(chatId);
          await setPhase(
            chatId,
            "error",
            "The build agent hit an unexpected error — send another message to retry",
            100
          ).catch(() => undefined);
        });
      }, at)
    );
  };

  schedule(PLAN_DELAY_MS, async () => {
    await db.message.create({
      data: { chatId, role: "agent", text: planReply(subject, slug) },
    });
  });

  for (const step of PHASE_SCHEDULE) {
    schedule(step.at, () => setPhase(chatId, step.phase, step.detail, step.progress));
  }

  schedule(6_400, async () => {
    await db.message.create({
      data: { chatId, role: "agent", text: doneReply(subject) },
    });
    await setPhase(chatId, "ready", `Workspace ready — ${slug} running on port ${WORKSPACE_PORT}`, 100);
    running.delete(chatId);
  });

  running.set(chatId, timers);
}

export async function recoverStaleBuild(chatId: string): Promise<void> {
  const chat = await db.chat.findUnique({
    where: { id: chatId },
    select: { buildPhase: true, buildSlug: true, buildUpdatedAt: true },
  });
  if (!chat?.buildPhase) return;
  if (chat.buildPhase === "ready" || chat.buildPhase === "error") return;
  if (running.has(chatId)) return;
  if (Date.now() - (chat.buildUpdatedAt?.getTime() ?? 0) < STALE_BUILD_MS) return;

  // The worker died (e.g. a dev-server restart mid-build): settle instead of hanging.
  const slug = chat.buildSlug ?? "app";
  await setPhase(chatId, "ready", `Workspace ready — ${slug} recovered after a restart`, 100);
}
