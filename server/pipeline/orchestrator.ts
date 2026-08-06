/**
 * Modular pipeline orchestrator — Phase 2, extended by Phase 8.
 *
 * Sequences the 10 stage modules for real; only reachable when PIPELINE_ARCHITECTURE=modular
 * is set (server/queue/index.ts's callers branch on this — see server/videoQueue.ts and
 * server/queue/bullmqQueue.ts's runVideoJob). Default (unset) keeps using runVideoPipeline
 * (videoPipeline.ts), completely unchanged.
 *
 * Two honest scoping notes, consistent with the Phase 2 plan:
 *
 * 1. **Stage order vs. the requested diagram.** The requested pipeline lists Voice Generator
 *    before Scene Splitter. In this codebase voice generation's per-scene split step
 *    (splitFullVoiceoverByScenes) needs scene boundaries to already exist — it splits ONE
 *    synthesized narration file at those boundaries. Reordering to match the diagram literally
 *    would require re-deriving that dependency from scratch, which risks breaking voice/scene
 *    alignment in a way I can't verify without a live render. This orchestrator runs Scene
 *    Splitter before Voice Generator (the real dependency order, matching how the app works
 *    today) and documents the deviation here rather than silently forcing an order that would
 *    break audio/scene alignment.
 * 2. **Per-scene visual fetch is simplified relative to the legacy pipeline.** The legacy
 *    per-beat visual fetch is a deeply-tiered fallback cascade (curated archive → Pexels/
 *    Pixabay → YouTube → AI image/video fallback → guaranteed color-card fallback, all
 *    dedup-aware). Re-deriving that whole cascade here would mean rewriting, not adapting, the
 *    single most tuned part of the pipeline — exactly what the plan's Design Decision #1 rules
 *    out. This orchestrator calls Media Search once per scene (its primary beat) and uses the
 *    top-ranked candidate; it does not implement the legacy cascade's other tiers. That's why
 *    this orchestrator is explicitly "structurally complete, needs real-world verification"
 *    before any real traffic uses it — see the Phase 2 migration summary.
 *
 * Phase 8 addition: when `newEnginePipelineActive()` (newEngineFlags.ts) is true — itself
 * gated behind PIPELINE_ARCHITECTURE=modular already being true, plus every Phase 3-7 engine's
 * own flag, plus this phase's own PIPELINE_STAGE_* flags, all at once — every scene is first
 * offered to `runNewEnginePipelineForScenes()` (newPipelineStages.ts), which chains Visual
 * Intelligence Engine (or a legacy-candidate adapter) → AI Director → Cinematic Editing Engine
 * → Editorial Review Engine → Professional Render Engine. Only scenes it successfully rendered
 * are skipped in the loop below; every other scene (new-engine disabled entirely, or this
 * specific scene's new-engine attempt failed/was rejected) falls through to the exact same
 * legacy Media Search / Effects Planner / Render Composer code that has always run here —
 * unmodified, not routed through any adapter. This is what makes the migration reversible at
 * the granularity of a single scene, not just a whole video: a bad candidate, a rejected
 * review, or an encode failure for one scene degrades to the proven path for THAT scene only.
 *
 * @deprecated (Phase 8) The legacy Media Search + Effects Planner + Render Composer path in
 * this file's own per-scene loop is superseded, per scene, by
 * `runNewEnginePipelineForScenes()` once `newEnginePipelineActive()` is true — but is NOT
 * removed, and must not be removed until that replacement has real production traffic
 * confirming parity (see this phase's OUTPUT summary). It remains the only path when the new
 * engine chain is off (the default) or when it fails/is rejected for a given scene.
 */
import path from "path";
import fs from "fs";
import type { PipelineProgress } from "../videoPipeline";
import {
  TMP_DIR,
  exec as ffmpegExec,
  getScenesForLength,
  getPipelinePerfProfile,
  createVisualDedupState,
} from "../videoPipeline";
import { splitScenes } from "./stages/sceneSplitter";
import { generateVoice } from "./stages/voiceGenerator";
import { planVisuals } from "./stages/visualPlanner";
import { searchMedia } from "./stages/mediaSearch";
import { buildTimeline } from "./stages/timelineBuilder";
import { planEffects } from "./stages/effectsPlanner";
import { composeScene } from "./stages/renderComposer";
import { uploadVideo } from "./stages/uploadService";
import type { CuratedCandidatePick, StageResult } from "./types";
import { newEnginePipelineActive } from "./newEngineFlags";
import { runNewEnginePipelineForScenes, type NewPipelineSceneInput } from "./newPipelineStages";
import { instrumentStage, newCorrelationId } from "./observability";

function unwrap<T>(result: StageResult<T>, stageName: string): T {
  if (result.ok) return result.data;
  throw new Error(`[ModularPipeline] ${stageName} failed: ${result.error.message}`);
}

export async function runModularVideoPipeline(
  videoId: number,
  script: string,
  onProgress?: (p: PipelineProgress) => void,
  voiceId?: string,
  _customVoiceoverUrl?: string,
  videoLength: string = "8-10",
  enableSubtitles = false,
  userPrompt?: string
): Promise<string> {
  const workDir = path.join(TMP_DIR, `fastvid_modular_${videoId}_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  onProgress?.({ stage: "Preparing", percent: 3 });
  const maxScenes = getScenesForLength(videoLength);
  const { scenes } = unwrap(
    await splitScenes({ script, maxScenes, topicContext: userPrompt }),
    "Scene Splitter"
  );

  onProgress?.({ stage: "Generating Voice", percent: 10 });
  const { audioPaths, durations } = unwrap(
    await generateVoice({ scenes, workDir, voiceId, sourceScript: script }),
    "Voice Generator"
  );
  scenes.forEach((s, i) => { s.duration = durations[i] ?? s.duration; });

  onProgress?.({ stage: "Searching Media", percent: 25 });
  const { blueprint } = unwrap(
    await planVisuals({
      videoId: String(videoId),
      videoTitle: userPrompt ?? `Video ${videoId}`,
      videoLengthMin: Math.max(1, Math.round(durations.reduce((a, b) => a + b, 0) / 60)),
      scenes: scenes.map((s) => ({ index: s.index, text: s.text })),
    }),
    "Visual Planner"
  );

  const perf = getPipelinePerfProfile(videoLength);
  const dedup = createVisualDedupState(perf);
  dedup.videoBlueprint = blueprint;

  const timeline = buildTimeline(scenes.map((s) => ({ index: s.index, duration: s.duration })));
  const correlationId = newCorrelationId();

  // Phase 8: offer every scene to the new engine chain first, when fully enabled. Scenes it
  // doesn't render (chain disabled, or this scene's attempt failed/was rejected) fall through
  // to the untouched legacy loop below — see this file's top-level doc comment.
  const newEngineOutputByScene = new Map<number, string>();
  if (newEnginePipelineActive()) {
    const newEngineSceneInputs: NewPipelineSceneInput[] = scenes.map((s) => ({
      scene: s,
      audioPath: audioPaths[s.index] ?? "",
      durationSec: s.duration,
    }));
    const legacyMediaSearch = async (s: (typeof scenes)[number]): Promise<CuratedCandidatePick | null> => {
      const result = await searchMedia({
        beat: { keywords: s.pexelsQueries ?? [s.pexelsQuery], text: s.text, index: s.index },
        scene: { text: s.text, visualCue: s.visualCue, pexelsQuery: s.pexelsQuery },
        usedAssetIds: dedup.usedCuratedAssetIds,
        usedStorageUrls: dedup.usedPaths,
        videoTitle: userPrompt,
        videoLength,
      });
      return result.ok ? (result.data.candidates[0] ?? null) : null;
    };

    const newEngineResult = await runNewEnginePipelineForScenes(newEngineSceneInputs, {
      videoId: String(videoId),
      videoTitle: userPrompt ?? `Video ${videoId}`,
      workDir,
      outputDir: path.join(workDir, "new_engine_scenes"),
      correlationId,
      videoLength,
      legacyMediaSearch,
      executor: ffmpegExec,
    });

    for (const outcome of newEngineResult.outcomes) {
      if (outcome.status === "rendered") {
        newEngineOutputByScene.set(outcome.sceneIndex, outcome.outputPath);
      } else {
        console.warn(`[ModularPipeline] scene ${outcome.sceneIndex}: new engine chain fell back to legacy (${outcome.reason})`);
      }
    }
  }

  const composedPaths: string[] = [];
  for (const scene of scenes) {
    const newEngineOutputPath = newEngineOutputByScene.get(scene.index);
    if (newEngineOutputPath) {
      composedPaths.push(newEngineOutputPath);
      onProgress?.({
        stage: `Rendering (${scene.index + 1}/${scenes.length})`,
        percent: 40 + Math.round(((scene.index + 1) / scenes.length) * 45),
      });
      continue;
    }

    const { candidates } = await instrumentStage(correlationId, "legacy", "media_search", async () => {
      const result = unwrap(
        await searchMedia({
          beat: { keywords: scene.pexelsQueries ?? [scene.pexelsQuery], text: scene.text, index: scene.index },
          scene: { text: scene.text, visualCue: scene.visualCue, pexelsQuery: scene.pexelsQuery },
          usedAssetIds: dedup.usedCuratedAssetIds,
          usedStorageUrls: dedup.usedPaths,
          videoTitle: userPrompt,
          videoLength,
        }),
        `Media Search (scene ${scene.index})`
      );
      return { value: result, outputSummary: `${result.candidates.length} candidate(s) for scene ${scene.index}` };
    });
    const topClip = candidates[0]?.asset?.storageUrl;
    const clips = topClip ? [topClip] : [];

    const effects = await instrumentStage(correlationId, "legacy", "effects_planner", async () => {
      const result = unwrap(
        await planEffects({
          sceneIndex: scene.index,
          sceneText: scene.text,
          videoTitle: userPrompt ?? "",
          sceneDuration: scene.duration,
          clips,
          beatDurations: [scene.duration],
        }),
        `Effects Planner (scene ${scene.index})`
      );
      return { value: result, outputSummary: `${result.clips.length} clip(s) planned for scene ${scene.index}` };
    });

    const timelineEntry = timeline.entries.find((e) => e.sceneIndex === scene.index);
    const composed = await instrumentStage(correlationId, "legacy", "render_composer", async () => {
      const result = unwrap(
        await composeScene({
          scene,
          clips: effects.clips,
          audioPath: audioPaths[scene.index] ?? "",
          duration: scene.duration,
          workDir,
          totalScenes: scenes.length,
          enableSubtitles,
          beatDurations: effects.beatDurations,
          composeOptions: { dedup, sceneStartSec: timelineEntry?.startSec },
        }),
        `Render Composer (scene ${scene.index})`
      );
      return { value: result, outputSummary: `scene ${scene.index} composed to ${result.outputPath}` };
    });
    composedPaths.push(composed.outputPath);
    onProgress?.({
      stage: `Rendering (${scene.index + 1}/${scenes.length})`,
      percent: 40 + Math.round(((scene.index + 1) / scenes.length) * 45),
    });
  }

  // Final concat + upload deliberately reuse the legacy concatenateScenesWithMusic /
  // storage-upload glue (buffer read, spot-check) rather than re-deriving them — those are
  // whole-video, not per-stage, concerns and aren't part of the 10 requested stage boundaries.
  const { concatenateScenesWithMusic } = await import("../videoPipeline");
  onProgress?.({ stage: "Uploading", percent: 90 });
  const totalDuration = timeline.totalDurationSec;
  const finalPath = await concatenateScenesWithMusic(
    composedPaths,
    workDir,
    videoId,
    totalDuration,
    userPrompt ?? `Video ${videoId}`
  );
  const videoBuffer = await fs.promises.readFile(finalPath);
  const { url } = unwrap(
    await uploadVideo({
      key: `videos/${videoId}/final.mp4`,
      data: videoBuffer,
      contentType: "video/mp4",
    }),
    "Upload Service"
  );

  onProgress?.({ stage: "Completed", percent: 100 });
  return url;
}
