export { planEditorialOverlays } from "./engine";
export { applyEditorialOverlaysToScenes, applyEditorialOverlays } from "./renderer";
export type { VideoOverlayPlan, SceneOverlayPlan, BeatOverlay, EditorialOverlayType } from "./types";

/** Overlay engine disabled — set EDITORIAL_OVERLAY=true to re-enable. */
export function editorialOverlayEnabled(): boolean {
  return process.env.EDITORIAL_OVERLAY === "true";
}
