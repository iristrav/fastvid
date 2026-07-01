/** Visual Matching Engine V2 — Pipeline Orchestrator.
 *
 *  The single entrypoint that chains all V2 stages end-to-end for one scene:
 *
 *    VideoContext → VisualIntent → RetrievalStrategy → RetrievalOrchestrator
 *      → CLIP Pre-filter → CandidateRanking → LLM Vision → CandidateSelector
 *      → BeatSelectionTrace
 *
 *  Returns one SelectionResult per beat. Makes no decisions — each stage is self-contained
 *  and this file only passes outputs forward. Gated behind visualMatchingV2PipelineEnabled();
 *  the active production pipeline is not touched by this file.
 *
 *  Design constraints:
 *  - Each beat runs serially (one LLM call per beat; parallel would exceed rate limits).
 *  - CLIP and ranking are always run even when their individual flags are off — the flags
 *    gate the actual heavy work inside each stage; the pipeline doesn't need to know.
 *  - BeatSelectionTrace.save() failure never stops the pipeline (failure isolation in store).
 *  - VideoContext is built once and shared across all beats of the scene. */

import { buildVideoContext } from "./videoContext";
import { extractVisualIntentsForScene, type BeatInput } from "./visualIntentExtractor";
import { buildRetrievalStrategy } from "./retrievalStrategyEngine";
import { retrieveCandidatePool } from "./retrievalOrchestrator";
import { clipPreFilter } from "./clipPreFilter";
import { rankCandidates } from "./candidateRanking";
import { scoreCandidates } from "./llmVisionScorer";
import { selectCandidate } from "./candidateSelector";
import { createBeatSelectionTraceStore } from "./beatSelectionTrace";
import { logSelector } from "./logging";
import { visualMatchingV2EmbeddingsEnabled } from "../sourcingPolicy";
import type { SelectionResult, VideoContext, VisualIntent } from "./types";

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
  videoContext: VideoContext;
  beatResults: V2BeatResult[];
  /** Total wall-clock time for the full scene in ms. */
  durationMs: number;
};

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
  const { workDir, sceneIndex, count, videoLength, performanceMode } = options;

  // ── Stage 1: VideoContext ──────────────────────────────────────────────────
  const videoContext = await buildVideoContext(videoId, topic);

  // ── Stage 2: VisualIntent (batched — one LLM call for all beats) ──────────
  const intents = await extractVisualIntentsForScene(beats, videoContext);

  const store = createBeatSelectionTraceStore();
  const beatResults: V2BeatResult[] = [];

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
    const pool = await retrieveCandidatePool(intent, {
      strategy,
      workDir,
      sceneIndex,
      count,
    });

    // ── Stage 5: CLIP Pre-filter ────────────────────────────────────────────
    const clipResult = await clipPreFilter(intent, pool.candidates);
    const clipPassed = clipResult.passed.length > 0 ? clipResult.passed : pool.candidates;

    // ── Stage 6: CandidateRanking ───────────────────────────────────────────
    const ranked = rankCandidates(intent, clipPassed);

    // ── Stage 7: LLM Vision Scorer ──────────────────────────────────────────
    const scored = await scoreCandidates(intent, ranked, videoContext);

    // ── Stage 8: CandidateSelector ──────────────────────────────────────────
    const selectionResult = selectCandidate(intent, scored);

    // ── Stage 9: BeatSelectionTrace ─────────────────────────────────────────
    // Failure-isolated: never throws, never delays the pipeline result.
    await store.save(selectionResult.trace, { videoId });

    logSelector("complete", {
      beatId: intent.beatId,
      selectedCandidateId: selectionResult.selectedCandidateId,
      needsResearch: selectionResult.needsResearch,
      beatDurationMs: Date.now() - beatStart,
    });

    beatResults.push({
      intent,
      selectionResult,
      beatDurationMs: Date.now() - beatStart,
    });
  }

  return {
    videoId,
    videoContext,
    beatResults,
    durationMs: Date.now() - pipelineStart,
  };
}
