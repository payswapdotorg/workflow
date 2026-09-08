import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.chat.count();
  if (existing > 0) return;

  const chat = await prisma.chat.create({
    data: {
      title: "Welcome to TeachCast",
      buildPhase: "ready",
      buildDetail: "Sample workspace ready — start a new chat to build your own app",
      buildProgress: 100,
      buildSlug: "sample-workspace",
      buildUpdatedAt: new Date(),
    },
  });

  await prisma.message.create({
    data: {
      chatId: chat.id,
      role: "agent",
      text: "Welcome to TeachCast v2. Describe an app in plain language and I will scaffold it in the workspace — the file tree, build status and preview update live while I work. The sample workspace in this chat shows what a finished build looks like. Start a new chat and try something like: build me a todo app with priorities.",
    },
  });

  console.log("Seeded 1 chat with 1 message");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
