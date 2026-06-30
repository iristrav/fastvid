/** Visual Matching Engine V2 — Candidate Selector metrics.
 *  Global, cross-beat aggregates: avg confidence, reject rate, tiebreak rate, avg
 *  overallScore, source win distribution, and the rate at which selection triggers a
 *  research retry. Separate from SelectorTrace (per-beat) so this can feed a dashboard. */
import type { CandidateSource, ConfidenceTier } from "./types";

type SelectionAccumulator = {
  selections: number;
  rejects: number;
  tieBreaks: number;
  researchRequired: number;
  totalOverallScore: number;
  totalConfidenceScore: number;
  confidenceCount: number;
  winsBySource: Map<CandidateSource, number>;
  winsByTier: Map<ConfidenceTier, number>;
};

function emptyAccumulator(): SelectionAccumulator {
  return {
    selections: 0,
    rejects: 0,
    tieBreaks: 0,
    researchRequired: 0,
    totalOverallScore: 0,
    totalConfidenceScore: 0,
    confidenceCount: 0,
    winsBySource: new Map(),
    winsByTier: new Map(),
  };
}

let acc = emptyAccumulator();

export type SelectionOutcome = {
  /** True when a winner was found (needsResearch = false). */
  selected: boolean;
  needsResearch: boolean;
  tieBreakApplied: boolean;
  winnerSource: CandidateSource | null;
  winnerTier: ConfidenceTier | null;
  winnerOverallScore: number | null;
  /** Numeric representation of the tier for averaging (perfect=4, good=3, acceptable=2, reject=1). */
  winnerTierScore: number | null;
};

function tierScore(tier: ConfidenceTier): number {
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
  if (outcome.winnerOverallScore !== null) acc.totalOverallScore += outcome.winnerOverallScore;
  if (outcome.winnerTierScore !== null) {
    acc.totalConfidenceScore += outcome.winnerTierScore;
    acc.confidenceCount += 1;
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
  /** Average numeric tier score (4=perfect, 3=good, 2=acceptable, 1=reject). */
  avgConfidence: number | null;
  avgOverallScore: number | null;
  /** Source distribution for winning candidates (candidate source -> win count). */
  sourceWinDistribution: Record<string, number>;
  /** Tier distribution for winning candidates. */
  tierWinDistribution: Record<string, number>;
};

export function getSelectionMetrics(): SelectionMetricsSnapshot {
  const selectedCount = acc.selections - acc.rejects;
  return {
    selections: acc.selections,
    rejectRate: acc.selections > 0 ? acc.rejects / acc.selections : 0,
    researchRequiredRate: acc.selections > 0 ? acc.researchRequired / acc.selections : 0,
    tieBreakRate: acc.selections > 0 ? acc.tieBreaks / acc.selections : 0,
    avgConfidence: acc.confidenceCount > 0 ? acc.totalConfidenceScore / acc.confidenceCount : null,
    avgOverallScore: selectedCount > 0 ? acc.totalOverallScore / selectedCount : null,
    sourceWinDistribution: Object.fromEntries(acc.winsBySource),
    tierWinDistribution: Object.fromEntries(acc.winsByTier),
  };
}

/** Test/debug helper — not used by production code paths. */
export function resetSelectionMetrics(): void {
  acc = emptyAccumulator();
}

export { tierScore };
