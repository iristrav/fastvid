export { planEditorialOverlays } from "./engine";
export { applyEditorialOverlaysToScenes, applyEditorialOverlays } from "./renderer";
export type { VideoOverlayPlan, SceneOverlayPlan, BeatOverlay, EditorialOverlayType } from "./types";

/** Overlay engine disabled — set EDITORIAL_OVERLAY=true to re-enable. */
import { burnedInTextAllowed } from "../onScreenTextPolicy";
export function editorialOverlayEnabled(): boolean {
  // RONDE 113: one rule, asked first — see onScreenTextPolicy.
  if (!burnedInTextAllowed()) return false;
  return process.env.EDITORIAL_OVERLAY === "true";
}
