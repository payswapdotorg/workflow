"use client";

import { File as FileIcon, Folder } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BuildPhase } from "@/lib/types";
import { cn } from "@/lib/utils";

const PHASE_ORDER: BuildPhase[] = ["analyzing", "scaffolding", "building", "verifying", "ready"];

interface TreeEntry {
  path: string;
  phase: BuildPhase;
}

interface FolderNode {
  folders: Map<string, FolderNode>;
  files: { name: string; phase: BuildPhase }[];
}

function entriesFor(slug: string | null): TreeEntry[] {
  const feature = slug ? `${slug}-view` : "app-view";
  return [
    { path: "package.json", phase: "scaffolding" },
    { path: "postcss.config.mjs", phase: "scaffolding" },
    { path: "next.config.ts", phase: "scaffolding" },
    { path: "prisma/schema.prisma", phase: "building" },
    { path: "src/app/globals.css", phase: "scaffolding" },
    { path: "src/app/layout.tsx", phase: "scaffolding" },
    { path: "src/app/page.tsx", phase: "building" },
    { path: `src/components/${feature}.tsx`, phase: "building" },
    { path: "src/lib/db.ts", phase: "building" },
    { path: "tsconfig.json", phase: "scaffolding" },
    { path: "dev.log", phase: "verifying" },
  ];
}

function buildTree(entries: TreeEntry[]): FolderNode {
  const root: FolderNode = { folders: new Map(), files: [] };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i];
      let child = node.folders.get(name);
      if (!child) {
        child = { folders: new Map(), files: [] };
        node.folders.set(name, child);
      }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1], phase: entry.phase });
  }
  return root;
}

function TreeBranch({ node, phase }: { node: FolderNode; phase: BuildPhase | null }) {
  const highlight = (entryPhase: BuildPhase) =>
    phase !== null && phase !== "ready" && entryPhase === phase;

  return (
    <div className="flex flex-col gap-0.5">
      {[...node.folders.entries()].map(([name, child]) => (
        <div key={name} className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {name}
          </span>
          <div className="ml-3.5 flex flex-col gap-0.5 border-l border-border/70 pl-2.5">
            <TreeBranch node={child} phase={phase} />
          </div>
        </div>
      ))}
      {node.files.map((file) => (
        <span
          key={file.name}
          className={cn(
            "flex items-center gap-1.5 font-mono text-xs",
            highlight(file.phase) ? "text-emerald-300" : "text-foreground/80"
          )}
        >
          <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          {file.name}
        </span>
      ))}
    </div>
  );
}

export function FileTree({ phase, slug }: { phase: BuildPhase | null; slug: string | null }) {
  const revealThrough: BuildPhase | null = phase === "error" ? "building" : phase;
  const visible =
    revealThrough === null
      ? []
      : entriesFor(slug).filter(
          (entry) => PHASE_ORDER.indexOf(entry.phase) <= PHASE_ORDER.indexOf(revealThrough)
        );

  return (
    <Card className="shrink-0">
      <CardHeader className="py-3">
        <CardTitle className="flex items-center justify-between text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Workspace files
          <span className="font-mono normal-case tracking-normal">{visible.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {visible.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            Files appear here as the build progresses.
          </p>
        ) : (
          <div className="scrollbar-slim max-h-44 overflow-y-auto pr-1">
            <TreeBranch node={buildTree(visible)} phase={phase} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
