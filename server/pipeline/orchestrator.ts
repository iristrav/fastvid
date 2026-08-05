/**
 * Modular pipeline orchestrator — Phase 2.
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
 */
import path from "path";
import fs from "fs";
import type { PipelineProgress } from "../videoPipeline";
import {
  TMP_DIR,
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
import type { StageResult } from "./types";

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

  const composedPaths: string[] = [];
  for (const scene of scenes) {
    const { candidates } = unwrap(
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
    const topClip = candidates[0]?.asset?.storageUrl;
    const clips = topClip ? [topClip] : [];

    const effects = unwrap(
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

    const timelineEntry = timeline.entries.find((e) => e.sceneIndex === scene.index);
    const composed = unwrap(
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
