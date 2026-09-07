"use client";

import { useEffect, useState } from "react";
import { Check, Crosshair, Loader2, MousePointerClick, Play, Save, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useAppStore } from "@/lib/store";
import { startExecRun } from "@/lib/exec-client";
import { toast } from "sonner";

/**
 * M7 draft review — "learn this" folds the captured demonstration into draft
 * steps (coordinates as normalized hints + per-click frame thumbnails). The
 * operator reviews and edits the lesson here before it is saved to the
 * Library as kind:"action" steps — the exact shape the executor re-grounds
 * against a fresh snapshot on every run.
 */
export function DraftReviewDialog() {
  const draftSteps = useAppStore((s) => s.draftSteps);
  const setDraftSteps = useAppStore((s) => s.setDraftSteps);
  const open = !!draftSteps;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [runAfterSave, setRunAfterSave] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setSaving(false);
      setRunAfterSave(false);
    }
  }, [open]);

  const close = () => setDraftSteps(null);

  const save = async (): Promise<string | null> => {
    const finalName = name.trim();
    if (!finalName) {
      toast.error("Give the workflow a name first");
      return null;
    }
    setSaving(true);
    try {
      const steps = (draftSteps ?? []).map((s) => ({
        kind: "action",
        payload: {
          actionType: s.payload.actionType,
          x: s.payload.x,
          y: s.payload.y,
          text: s.payload.text,
          label: s.payload.label,
          thumb: s.payload.thumb ?? null,
        },
        ts: s.ts,
      }));
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: finalName, description: description.trim(), steps }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Saving failed (HTTP ${res.status})`);
      useAppStore.getState().bumpLibraryVersion();
      toast.success("Lesson saved to your Library", {
        description: `${steps.length} taught step${steps.length === 1 ? "" : "s"} — coordinates are re-grounded on every run.`,
      });
      return data?.id ?? null;
    } catch (err) {
      toast.error("Saving failed", { description: err instanceof Error ? err.message : "Unknown error" });
      return null;
    } finally {
      setSaving(false);
    }
  };

  const saveAndClose = async () => {
    const id = await save();
    if (id) close();
  };

  const saveAndRun = async () => {
    const id = await save();
    if (!id) return;
    close();
    /* execution happens on the managed browser — switch the stage surface
       honestly (mirror + amber LLM cursor) and start the run */
    useAppStore.getState().setChatMode("act");
    void startExecRun(id, name.trim());
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-zinc-800 bg-zinc-900 sm:max-w-lg teachcast-scroll">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-zinc-100">
            <Check className="h-4 w-4 text-amber-400" />
            Review the captured lesson
          </DialogTitle>
          <DialogDescription>
            Each demonstrated click/keystroke became one step. Coordinates are stored as hints — on every run the
            executor re-finds each target against a fresh snapshot of the managed browser, so layout drift never
            replays stale clicks.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="draft-name" className="text-xs text-zinc-400">
              Name
            </Label>
            <Input
              id="draft-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Export the weekly report"
              className="border-zinc-800 bg-zinc-950 text-sm text-zinc-100 placeholder:text-zinc-600"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="draft-desc" className="text-xs text-zinc-400">
              Description
            </Label>
            <Input
              id="draft-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One sentence describing what this workflow does"
              className="border-zinc-800 bg-zinc-950 text-sm text-zinc-100 placeholder:text-zinc-600"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-zinc-400">Steps ({draftSteps?.length ?? 0})</Label>
            <ol className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2 teachcast-scroll">
              {(draftSteps ?? []).map((s, i) => (
                <li key={`${i}-${s.ts}`} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-900">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-zinc-800 text-[10px] font-semibold text-amber-300">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-xs leading-relaxed text-zinc-200">
                      {s.payload.actionType === "click" ? (
                        <MousePointerClick className="h-3 w-3 shrink-0 text-amber-400" />
                      ) : (
                        <Type className="h-3 w-3 shrink-0 text-amber-400" />
                      )}
                      {s.payload.actionType === "click" ? s.payload.label : `Type: "${s.payload.text}"`}
                    </p>
                    {s.payload.actionType === "click" && (
                      <p className="mt-0.5 flex items-center gap-1 text-[10px] text-zinc-500">
                        <Crosshair className="h-2.5 w-2.5" />
                        hint: {Math.round((s.payload.x ?? 0) * 100)}%, {Math.round((s.payload.y ?? 0) * 100)}% of the screen
                      </p>
                    )}
                    {s.payload.thumb && (
                      <img
                        src={s.payload.thumb}
                        alt="Frame captured at teaching time — the visual context the executor re-grounds against"
                        className="mt-1 max-h-20 rounded border border-zinc-800 object-cover"
                      />
                    )}
                  </div>
                  <Badge variant="outline" className="mt-0.5 shrink-0 border-zinc-700 text-[10px] text-zinc-400">
                    {s.payload.actionType}
                  </Badge>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={close} disabled={saving} className="text-zinc-400 hover:bg-zinc-800">
            Discard
          </Button>
          <Button
            onClick={() => void saveAndClose()}
            disabled={saving || !name.trim()}
            variant="outline"
            className="gap-1.5 border-zinc-700 text-zinc-100 hover:bg-zinc-800"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </Button>
          <Button
            onClick={() => {
              setRunAfterSave(true);
              void saveAndRun();
            }}
            disabled={saving || !name.trim()}
            className="gap-1.5 bg-sky-600 text-white hover:bg-sky-500"
            title="Save, then run it now on the managed browser with the visible LLM cursor"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Save &amp; run{runAfterSave ? "…" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
