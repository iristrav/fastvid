/** Modular pipeline — new-engine integration flags (Phase 8).
 *
 *  Phases 3-7 each built a dormant, isolated engine (visualMatchingV2, aiDirector,
 *  cinematicEditingEngine, editorialReviewEngineV2, professionalRenderEngine) with its own
 *  feature flag, defaulting off, never wired into any live pipeline. Phase 8's job is to wire
 *  them into the MODULAR pipeline (server/pipeline/orchestrator.ts — itself only reachable
 *  behind `PIPELINE_ARCHITECTURE=modular`, not the default `runVideoPipeline` production path)
 *  one stage at a time.
 *
 *  Every stage below is gated by TWO flags at once: its own Phase 3-7 module flag (proving the
 *  engine itself is intentionally turned on) AND a new PIPELINE_STAGE_* flag (proving the
 *  orchestrator is intentionally told to route to it). Either one alone leaves the stage off —
 *  this is deliberate defense-in-depth, not redundancy: an operator flipping on
 *  CINEMATIC_EDITING_ENGINE to unit-test the module directly must not accidentally reroute
 *  live orchestrator traffic, and vice versa. Rollback for any stage is always "unset (or set
 *  to false) either flag" — no code change, no redeploy required if flags are read from
 *  environment config that can be changed live.
 *
 *  Stages have a real dependency order the code enforces, not just documents:
 *  visual intelligence -> (optional) AI Director -> cinematic editing -> editorial review ->
 *  professional render. `validateStageFlags()` catches an operator enabling a later stage
 *  without its prerequisite (e.g. professional render on, editorial review off) — a
 *  configuration mistake that would otherwise silently produce an ApprovedEDL from an
 *  unreviewed EDL, exactly the "regression must block further migration" risk this phase is
 *  required to guard against.
 */
import { visualMatchingV2PipelineEnabled } from "../sourcingPolicy";
import { aiDirectorEnabled } from "../aiDirector/featureFlags";
import { cinematicEditingEngineEnabled } from "../cinematicEditingEngine/featureFlags";
import { editorialReviewEngineV2Enabled } from "../editorialReviewEngineV2/featureFlags";
import { professionalRenderEngineEnabled } from "../professionalRenderEngine/featureFlags";

/** Visual Intelligence Engine stage — replaces the legacy Visual Planner + Media Search
 *  stages' candidate selection with visualMatchingV2's richer retrieval/ranking/vision-scoring
 *  funnel. When off, the orchestrator keeps using the existing Visual Planner + Media Search
 *  stage modules unchanged. */
export function visualIntelligenceEngineStageEnabled(): boolean {
  return process.env.PIPELINE_STAGE_VISUAL_INTELLIGENCE === "true" && visualMatchingV2PipelineEnabled();
}

/** AI Director stage — optional scene-level narrative guidance fed into the Cinematic Editing
 *  Engine's `directorGuidance` hook. Purely additive: every EDL decision already has a real
 *  value with this off (Phase 4's planners have their own defaults), so this stage can be
 *  toggled independently of every other Phase 8 stage without breaking the chain. */
export function aiDirectorStageEnabled(): boolean {
  return process.env.PIPELINE_STAGE_AI_DIRECTOR === "true" && aiDirectorEnabled();
}

/** Cinematic Editing Engine stage — replaces the legacy Effects Planner stage, producing a
 *  full Edit Decision List instead of the legacy clip-reorder/shot-sequence/rhythm plan.
 *  Requires a candidate + intent per beat, which works whether Visual Intelligence Engine is
 *  on (its own CandidateAsset/VisualIntent, no conversion needed) or off (adapters.ts converts
 *  the legacy Media Search candidate and synthesizes a minimal VisualIntent stand-in). */
export function cinematicEditingEngineStageEnabled(): boolean {
  return process.env.PIPELINE_STAGE_CINEMATIC_EDITING === "true" && cinematicEditingEngineEnabled();
}

/** Editorial Review Engine stage — has no legacy equivalent (the closest thing,
 *  editorialReviewEngine.ts, runs post-render and never blocks; this runs pre-render and can).
 *  Requires every scene's EDL to exist first, so it only makes sense with the Cinematic Editing
 *  Engine stage also on — see validateStageFlags(). */
export function editorialReviewEngineStageEnabled(): boolean {
  return process.env.PIPELINE_STAGE_EDITORIAL_REVIEW === "true" && editorialReviewEngineV2Enabled();
}

/** Professional Render Engine stage — replaces the legacy Render Composer + Video Renderer
 *  stages for scenes whose EDL survived Editorial Review. Requires an ApprovedEDL, so it only
 *  makes sense with the Editorial Review Engine stage also on — see validateStageFlags(). */
export function professionalRenderEngineStageEnabled(): boolean {
  return process.env.PIPELINE_STAGE_PROFESSIONAL_RENDER === "true" && professionalRenderEngineEnabled();
}

export type StageFlagValidationIssue = { stage: string; missingPrerequisite: string };

/** Checks the real dependency chain between stages — not every combination of the 5 flags
 *  above is a coherent configuration. Returns an empty array when the current flag
 *  configuration is internally consistent (including "everything off," the default). */
export function validateStageFlags(): StageFlagValidationIssue[] {
  const issues: StageFlagValidationIssue[] = [];

  if (editorialReviewEngineStageEnabled() && !cinematicEditingEngineStageEnabled()) {
    issues.push({ stage: "editorial_review", missingPrerequisite: "cinematic_editing" });
  }
  if (professionalRenderEngineStageEnabled() && !editorialReviewEngineStageEnabled()) {
    issues.push({ stage: "professional_render", missingPrerequisite: "editorial_review" });
  }
  if (professionalRenderEngineStageEnabled() && !cinematicEditingEngineStageEnabled()) {
    issues.push({ stage: "professional_render", missingPrerequisite: "cinematic_editing" });
  }

  return issues;
}

/** Whether the new-engine EDL chain (visual intelligence through professional render) should
 *  run at all for this video — the orchestrator's single top-level branch point. Individual
 *  stages within the chain (visual intelligence vs. legacy-candidate-adapter, AI Director
 *  on/off) are still decided independently once inside it. */
export function newEnginePipelineActive(): boolean {
  return (
    cinematicEditingEngineStageEnabled() &&
    editorialReviewEngineStageEnabled() &&
    professionalRenderEngineStageEnabled() &&
    validateStageFlags().length === 0
  );
}
