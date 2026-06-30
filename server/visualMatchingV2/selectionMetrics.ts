/** Visual Matching Engine V2 — Candidate Selector metrics.
 *  Global, cross-beat aggregates: avg confidence, reject rate, tiebreak rate, avg
 *  overallScore, source win distribution, researchReason distribution, avg winner rank,
 *  avg winning clip/embedding/vision signals. Separate from SelectorTrace (per-beat). */
import type { CandidateSource, ConfidenceTier, ResearchReason } from "./types";

type SelectionAccumulator = {
  selections: number;
  rejects: number;
  tieBreaks: number;
  researchRequired: number;
  totalOverallScore: number;
  totalConfidence: number;
  confidenceCount: number;
  totalWinnerRank: number;
  winnerRankCount: number;
  totalWinningClipSimilarity: number;
  clipSimilarityCount: number;
  totalWinningEmbeddingSimilarity: number;
  embeddingSimilarityCount: number;
  totalWinningVisionScore: number;
  visionScoreCount: number;
  winsBySource: Map<CandidateSource, number>;
  winsByTier: Map<ConfidenceTier, number>;
  researchReasonCounts: Map<ResearchReason, number>;
};

function emptyAccumulator(): SelectionAccumulator {
  return {
    selections: 0,
    rejects: 0,
    tieBreaks: 0,
    researchRequired: 0,
    totalOverallScore: 0,
    totalConfidence: 0,
    confidenceCount: 0,
    totalWinnerRank: 0,
    winnerRankCount: 0,
    totalWinningClipSimilarity: 0,
    clipSimilarityCount: 0,
    totalWinningEmbeddingSimilarity: 0,
    embeddingSimilarityCount: 0,
    totalWinningVisionScore: 0,
    visionScoreCount: 0,
    winsBySource: new Map(),
    winsByTier: new Map(),
    researchReasonCounts: new Map(),
  };
}

let acc = emptyAccumulator();

export type SelectionOutcome = {
  selected: boolean;
  needsResearch: boolean;
  researchReason: ResearchReason | null;
  tieBreakApplied: boolean;
  winnerSource: CandidateSource | null;
  winnerTier: ConfidenceTier | null;
  winnerOverallScore: number | null;
  winnerConfidence: number | null;
  winnerRankPosition: number | null;
  winnerClipSimilarity: number | null;
  winnerEmbeddingSimilarity: number | null;
  winnerVisionScore: number | null;
};

export function tierScore(tier: ConfidenceTier): number {
  if (tier === "perfect") return 4;
  if (tier === "good") return 3;
  if (tier === "acceptable") return 2;
  return 1;
}

/** Records one selectCandidate() call's outcome. Called once per beat; never throws. */
export function recordSelectionOutcome(outcome: SelectionOutcome): void {
  acc.selections += 1;
  if (!outcome.selected) acc.rejects += 1;
  if (outcome.needsResearch) acc.researchRequired += 1;
  if (outcome.tieBreakApplied) acc.tieBreaks += 1;
  if (outcome.researchReason) {
    acc.researchReasonCounts.set(outcome.researchReason, (acc.researchReasonCounts.get(outcome.researchReason) ?? 0) + 1);
  }
  if (outcome.winnerOverallScore !== null) acc.totalOverallScore += outcome.winnerOverallScore;
  if (outcome.winnerConfidence !== null) {
    acc.totalConfidence += outcome.winnerConfidence;
    acc.confidenceCount += 1;
  }
  if (outcome.winnerRankPosition !== null) {
    acc.totalWinnerRank += outcome.winnerRankPosition;
    acc.winnerRankCount += 1;
  }
  if (outcome.winnerClipSimilarity !== null) {
    acc.totalWinningClipSimilarity += outcome.winnerClipSimilarity;
    acc.clipSimilarityCount += 1;
  }
  if (outcome.winnerEmbeddingSimilarity !== null) {
    acc.totalWinningEmbeddingSimilarity += outcome.winnerEmbeddingSimilarity;
    acc.embeddingSimilarityCount += 1;
  }
  if (outcome.winnerVisionScore !== null) {
    acc.totalWinningVisionScore += outcome.winnerVisionScore;
    acc.visionScoreCount += 1;
  }
  if (outcome.winnerSource !== null) {
    acc.winsBySource.set(outcome.winnerSource, (acc.winsBySource.get(outcome.winnerSource) ?? 0) + 1);
  }
  if (outcome.winnerTier !== null) {
    acc.winsByTier.set(outcome.winnerTier, (acc.winsByTier.get(outcome.winnerTier) ?? 0) + 1);
  }
}

export type SelectionMetricsSnapshot = {
  selections: number;
  rejectRate: number;
  researchRequiredRate: number;
  tieBreakRate: number;
  /** Average numeric confidence of the winner (0..1). */
  avgConfidence: number | null;
  avgOverallScore: number | null;
  /** Average 1-based rank position of the winner in the ranked candidate list. */
  averageWinnerRank: number | null;
  averageWinningClipSimilarity: number | null;
  averageWinningEmbeddingSimilarity: number | null;
  averageWinningVisionScore: number | null;
  sourceWinDistribution: Record<string, number>;
  tierWinDistribution: Record<string, number>;
  researchReasonDistribution: Record<string, number>;
};

export function getSelectionMetrics(): SelectionMetricsSnapshot {
  const selectedCount = acc.selections - acc.rejects;
  return {
    selections: acc.selections,
    rejectRate: acc.selections > 0 ? acc.rejects / acc.selections : 0,
    researchRequiredRate: acc.selections > 0 ? acc.researchRequired / acc.selections : 0,
    tieBreakRate: acc.selections > 0 ? acc.tieBreaks / acc.selections : 0,
    avgConfidence: acc.confidenceCount > 0 ? acc.totalConfidence / acc.confidenceCount : null,
    avgOverallScore: selectedCount > 0 ? acc.totalOverallScore / selectedCount : null,
    averageWinnerRank: acc.winnerRankCount > 0 ? acc.totalWinnerRank / acc.winnerRankCount : null,
    averageWinningClipSimilarity: acc.clipSimilarityCount > 0 ? acc.totalWinningClipSimilarity / acc.clipSimilarityCount : null,
    averageWinningEmbeddingSimilarity: acc.embeddingSimilarityCount > 0 ? acc.totalWinningEmbeddingSimilarity / acc.embeddingSimilarityCount : null,
    averageWinningVisionScore: acc.visionScoreCount > 0 ? acc.totalWinningVisionScore / acc.visionScoreCount : null,
    sourceWinDistribution: Object.fromEntries(acc.winsBySource),
    tierWinDistribution: Object.fromEntries(acc.winsByTier),
    researchReasonDistribution: Object.fromEntries(acc.researchReasonCounts),
  };
}

/** Test/debug helper — not used by production code paths. */
export function resetSelectionMetrics(): void {
  acc = emptyAccumulator();
}
