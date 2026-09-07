"use client";

import { useCallback, useEffect, useState } from "react";
import { Camera, Check, Loader2, MessageSquare, Save, TriangleAlert } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useAppStore } from "@/lib/store";
import type { CompiledStep } from "@/lib/types";
import { toast } from "sonner";

interface SaveWorkflowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SaveWorkflowDialog({ open, onOpenChange }: SaveWorkflowDialogProps) {
  const steps = useAppStore((s) => s.sessionSteps);
  const setView = useAppStore((s) => s.setView);

  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compiled, setCompiled] = useState<{ name: string; description: string; steps: CompiledStep[] } | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [useRaw, setUseRaw] = useState(false);
  const [saving, setSaving] = useState(false);

  const compile = useCallback(async () => {
    setCompiling(true);
    setCompileError(null);
    setCompiled(null);
    setUseRaw(false);
    try {
      const res = await fetch("/api/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: steps.map((s, i) => ({ index: i, kind: s.kind, text: s.payload.text, note: s.payload.note })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Compilation failed (HTTP ${res.status})`);
      setCompiled(data);
      setName(data.name);
      setDescription(data.description);
    } catch (err) {
      setCompileError(err instanceof Error ? err.message : "Compilation failed");
    } finally {
      setCompiling(false);
    }
  }, [steps]);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      compile();
    }
     
  }, [open]);

  const previewSteps = useRaw
    ? steps.map((s, i) => ({ index: i, instruction: s.payload.text || s.payload.note || "(frame reference)" }))
    : (compiled?.steps ?? []);

  const save = async () => {
    const finalName = name.trim();
    if (!finalName) {
      toast.error("Give the workflow a name first");
      return;
    }
    setSaving(true);
    try {
      const finalSteps = useRaw
        ? steps.map((s) => ({ kind: s.kind, payload: s.payload, ts: s.ts }))
        : compiled!.steps
            .map(({ index, instruction }) => {
              const src = steps[index];
              if (!src) return null;
              return src.kind === "snapshot"
                ? { kind: "snapshot", payload: { image: src.payload.image, note: instruction }, ts: src.ts }
                : { kind: "message", payload: { text: instruction, image: src.payload.image }, ts: src.ts };
            })
            .filter(Boolean);

      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: finalName, description: useRaw ? description.trim() : description.trim(), steps: finalSteps }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Saving failed (HTTP ${res.status})`);
      useAppStore.getState().bumpLibraryVersion(); /* the list changed — Library refetches even if already open */
      toast.success("Workflow saved to your Library", {
        description: `${data.steps?.length ?? finalSteps.length} steps · install it there to make it launchable`,
      });
      onOpenChange(false);
      setView("library");
    } catch (err) {
      toast.error("Saving failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-zinc-800 bg-zinc-900 sm:max-w-lg teachcast-scroll">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-zinc-100">
            <Save className="h-4 w-4 text-amber-400" />
            Save workflow to Library
          </DialogTitle>
          <DialogDescription>
            The LLM compiles your {steps.length} recorded event{steps.length === 1 ? "" : "s"} into a named, replayable
            workflow. Review and edit before saving.
          </DialogDescription>
        </DialogHeader>

        {compiling ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <Loader2 className="h-7 w-7 animate-spin text-amber-400" />
            <p className="text-sm text-zinc-300">Compiling the session with the LLM…</p>
            <p className="text-xs text-zinc-500">Selecting the meaningful events and writing clean step instructions.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {compileError && (
              <div className="space-y-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                <div className="flex items-start gap-2 text-xs text-red-200">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    <p className="font-medium">LLM compilation failed</p>
                    <p className="mt-0.5 text-red-200/80">{compileError}</p>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  <Switch checked={useRaw} onCheckedChange={setUseRaw} />
                  Save the raw recorded events as steps instead
                </label>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="wf-name" className="text-xs text-zinc-400">
                Name
              </Label>
              <Input
                id="wf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Export invoice to PDF"
                className="border-zinc-800 bg-zinc-950 text-sm text-zinc-100 placeholder:text-zinc-600"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wf-desc" className="text-xs text-zinc-400">
                Description
              </Label>
              <Textarea
                id="wf-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One sentence describing what this workflow does"
                rows={2}
                className="resize-none border-zinc-800 bg-zinc-950 text-sm text-zinc-100 placeholder:text-zinc-600"
              />
            </div>

            {previewSteps.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-400">
                  Steps ({previewSteps.length}
                  {useRaw ? " raw events" : " compiled"}) —{" "}
                  {!useRaw && <span className="text-amber-400/80">generated by the LLM</span>}
                </Label>
                <ol className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2 teachcast-scroll">
                  {previewSteps.map((s) => {
                    const src = steps[s.index];
                    return (
                      <li key={`${s.index}-${s.instruction.slice(0, 8)}`} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-900">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-zinc-800 text-[10px] font-semibold text-amber-300">
                          {s.index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs leading-relaxed text-zinc-200">{s.instruction}</p>
                          {src?.payload.image && (
                             
                            <img
                              src={src.payload.image}
                              alt="Reference frame for this step"
                              className="mt-1 max-h-20 rounded border border-zinc-800 object-cover"
                            />
                          )}
                        </div>
                        <Badge variant="outline" className="mt-0.5 shrink-0 gap-1 border-zinc-700 text-[10px] text-zinc-400">
                          {src?.kind === "snapshot" ? <Camera className="h-2.5 w-2.5" /> : <MessageSquare className="h-2.5 w-2.5" />}
                          {src?.kind ?? "?"}
                        </Badge>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving} className="text-zinc-400 hover:bg-zinc-800">
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={compiling || saving || !name.trim() || (previewSteps.length === 0)}
            className="gap-1.5 bg-amber-500 text-black hover:bg-amber-400"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Save workflow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
