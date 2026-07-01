/** Visual Matching Engine V2 — Pipeline Orchestrator.
 *
 *  The single entrypoint that chains all V2 stages end-to-end for one scene:
 *
 *    VideoContext → VisualIntent → RetrievalStrategy → RetrievalOrchestrator
 *      → CLIP Pre-filter → CandidateRanking → LLM Vision → CandidateSelector
 *      → BeatSelectionTrace → PipelineRunTrace
 *
 *  Returns one SelectionResult per beat plus a PipelineRunTrace with stage timings.
 *  Makes no decisions — each stage is self-contained and this file only passes outputs
 *  forward. Gated behind visualMatchingV2PipelineEnabled(); the active production
 *  pipeline is not touched by this file.
 *
 *  Design constraints:
 *  - Each beat runs serially (one LLM call per beat; parallel would exceed rate limits).
 *  - CLIP fallback: if clipPreFilter returns empty, full pool is passed to ranking.
 *  - VideoContext is built once and shared across all beats of the scene.
 *  - BeatSelectionTrace and PipelineRunTrace failures never stop the pipeline result. */

import { randomUUID } from "crypto";
import { buildVideoContext } from "./videoContext";
import { extractVisualIntentsForScene, type BeatInput } from "./visualIntentExtractor";
import { buildRetrievalStrategy } from "./retrievalStrategyEngine";
import { retrieveCandidatePool } from "./retrievalOrchestrator";
import { clipPreFilter } from "./clipPreFilter";
import { rankCandidates } from "./candidateRanking";
import { scoreCandidates } from "./llmVisionScorer";
import { selectCandidate } from "./candidateSelector";
import { createBeatSelectionTraceStore } from "./beatSelectionTrace";
import { createPipelineRunTraceStore } from "./pipelineRunTrace";
import { logSelector } from "./logging";
import { visualMatchingV2EmbeddingsEnabled } from "../sourcingPolicy";
import { PIPELINE_VERSION } from "./beatSelectionTrace";
import type { SelectionResult, VideoContext, VisualIntent } from "./types";
import type { StageTimings } from "./pipelineRunTrace";

// ─── Public types ──────────────────────────────────────────────────────────────

export type { BeatInput };

export type V2PipelineOptions = {
  /** Working directory for frame extraction and temp file storage. */
  workDir: string;
  /** 1-based index of this scene within the video (passed to the orchestrator). */
  sceneIndex: number;
  /** Maximum candidates to fetch per beat. Defaults to the strategy engine's own default. */
  count?: number;
  /** Video length string for strategy selection (e.g. "short", "long"). */
  videoLength?: string | null;
  /** Force a specific performance mode. Defaults to the strategy engine's own logic. */
  performanceMode?: "fast" | "high_quality" | "balanced";
};

export type V2BeatResult = {
  intent: VisualIntent;
  selectionResult: SelectionResult;
  /** Wall-clock time for this beat's full funnel in ms. */
  beatDurationMs: number;
};

export type V2PipelineResult = {
  videoId: string;
  pipelineRunId: string;
  videoContext: VideoContext;
  beatResults: V2BeatResult[];
  stageTimings: StageTimings;
  /** Total wall-clock time for the full scene in ms. */
  durationMs: number;
};

// ─── Internal timing helper ────────────────────────────────────────────────────

function elapsed(start: number): number {
  return Date.now() - start;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Runs the complete V2 pipeline for one scene. Each beat goes through the full funnel;
 * beats are processed serially to stay within LLM Vision rate limits.
 *
 * @param videoId   - The video identifier (used for VideoContext caching).
 * @param topic     - The video topic (used for VideoContext caching).
 * @param beats     - The beats for this scene, each with beatId + spokenText.
 * @param options   - Pipeline execution options (workDir, sceneIndex, etc.).
 */
export async function runV2Pipeline(
  videoId: string,
  topic: string,
  beats: BeatInput[],
  options: V2PipelineOptions
): Promise<V2PipelineResult> {
  const pipelineStart = Date.now();
  const startedAt = new Date().toISOString();
  const pipelineRunId = randomUUID();
  const { workDir, sceneIndex, count, videoLength, performanceMode } = options;

  const timings = {
    videoContextMs: 0,
    visualIntentMs: 0,
    retrievalTotalMs: 0,
    clipTotalMs: 0,
    rankingTotalMs: 0,
    visionTotalMs: 0,
    selectionTotalMs: 0,
  };

  // ── Stage 1: VideoContext ──────────────────────────────────────────────────
  let t = Date.now();
  const videoContext = await buildVideoContext(videoId, topic);
  timings.videoContextMs = elapsed(t);

  // ── Stage 2: VisualIntent (batched — one LLM call for all beats) ──────────
  t = Date.now();
  const intents = await extractVisualIntentsForScene(beats, videoContext);
  timings.visualIntentMs = elapsed(t);

  const beatStore = createBeatSelectionTraceStore();
  const runStore = createPipelineRunTraceStore();
  const beatResults: V2BeatResult[] = [];
  let beatsSelected = 0;
  let beatsResearchRequired = 0;

  for (const intent of intents) {
    const beatStart = Date.now();

    // ── Stage 3: RetrievalStrategy ─────────────────────────────────────────
    const strategy = buildRetrievalStrategy(intent, {
      videoContext,
      videoLength,
      performanceMode,
      embeddingEnabled: visualMatchingV2EmbeddingsEnabled(),
    });

    // ── Stage 4: RetrievalOrchestrator ─────────────────────────────────────
    t = Date.now();
    const pool = await retrieveCandidatePool(intent, {
      strategy,
      workDir,
      sceneIndex,
      count,
    });
    timings.retrievalTotalMs += elapsed(t);

    // ── Stage 5: CLIP Pre-filter ────────────────────────────────────────────
    t = Date.now();
    const clipResult = await clipPreFilter(intent, pool.candidates);
    timings.clipTotalMs += elapsed(t);
    const clipPassed = clipResult.passed.length > 0 ? clipResult.passed : pool.candidates;

    // ── Stage 6: CandidateRanking ───────────────────────────────────────────
    t = Date.now();
    const ranked = rankCandidates(intent, clipPassed);
    timings.rankingTotalMs += elapsed(t);

    // ── Stage 7: LLM Vision Scorer ──────────────────────────────────────────
    t = Date.now();
    const scored = await scoreCandidates(intent, ranked, videoContext);
    timings.visionTotalMs += elapsed(t);

    // ── Stage 8: CandidateSelector ──────────────────────────────────────────
    t = Date.now();
    const selectionResult = selectCandidate(intent, scored);
    timings.selectionTotalMs += elapsed(t);

    if (selectionResult.needsResearch) beatsResearchRequired += 1;
    else beatsSelected += 1;

    // ── Stage 9: BeatSelectionTrace (failure-isolated) ─────────────────────
    await beatStore.save(selectionResult.trace, { videoId, pipelineRunId });

    const beatDurationMs = elapsed(beatStart);

    logSelector("complete", {
      beatId: intent.beatId,
      pipelineRunId,
      selectedCandidateId: selectionResult.selectedCandidateId,
      needsResearch: selectionResult.needsResearch,
      beatDurationMs,
    });

    beatResults.push({ intent, selectionResult, beatDurationMs });
  }

  const completedAt = new Date().toISOString();
  const totalDurationMs = elapsed(pipelineStart);

  // ── Stage 10: PipelineRunTrace (failure-isolated) ──────────────────────
  await runStore.save({
    pipelineRunId,
    videoId,
    pipelineVersion: PIPELINE_VERSION,
    beatsProcessed: intents.length,
    beatsSelected,
    beatsResearchRequired,
    startedAt,
    completedAt,
    totalDurationMs,
    stageTimings: timings,
  });

  return {
    videoId,
    pipelineRunId,
    videoContext,
    beatResults,
    stageTimings: timings,
    durationMs: totalDurationMs,
  };
}
