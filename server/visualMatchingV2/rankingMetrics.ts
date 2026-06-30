/** Visual Matching Engine V2 — Candidate Ranking Layer metrics.
 *  Global, cross-beat aggregates: average ranking time, average rankingScore, source
 *  distribution within the top 5 of each ranking call, and average per-signal
 *  contribution (clip/embedding/keyword). Separate from candidateRanking.ts's own
 *  per-beat RankingTrace so this can feed a dashboard later without parsing logs. */
import type { CandidateSource, RankedCandidate } from "./types";

const TOP_N_FOR_DISTRIBUTION = 5;

type RankingAccumulator = {
  rankings: number;
  candidatesRanked: number;
  totalDurationMs: number;
  totalScore: number;
  totalClipContribution: number;
  totalEmbeddingContribution: number;
  totalKeywordContribution: number;
  topSourceCounts: Map<CandidateSource, number>;
};

function emptyAccumulator(): RankingAccumulator {
  return {
    rankings: 0,
    candidatesRanked: 0,
    totalDurationMs: 0,
    totalScore: 0,
    totalClipContribution: 0,
    totalEmbeddingContribution: 0,
    totalKeywordContribution: 0,
    topSourceCounts: new Map(),
  };
}

let acc = emptyAccumulator();

export type RankingOutcome = {
  durationMs: number;
  ranked: RankedCandidate[];
};

/** Records one rankCandidates() call's outcome. Called once per beat; never throws. */
export function recordRankingOutcome(outcome: RankingOutcome): void {
  acc.rankings += 1;
  acc.totalDurationMs += outcome.durationMs;
  for (const r of outcome.ranked) {
    acc.candidatesRanked += 1;
    acc.totalScore += r.rankingScore;
    acc.totalClipContribution += r.rankingBreakdown.clipContribution;
    acc.totalEmbeddingContribution += r.rankingBreakdown.embeddingContribution;
    acc.totalKeywordContribution += r.rankingBreakdown.keywordContribution;
  }
  for (const r of outcome.ranked.slice(0, TOP_N_FOR_DISTRIBUTION)) {
    acc.topSourceCounts.set(r.candidate.source, (acc.topSourceCounts.get(r.candidate.source) ?? 0) + 1);
  }
}

export type RankingMetricsSnapshot = {
  rankings: number;
  candidatesRanked: number;
  avgRankingDurationMs: number;
  avgRankingScore: number | null;
  avgClipContribution: number | null;
  avgEmbeddingContribution: number | null;
  avgKeywordContribution: number | null;
  /** Source counts within the top 5 of every ranking call, summed across all calls. */
  topSourceDistribution: Record<string, number>;
};

export function getRankingMetrics(): RankingMetricsSnapshot {
  return {
    rankings: acc.rankings,
    candidatesRanked: acc.candidatesRanked,
    avgRankingDurationMs: acc.rankings > 0 ? acc.totalDurationMs / acc.rankings : 0,
    avgRankingScore: acc.candidatesRanked > 0 ? acc.totalScore / acc.candidatesRanked : null,
    avgClipContribution: acc.candidatesRanked > 0 ? acc.totalClipContribution / acc.candidatesRanked : null,
    avgEmbeddingContribution: acc.candidatesRanked > 0 ? acc.totalEmbeddingContribution / acc.candidatesRanked : null,
    avgKeywordContribution: acc.candidatesRanked > 0 ? acc.totalKeywordContribution / acc.candidatesRanked : null,
    topSourceDistribution: Object.fromEntries(acc.topSourceCounts),
  };
}

/** Test/debug helper — not used by production code paths. */
export function resetRankingMetrics(): void {
  acc = emptyAccumulator();
}
