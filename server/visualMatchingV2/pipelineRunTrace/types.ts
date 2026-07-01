/** Visual Matching Engine V2 — PipelineRunTrace types.
 *
 *  One trace per complete video-scene run (vs. BeatSelectionTrace which is one per beat).
 *  Captures stage timings, beat-level aggregates, and pipeline-level metadata needed by
 *  VideoQualityReport without mixing beat-level and run-level data in one table. */

// ─── Core trace ────────────────────────────────────────────────────────────────

/** Wall-clock milliseconds consumed by each stage across all beats of the run.
 *  videoContext and visualIntent are one-time costs; the rest accumulate per beat. */
export type StageTimings = {
  videoContextMs: number;
  visualIntentMs: number;
  retrievalTotalMs: number;
  clipTotalMs: number;
  rankingTotalMs: number;
  visionTotalMs: number;
  selectionTotalMs: number;
};

export type PipelineRunTrace = {
  pipelineRunId: string;
  videoId: string;
  pipelineVersion: string;
  beatsProcessed: number;
  beatsSelected: number;
  beatsResearchRequired: number;
  startedAt: string;       // ISO — when runV2Pipeline() was entered
  completedAt: string;     // ISO — when runV2Pipeline() returned
  totalDurationMs: number;
  stageTimings: StageTimings;
};

// ─── Store interface ────────────────────────────────────────────────────────────

/** Contract for persisting a PipelineRunTrace. Failure MUST NOT propagate —
 *  a store error must never block the caller from receiving V2PipelineResult. */
export interface PipelineRunTraceStore {
  save(trace: PipelineRunTrace): Promise<void>;
}
