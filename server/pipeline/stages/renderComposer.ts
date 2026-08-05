/**
 * Render Composer stage — single responsibility: receive the timeline/scene data, produce a
 * rendered scene file.
 *
 * Per the Phase 2 plan's explicit scoping decision: this wraps composeSceneVideoInner
 * (server/videoPipeline.ts) as a single opaque unit rather than decomposing it into a separate
 * "build render instructions" step distinct from "execute them." That function interleaves
 * ffmpeg command construction with 23 inline exec() calls across ~1270 lines with no existing
 * seam between the two concerns — genuinely separating them isn't something to attempt without
 * a live render environment to verify against (none exists in this sandbox). This stage is
 * therefore honestly a "compose and render this scene" call, not a pure instruction-builder;
 * true build/execute separation is Phase 3 work.
 */
import { composeSceneVideoInner } from "../../videoPipeline";
import { PIPELINE_ERROR } from "@shared/appErrors";
import { runStage, type RenderComposerResult, type RenderInstructions, type StageResult } from "../types";

export async function composeScene(
  input: RenderInstructions
): Promise<StageResult<RenderComposerResult>> {
  return runStage(PIPELINE_ERROR.FFMPEG, true, async () => {
    const outputPath = await composeSceneVideoInner(
      input.scene,
      input.clips,
      input.audioPath,
      input.duration,
      input.workDir,
      input.totalScenes,
      input.enableSubtitles ?? false,
      input.rescueStockClip,
      input.beatDurations,
      undefined,
      input.composeOptions
    );
    return { outputPath };
  });
}
