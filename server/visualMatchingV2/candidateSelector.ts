/** Visual Matching Engine V2 — Candidate Selector (funnel stage 5, final).
 *
 *  Retrieval -> CLIP -> Ranking -> Vision -> [this] -> SelectionResult.
 *
 *  This is the ONLY component in the V2 pipeline permitted to choose a winner.
 *  All prior stages gather and score information; this stage decides.
 *
 *  Scope:
 *   - Assigns each candidate a ConfidenceTier based on its visionScores.overallScore and
 *     configurable thresholds.
 *   - Selects the highest-confidence candidate, with a strict deterministic tiebreaker
 *     chain (overallScore -> confidenceTier -> rankingScore -> source priority -> candidateId)
 *     that never depends on array order.
 *   - Returns needsResearch=true (no winner) when every candidate falls below "acceptable".
 *   - Produces a complete SelectorTrace that the future BeatSelectionTrace component can
 *     persist as-is, with no extra reconstruction logic.
 *
 *  What it does NOT do:
 *   - Compute any new scores (uses visionScores.overallScore, rankingScore, clipSimilarity,
 *     embeddingSimilarity, keywordScore exactly as set by prior stages).
 *   - Download, render, or materialise the selected clip.
 *   - Call any LLM, CLIP model, or external API.
 *   - Make any decisions on behalf of the Retrieval, Ranking, or Vision stages. */
import { DEFAULT_SOURCE_PRIORITY } from "./candidateRanking";
import { recordSelectionOutcome, tierScore } from "./selectionMetrics";
import { logSelector } from "./logging";
import type {
  CandidateSource,
  CandidateVerdict,
  ConfidenceTier,
  ConfidenceTierThresholds,
  ScoredCandidate,
  SelectionConfig,
  SelectionResult,
  SelectorTrace,
  SourcePriority,
  VisualIntent,
} from "./types";

export const DEFAULT_THRESHOLDS: ConfidenceTierThresholds = {
  perfect: 85,
  good: 70,
  acceptable: 50,
};

export const DEFAULT_SELECTION_CONFIG: SelectionConfig = {
  thresholds: DEFAULT_THRESHOLDS,
};

function toTier(overallScore: number, thresholds: ConfidenceTierThresholds): ConfidenceTier {
  if (overallScore >= thresholds.perfect) return "perfect";
  if (overallScore >= thresholds.good) return "good";
  if (overallScore >= thresholds.acceptable) return "acceptable";
  return "reject";
}

function sourcePriorityFor(source: CandidateSource, sourcePriority: SourcePriority): number {
  return sourcePriority[source] ?? 0;
}

type ScoredEntry = {
  candidate: ScoredCandidate;
  overallScore: number;
  tier: ConfidenceTier;
};

/**
 * Deterministic tiebreaker chain — never depends on array order:
 *   1. overallScore (higher wins)
 *   2. confidenceTier numeric weight (perfect=4 > good=3 > acceptable=2 > reject=1)
 *   3. rankingScore (higher wins, null = 0)
 *   4. source priority (from config, higher wins)
 *   5. candidateId lexicographic ascending (stable, arbitrary but deterministic)
 */
function compareEntries(a: ScoredEntry, b: ScoredEntry, sourcePriority: SourcePriority): number {
  const scoreDiff = b.overallScore - a.overallScore;
  if (scoreDiff !== 0) return scoreDiff;

  const tierDiff = tierScore(b.tier) - tierScore(a.tier);
  if (tierDiff !== 0) return tierDiff;

  const rankA = a.candidate.candidate.candidate.rankingScore ?? 0;
  const rankB = b.candidate.candidate.candidate.rankingScore ?? 0;
  if (rankB !== rankA) return rankB - rankA;

  const srcA = sourcePriorityFor(a.candidate.candidate.candidate.source, sourcePriority);
  const srcB = sourcePriorityFor(b.candidate.candidate.candidate.source, sourcePriority);
  if (srcB !== srcA) return srcB - srcA;

  return a.candidate.candidate.candidate.candidateId < b.candidate.candidate.candidate.candidateId ? -1 : 1;
}

/**
 * Selects one winner (or returns needsResearch=true) from a list of Vision-scored candidates.
 * The sole decision-making component in the V2 pipeline.
 */
export function selectCandidate(
  intent: VisualIntent,
  scored: ScoredCandidate[],
  config: SelectionConfig = DEFAULT_SELECTION_CONFIG
): SelectionResult {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const thresholds = config.thresholds;
  const sourcePriority = config.sourcePriority ?? DEFAULT_SOURCE_PRIORITY;

  logSelector("start", { beatId: intent.beatId, candidateCount: scored.length });

  const entries: ScoredEntry[] = scored.map((s) => ({
    candidate: s,
    overallScore: s.visionScores.overallScore,
    tier: toTier(s.visionScores.overallScore, thresholds),
  }));

  // Sort all candidates by the full tiebreaker chain up front — this determines display
  // order in allCandidates and also which candidate is #1 after filtering to acceptable+.
  const sorted = [...entries].sort((a, b) => compareEntries(a, b, sourcePriority));

  const eligible = sorted.filter((e) => e.tier !== "reject");

  const needsResearch = eligible.length === 0;

  let winner: ScoredEntry | null = null;
  let tieBreakApplied = false;
  let tieBreakReason: string | null = null;
  let selectionReason: string;
  let confidenceTier: ConfidenceTier | null = null;

  if (!needsResearch) {
    winner = eligible[0];
    confidenceTier = winner.tier;

    // Detect whether a tiebreak was actually needed (first two eligible share overallScore).
    if (eligible.length >= 2 && eligible[0].overallScore === eligible[1].overallScore) {
      tieBreakApplied = true;

      const a = eligible[0];
      const b = eligible[1];
      if (tierScore(a.tier) !== tierScore(b.tier)) {
        tieBreakReason = `Equal overallScore (${a.overallScore}); resolved by confidence tier (${a.tier} > ${b.tier}).`;
      } else {
        const rankA = a.candidate.candidate.candidate.rankingScore ?? 0;
        const rankB = b.candidate.candidate.candidate.rankingScore ?? 0;
        if (rankA !== rankB) {
          tieBreakReason = `Equal overallScore and tier; resolved by rankingScore (${rankA.toFixed(3)} > ${rankB.toFixed(3)}).`;
        } else {
          const srcA = sourcePriorityFor(a.candidate.candidate.candidate.source, sourcePriority);
          const srcB = sourcePriorityFor(b.candidate.candidate.candidate.source, sourcePriority);
          if (srcA !== srcB) {
            tieBreakReason = `Equal overallScore, tier and rankingScore; resolved by source priority (${a.candidate.candidate.candidate.source}=${srcA} > ${b.candidate.candidate.candidate.source}=${srcB}).`;
          } else {
            tieBreakReason = `All scoring signals tied; resolved by candidateId lexicographic order.`;
          }
        }
      }

      logSelector("tieBreak", { beatId: intent.beatId, tieBreakReason, winnerId: winner.candidate.candidate.candidate.candidateId });
    }

    selectionReason = `Selected ${winner.candidate.candidate.candidate.candidateId} with overallScore=${winner.overallScore} (tier: ${confidenceTier}).`;
  } else {
    selectionReason = `All ${scored.length} candidate${scored.length === 1 ? "" : "s"} scored below the acceptable threshold (${thresholds.acceptable}); research retry needed.`;
    logSelector("reject", { beatId: intent.beatId, candidateCount: scored.length, lowestThreshold: thresholds.acceptable });
  }

  // Build per-candidate verdicts for the trace — one entry per candidate in sorted order.
  const verdicts: CandidateVerdict[] = sorted.map((e) => {
    const c = e.candidate.candidate.candidate;
    const isWinner = winner !== null && c.candidateId === winner.candidate.candidate.candidate.candidateId;
    return {
      candidateId: c.candidateId,
      overallScore: e.overallScore,
      confidenceTier: e.tier,
      rankingScore: c.rankingScore ?? null,
      clipSimilarity: c.clipSimilarity ?? null,
      embeddingSimilarity: c.embeddingSimilarity ?? null,
      keywordScore: c.keywordScore ?? null,
      rejectedReason: isWinner ? null : e.tier === "reject"
        ? `overallScore ${e.overallScore} below acceptable threshold ${thresholds.acceptable}.`
        : `Another candidate had a higher score or better tiebreak result.`,
    };
  });

  const durationMs = Date.now() - start;

  const trace: SelectorTrace = {
    beatId: intent.beatId,
    startedAt,
    durationMs,
    candidateCount: scored.length,
    thresholds,
    tieBreakApplied,
    tieBreakReason,
    selectedCandidateId: winner?.candidate.candidate.candidate.candidateId ?? null,
    selectionReason,
    confidenceTier,
    needsResearch,
    verdicts,
  };

  recordSelectionOutcome({
    selected: !needsResearch,
    needsResearch,
    tieBreakApplied,
    winnerSource: winner?.candidate.candidate.candidate.source ?? null,
    winnerTier: confidenceTier,
    winnerOverallScore: winner?.overallScore ?? null,
    winnerTierScore: confidenceTier ? tierScore(confidenceTier) : null,
  });

  logSelector(needsResearch ? "reject" : "complete", {
    beatId: intent.beatId,
    selectedCandidateId: trace.selectedCandidateId,
    confidenceTier,
    needsResearch,
    durationMs,
    tieBreakApplied,
  });

  return {
    selectedCandidate: winner?.candidate ?? null,
    selectedCandidateId: winner?.candidate.candidate.candidate.candidateId ?? null,
    confidenceTier,
    needsResearch,
    selectionReason,
    trace,
    allCandidates: sorted.map((e) => e.candidate),
  };
}
