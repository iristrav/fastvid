/**
 * Visual Planner stage — single responsibility: receive scenes, return a visual plan. No media
 * downloading happens here.
 *
 * Adapter around the existing createVideoBlueprint (server/masterDocumentaryDirector.ts),
 * already a pure planning call: one LLM call (or a deterministic fallback when the master
 * documentary director is disabled), no file/network side effects beyond that call, and it
 * returns a plain, immutable, serializable VideoBlueprint — safe to produce as an isolated
 * stage as-is.
 *
 * `SharedVisualContext` (= VisualDedupState) is intentionally NOT constructed or owned by this
 * stage. It's genuine cross-cutting mutable state (accumulator sets/maps + a mutex) that must
 * stay the same instance across every downstream stage call for the video's dedup/variety
 * guarantees to hold — the orchestrator constructs it once (via the existing
 * createVisualDedupState) and threads it through explicitly to every stage that needs it,
 * attaching this stage's `blueprint` output the same way the legacy pipeline already does
 * (`visualDedup.videoBlueprint = videoBlueprint`).
 */
import { createVideoBlueprint } from "../../masterDocumentaryDirector";
import { PIPELINE_ERROR } from "@shared/appErrors";
import { runStage, type VisualPlannerInput, type VisualPlannerOutput, type StageResult } from "../types";

export async function planVisuals(
  input: VisualPlannerInput
): Promise<StageResult<VisualPlannerOutput>> {
  return runStage(PIPELINE_ERROR.GENERIC, true, async () => {
    const blueprint = await createVideoBlueprint(
      input.videoId,
      input.videoTitle,
      input.videoLengthMin,
      input.scenes
    );
    return { blueprint };
  });
}
