import { NextResponse } from "next/server";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "db", "coverage"]);
const SKIP_FILES = new Set(["dev.log", "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json",
  ".css", ".prisma", ".md", ".html", ".txt", ".yml", ".yaml",
]);

function isTextFile(name: string): boolean {
  if (name.startsWith(".") && !TEXT_EXTENSIONS.has(name)) {
    return name === ".env" || name === ".gitignore" || name === ".eslintignore";
  }
  return TEXT_EXTENSIONS.has(path.extname(name));
}

async function collectFiles(dir: string, prefix: string, files: Record<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(path.join(dir, entry.name), rel, files);
    } else {
      if (SKIP_FILES.has(entry.name) || !isTextFile(entry.name)) continue;
      files[rel] = await readFile(path.join(dir, entry.name), "utf8");
    }
  }
}

export async function GET() {
  try {
    const files: Record<string, string> = {};
    await collectFiles(process.cwd(), "", files);
    return NextResponse.json({ files });
  } catch (error) {
    console.error("GET /api/source failed", error);
    return NextResponse.json({ error: "Failed to read the source tree" }, { status: 500 });
  }
}
