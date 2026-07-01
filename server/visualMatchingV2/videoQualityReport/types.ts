/** Visual Matching Engine V2 — VideoQualityReport types.
 *
 *  Pure aggregation. No pipeline logic, no new scores. All values are aggregations
 *  of existing data from beat_selection_traces and pipeline_run_traces. */

// ─── Sub-blocks ─────────────────────────────────────────────────────────────────

export type OverallBlock = {
  pipelineRunId: string;
  videoId: string;
  pipelineVersion: string;
  beatsProcessed: number;
  beatsSelected: number;
  beatsResearchRequired: number;
  selectionRate: number;    // beatsSelected / beatsProcessed
  researchRate: number;     // beatsResearchRequired / beatsProcessed
};

export type PerformanceBlock = {
  totalDurationMs: number;
  avgBeatDurationMs: number | null;
  startedAt: string;
  completedAt: string;
};

export type QualityBlock = {
  avgConfidence: number | null;         // mean of beat confidence (0..1)
  avgVisionScore: number | null;        // mean of beat overallScore (0..100)
  rejectRate: number;                   // beats where needsResearch=true / total
  tieBreakRate: number;                 // beats where tieBreakApplied=true / total
  confidenceDistribution: {
    perfect: number;
    good: number;
    acceptable: number;
    reject: number;
  };
};

export type SourceStat = {
  source: string;
  selectedCount: number;
  selectionShare: number;               // selectedCount / beatsSelected
  avgConfidence: number | null;
  avgVisionScore: number | null;
  avgClipSimilarity: number | null;
  avgEmbeddingSimilarity: number | null;
  avgRankingScore: number | null;
};

export type SourcesBlock = {
  winnerSourceDistribution: Record<string, number>;  // raw counts
  perSource: SourceStat[];                           // enriched per-source stats
};

export type CacheBlock = {
  /** Cache hit rates are populated from payload data when available. Null when no
   *  cached beats were recorded (e.g. all cache fields missing from older traces). */
  avgVisionCacheHitRate: number | null;
};

export type StageTimingEntry = {
  stageMs: number;
  percentageOfTotal: number;
};

export type StagesBlock = {
  videoContext: StageTimingEntry;
  visualIntent: StageTimingEntry;
  retrieval: StageTimingEntry;
  clip: StageTimingEntry;
  ranking: StageTimingEntry;
  vision: StageTimingEntry;
  selection: StageTimingEntry;
  /** Sum of all stage milliseconds tracked. May be less than totalDurationMs
   *  (orchestration overhead and async gaps are excluded). */
  totalTrackedMs: number;
};

export type ResearchBlock = {
  researchRate: number;
  researchReasonDistribution: Record<string, number>;
};

export type DistributionBlock = {
  confidenceTierDistribution: Record<string, number>;
  winnerSourceDistribution: Record<string, number>;
};

export type FrequencyEntry = {
  value: string;
  count: number;
};

export type ExplainabilityBlock = {
  topResearchReasons: FrequencyEntry[];
  topTieBreakReasons: FrequencyEntry[];
  topSelectionReasons: FrequencyEntry[];
};

// ─── Trend fields (reserved — not populated yet) ────────────────────────────────

export type ComparisonBlock = null;  // reserved for future side-by-side analysis

// ─── Full report ────────────────────────────────────────────────────────────────

export type VideoQualityReport = {
  pipelineRunId: string;
  videoId: string;
  generatedAt: string;

  /** Reserved for future trend comparison — not populated. */
  previousRunId: string | null;
  baselineRunId: string | null;
  comparison: ComparisonBlock;

  /** 0–100 dashboard indicator derived from avgConfidence, researchRate, rejectRate.
   *  Not a selection criterion — observability only. */
  healthScore: number;

  overall: OverallBlock;
  performance: PerformanceBlock;
  quality: QualityBlock;
  sources: SourcesBlock;
  cache: CacheBlock;
  stages: StagesBlock;
  research: ResearchBlock;
  distribution: DistributionBlock;
  explainability: ExplainabilityBlock;
};
