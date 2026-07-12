export { planEditorialOverlays } from "./engine";
export { applyEditorialOverlaysToScenes, applyEditorialOverlays } from "./renderer";
export type { VideoOverlayPlan, SceneOverlayPlan, BeatOverlay, EditorialOverlayType } from "./types";

/** Set EDITORIAL_OVERLAY=false to disable and fall back to the legacy textOverlay system. */
export function editorialOverlayEnabled(): boolean {
  return process.env.EDITORIAL_OVERLAY !== "false";
}
