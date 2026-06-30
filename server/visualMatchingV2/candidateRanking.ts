/** Visual Matching Engine V2 — Candidate Ranking Layer (funnel stage 3).
 *
 *  VisualIntent -> Retrieval -> Candidate Pool -> CLIP Pre-Filter -> [this] -> top
 *  3-5 candidates -> LLM Vision Scorer.
 *
 *  Scope is deliberately narrow: combine signals that already exist on each candidate
 *  (embeddingSimilarity, keywordScore, clipSimilarity, source priority) into one
 *  explainable, configurable score. No semantic judgement, no LLM, no confidence, no
 *  winner — those belong to the LLM Vision stage. clipPreFilter.ts is untouched; this
 *  module only reads the clipSimilarity it already wrote onto each CandidateAsset.
 *
 *  Fully data-driven: every decision flows through RankingConfig (weights + source
 *  priority) passed in or defaulted below — no if/else branching on a specific source or
 *  signal anywhere in this file. */
import { recordRankingOutcome } from "./rankingMetrics";
import { logCandidateRanking } from "./logging";
import type {
  CandidateAsset,
  CandidateSource,
  RankedCandidate,
  RankingBreakdown,
  RankingConfig,
  RankingTrace,
  RankingWeights,
  SourcePriority,
  VisualIntent,
} from "./types";

/** Default weights — purely a starting point. Tune via RankingConfig.weights per call;
 *  no code change needed to experiment with different values. */
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  clipSimilarity: 0.4,
  embeddingSimilarity: 0.3,
  keywordScore: 0.2,
  sourcePriority: 0.1,
};

/** Default source priority — higher wins. Known only here; no other component (retrieval,
 *  CLIP) is aware sources are prioritized at all. */
export const DEFAULT_SOURCE_PRIORITY: SourcePriority = {
  own_archive: 100,
  wikimedia: 90,
  pexels: 80,
  pixabay: 70,
  internet_archive: 60,
  ai_generated: 50,
};

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
  weights: DEFAULT_RANKING_WEIGHTS,
  sourcePriority: DEFAULT_SOURCE_PRIORITY,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Min-max normalizes keywordScore across the candidate batch being ranked, since the
 *  underlying scale is source-defined and not guaranteed to be 0..1 (unlike
 *  embeddingSimilarity/clipSimilarity, both already cosine similarities). Data-driven per
 *  call instead of a hardcoded source-specific scale. */
function buildKeywordNormalizer(candidates: CandidateAsset[]): (score: number | null) => number {
  const values = candidates.map((c) => c.keywordScore).filter((v): v is number => v !== null);
  if (values.length === 0) return () => 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return (score) => (score === null ? 0 : 1);
  return (score) => (score === null ? 0 : clamp01((score - min) / (max - min)));
}

function sourcePriorityFor(source: CandidateSource, sourcePriority: SourcePriority): number {
  return sourcePriority[source] ?? 0;
}

/**
 * Combines each candidate's existing retrieval signals (embeddingSimilarity, keywordScore,
 * clipSimilarity, source priority) into one weighted rankingScore. Operates only on the
 * candidates passed in — typically clipPreFilter()'s `passed` list — never re-fetches or
 * re-scores anything upstream.
 */
export function rankCandidates(
  intent: VisualIntent,
  candidates: CandidateAsset[],
  config: RankingConfig = DEFAULT_RANKING_CONFIG
): RankedCandidate[] {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const { weights, sourcePriority } = config;

  const maxConfiguredPriority = Math.max(1, ...Object.values(sourcePriority));
  const normalizeKeyword = buildKeywordNormalizer(candidates);

  const unsorted = candidates.map((candidate) => {
    const signalsUsed: RankingBreakdown["signalsUsed"] = [];

    const clipNorm = candidate.clipSimilarity !== null ? clamp01(candidate.clipSimilarity) : 0;
    if (candidate.clipSimilarity !== null) signalsUsed.push("clipSimilarity");

    const embeddingNorm = candidate.embeddingSimilarity !== null ? clamp01(candidate.embeddingSimilarity) : 0;
    if (candidate.embeddingSimilarity !== null) signalsUsed.push("embeddingSimilarity");

    const keywordNorm = normalizeKeyword(candidate.keywordScore);
    if (candidate.keywordScore !== null) signalsUsed.push("keywordScore");

    const priorityRaw = sourcePriorityFor(candidate.source, sourcePriority);
    const priorityNorm = clamp01(priorityRaw / maxConfiguredPriority);
    signalsUsed.push("sourcePriority");

    const breakdown: RankingBreakdown = {
      clipContribution: weights.clipSimilarity * clipNorm,
      embeddingContribution: weights.embeddingSimilarity * embeddingNorm,
      keywordContribution: weights.keywordScore * keywordNorm,
      sourceContribution: weights.sourcePriority * priorityNorm,
      signalsUsed,
    };

    const rankingScore =
      breakdown.clipContribution + breakdown.embeddingContribution + breakdown.keywordContribution + breakdown.sourceContribution;

    return { candidate, breakdown, rankingScore, priorityRaw };
  });

  unsorted.sort((a, b) => b.rankingScore - a.rankingScore);

  const ranked: RankedCandidate[] = unsorted.map((entry, i) => ({
    candidate: {
      ...entry.candidate,
      rankingScore: entry.rankingScore,
      rankingBreakdown: entry.breakdown,
    },
    rankingScore: entry.rankingScore,
    rankingBreakdown: entry.breakdown,
    position: i + 1,
  }));

  const durationMs = Date.now() - start;

  const trace: RankingTrace = {
    beatId: intent.beatId,
    startedAt,
    durationMs,
    candidateCount: candidates.length,
    weights,
    sourcePriority,
    entries: ranked.map((r, i) => ({
      candidateId: r.candidate.candidateId,
      source: r.candidate.source,
      signals: {
        clipSimilarity: r.candidate.clipSimilarity,
        embeddingSimilarity: r.candidate.embeddingSimilarity,
        keywordScore: r.candidate.keywordScore,
        sourcePriorityRaw: unsorted[i].priorityRaw,
      },
      breakdown: r.rankingBreakdown,
      rankingScore: r.rankingScore,
      position: r.position,
    })),
  };

  recordRankingOutcome({ durationMs, ranked });
  logCandidateRanking("ranking_complete", trace);

  return ranked;
}
