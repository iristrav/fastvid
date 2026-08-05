/**
 * Voice Generator stage — single responsibility: voice generation.
 *
 * Adapter around the existing generateBulkSceneVoiceovers (server/videoPipeline.ts), which
 * synthesizes one continuous narration mp3 (ElevenLabs) and splits it into per-scene files —
 * unchanged. `audioPaths` (an output-array parameter in the wrapped function) is built here
 * using the same `scene_${i}_audio.mp3` naming convention the legacy pipeline already uses
 * (videoPipeline.ts:23020), so files land exactly where the rest of the toolchain expects them.
 *
 * Note: the legacy pipeline's per-call timeout budget (bulkVoiceoverTimeoutMs, reading
 * RenderCtx via AsyncLocalStorage) wraps the *caller's* Promise.race, not this function itself
 * — generateBulkSceneVoiceovers has no ambient-context dependency of its own, so this adapter
 * doesn't need one either. A caller wanting a timeout applies it externally (e.g. via
 * Promise.race), same as any other stage.
 */
import path from "path";
import { generateBulkSceneVoiceovers } from "../../videoPipeline";
import { PIPELINE_ERROR } from "@shared/appErrors";
import { runStage, type VoiceGeneratorInput, type VoiceGeneratorOutput, type StageResult } from "../types";

export async function generateVoice(
  input: VoiceGeneratorInput
): Promise<StageResult<VoiceGeneratorOutput>> {
  return runStage(PIPELINE_ERROR.VOICEOVER, true, async () => {
    const audioPaths = input.scenes.map((_, i) => path.join(input.workDir, `scene_${i}_audio.mp3`));
    const durations = await generateBulkSceneVoiceovers(
      input.scenes,
      audioPaths,
      input.workDir,
      input.voiceId,
      input.onProgress,
      input.sourceScript
    );
    return { audioPaths, durations };
  });
}
