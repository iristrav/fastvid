/** Professional Render Engine — feature flags (Phase 7).
 *
 *  Separate from every earlier phase's own flag file (sourcingPolicy.ts, cinematicEditingEngine/
 *  featureFlags.ts, aiDirector/featureFlags.ts, editorialReviewEngineV2/featureFlags.ts) —
 *  same "one small policy file per dormant module" convention.
 *
 *  Defaults OFF, per "keep every new component behind feature flags." Nothing in this
 *  directory is called from the live render pipeline (videoPipeline.ts still owns real
 *  production rendering) — this module only executes an ApprovedEDL that nothing upstream of
 *  it produces yet in production (the AI Director, Cinematic Editing Engine, and Editorial
 *  Review Engine are all themselves still gated off). */
export function professionalRenderEngineEnabled(): boolean {
  return process.env.PROFESSIONAL_RENDER_ENGINE === "true";
}

/** Hardware-encoding (nvenc/qsv/vaapi) support — off by default. No GPU backend exists
 *  anywhere in this codebase today (confirmed by research before this phase) and none is
 *  available in this environment to validate against, so this defaults to CPU/libx264
 *  regardless — flipping this on is a deployment-environment decision, not a code default. */
export function gpuEncodingEnabled(): boolean {
  return process.env.RENDER_GPU_ENCODING === "true";
}
