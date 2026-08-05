/**
 * Timeline Builder stage — single responsibility: build the complete timeline. No FFmpeg.
 *
 * Genuinely new: today this cumulative-sum computation only exists inline (6 lines,
 * videoPipeline.ts:23464-23469) inside the dormant P5A branch (scenePipelineEnabled()-gated,
 * off by default) — the live legacy path doesn't have a named/extracted equivalent. Pure
 * arithmetic over already-known planned scene.duration values; no FFmpeg dependency, since it
 * runs strictly before any compose call in the pipeline that does use it.
 */
import { PIPELINE_ERROR } from "@shared/appErrors";
import { runStage, type StageResult, type Timeline } from "../types";

export function buildTimeline(scenes: Array<{ index: number; duration: number }>): Timeline {
  let cursor = 0;
  const entries = scenes.map((s) => {
    const startSec = cursor;
    cursor += s.duration;
    return { sceneIndex: s.index, startSec, endSec: cursor };
  });
  return { entries, totalDurationSec: cursor };
}

/** StageResult-wrapped variant for orchestrator use, matching every other stage's contract —
 *  buildTimeline() itself stays a plain synchronous function since it can't fail. */
export async function buildTimelineStage(
  scenes: Array<{ index: number; duration: number }>
): Promise<StageResult<Timeline>> {
  return runStage(PIPELINE_ERROR.GENERIC, false, async () => buildTimeline(scenes));
}
