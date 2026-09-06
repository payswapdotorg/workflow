"use client";

import { captureFrame } from "./screen";
import { useAppStore } from "./store";
import { toast } from "sonner";

/** Captures the current live frame and records it as a snapshot step in the teaching session. */
export function captureSnapshotStep(): boolean {
  const frame = captureFrame();
  if (!frame) {
    toast.error("No live frame available", {
      description: "Share your screen first, then capture snapshots.",
    });
    return false;
  }
  useAppStore.getState().pushSessionStep("snapshot", { image: frame });
  toast.success("Snapshot captured as a workflow step");
  return true;
}
