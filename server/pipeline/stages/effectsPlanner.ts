/**
 * Effects Planner stage — single responsibility: create effect instructions only, no
 * rendering.
 *
 * Facade composing three already-pure, already-modular functions, in the same order the
 * legacy pipeline calls them (videoPipeline.ts ~24198-24242): editorial reorder →
 * shot-sequence optimization → visual rhythm. All three already return plain immutable result
 * objects (no in-place mutation of the input arrays) — this stage just sequences them and
 * returns the combined plan. Writing the result back into scene/clip state stays the
 * orchestrator's job (matching "no rendering" — this stage never touches a file or spawns
 * ffmpeg).
 *
 * @deprecated (Phase 8) Superseded on a per-scene basis by the Cinematic Editing Engine
 * (server/cinematicEditingEngine/) via server/pipeline/newPipelineStages.ts, once
 * `newEnginePipelineActive()` (server/pipeline/newEngineFlags.ts) is true. This module is NOT
 * removed — it's still the only effects planner for any scene whose new-engine attempt is
 * off, fails, or gets rejected by Editorial Review (orchestrator.ts's per-scene fallback), and
 * every existing caller of `planEffects()` keeps working unchanged.
 */
import { editorialReorderScene } from "../../editorialReorder";
import { optimizeShotSequence } from "../../shotSequenceOptimizer";
import { applyVisualRhythm } from "../../visualRhythmEngine";
import { PIPELINE_ERROR } from "@shared/appErrors";
import { runStage, type EffectsPlannerInput, type EffectsPlan, type StageResult } from "../types";

export async function planEffects(
  input: EffectsPlannerInput
): Promise<StageResult<EffectsPlan>> {
  return runStage(PIPELINE_ERROR.GENERIC, true, async () => {
    const reorder = await editorialReorderScene(
      input.sceneIndex,
      input.sceneText,
      input.videoTitle,
      input.sceneDuration,
      input.clips,
      input.beatDurations,
      input.clipBeatIndices,
      input.beats
    );

    const shotSequence = optimizeShotSequence(
      input.sceneIndex,
      reorder.clips,
      reorder.beatDurations,
      reorder.clipBeatIndices,
      input.beats
    );

    const beatTexts = input.beats?.map((b) => b.text) ?? [];
    const rhythm = applyVisualRhythm(input.sceneIndex, beatTexts, shotSequence.beatDurations);

    return {
      clips: shotSequence.clips,
      beatDurations: rhythm.beatDurations,
      clipBeatIndices: shotSequence.clipBeatIndices,
      reorder,
      shotSequence,
      rhythm,
    };
  });
}
