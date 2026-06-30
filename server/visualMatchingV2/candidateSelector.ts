/** Visual Matching Engine V2 — Candidate Selector (funnel stage 5, final).
 *
 *  Retrieval -> CLIP -> Ranking -> Vision -> [this] -> SelectionResult.
 *
 *  This is the ONLY component in the V2 pipeline permitted to choose a winner.
 *  All prior stages gather and score information; this stage decides.
 *
 *  What it does:
 *   - Reads SelectionConfig exclusively via a SelectionConfigProvider interface (no
 *     hardcoded business rules — subscription tiers, archive-first policy, fast/quality
 *     mode are all invisible here; those belong in the Retrieval Strategy Engine).
 *   - Assigns each candidate a numeric confidence (overallScore/100) and a ConfidenceTier
 *     from configurable thresholds.
 *   - Selects the highest-confidence candidate using a strict deterministic five-step
 *     tiebreaker chain; records every evaluated step in tieBreakPath.
 *   - Returns needsResearch=true with a typed ResearchReason when no candidate qualifies.
 *   - Produces a complete, immutable SelectionResult + SelectorTrace that BeatSelectionTrace
 *     can persist with `await store.save(result.trace)` — no further reconstruction needed.
 *
 *  What it does NOT do:
 *   - Compute new scores — uses only visionScores.overallScore, rankingScore,
 *     clipSimilarity, embeddingSimilarity, keywordScore exactly as set by prior stages.
 *   - Mutate any input candidate object — all returned objects are new.
 *   - Know about subscriptions, video length, archive-first policy, or fallback behaviour.
 *   - Download, render, or materialise the selected clip. */
import { DEFAULT_SOURCE_PRIORITY } from "./candidateRanking";
import { recordSelectionOutcome, tierScore } from "./selectionMetrics";
import { logSelector } from "./logging";
import type {
  CandidateSource,
  CandidateVerdict,
  ConfidenceTier,
  ConfidenceTierThresholds,
  ResearchReason,
  ScoredCandidate,
  SelectionConfig,
  SelectionConfigProvider,
  SelectionResult,
  SelectorTrace,
  SourcePriority,
  TieBreakStep,
  VisualIntent,
  WinnerSnapshot,
} from "./types";

// ─── Default config (fallback only — callers should supply a SelectionConfigProvider) ──

export const DEFAULT_THRESHOLDS: ConfidenceTierThresholds = {
  perfect: 85,
  good: 70,
  acceptable: 50,
};

export const DEFAULT_SELECTION_CONFIG: SelectionConfig = {
  thresholds: DEFAULT_THRESHOLDS,
};

/** Default provider — returns the hardcoded defaults above. Replace with an injected
 *  provider to drive config from a database, experiment framework, or subscription tier
 *  without changing any Selector code. */
export class DefaultSelectionConfigProvider implements SelectionConfigProvider {
  getSelectionConfig(): SelectionConfig {
    return DEFAULT_SELECTION_CONFIG;
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function toTier(overallScore: number, t: ConfidenceTierThresholds): ConfidenceTier {
  if (overallScore >= t.perfect) return "perfect";
  if (overallScore >= t.good) return "good";
  if (overallScore >= t.acceptable) return "acceptable";
  return "reject";
}

function toConfidence(overallScore: number): number {
  return Math.max(0, Math.min(1, overallScore / 100));
}

function sourcePriorityFor(source: CandidateSource, sp: SourcePriority): number {
  return sp[source] ?? 0;
}

type ScoredEntry = {
  readonly scored: ScoredCandidate;
  readonly overallScore: number;
  readonly confidence: number;
  readonly tier: ConfidenceTier;
};

/**
 * Deterministic tiebreaker compare — never depends on array order.
 * Returns { diff, step } where step is the first discriminating step name.
 * diff > 0 means a wins; diff < 0 means b wins; 0 means fully equal (shouldn't happen
 * after candidateId step but handled safely).
 */
function compareEntries(
  a: ScoredEntry,
  b: ScoredEntry,
  sp: SourcePriority
): { diff: number; step: TieBreakStep } {
  const scoreDiff = b.overallScore - a.overallScore;
  if (scoreDiff !== 0) return { diff: -scoreDiff, step: "overallScore" };

  const tierDiff = tierScore(b.tier) - tierScore(a.tier);
  if (tierDiff !== 0) return { diff: -tierDiff, step: "confidenceTier" };

  const rankA = a.scored.candidate.candidate.rankingScore ?? 0;
  const rankB = b.scored.candidate.candidate.rankingScore ?? 0;
  if (rankA !== rankB) return { diff: rankB > rankA ? -1 : 1, step: "rankingScore" };

  const srcA = sourcePriorityFor(a.scored.candidate.candidate.source, sp);
  const srcB = sourcePriorityFor(b.scored.candidate.candidate.source, sp);
  if (srcA !== srcB) return { diff: srcB > srcA ? -1 : 1, step: "sourcePriority" };

  const idCmp = a.scored.candidate.candidate.candidateId < b.scored.candidate.candidate.candidateId ? -1 : 1;
  return { diff: idCmp, step: "candidateId" };
}

/** Full sort comparator that calls compareEntries and returns only the sign (for Array.sort). */
function sortEntries(a: ScoredEntry, b: ScoredEntry, sp: SourcePriority): number {
  return -compareEntries(a, b, sp).diff;
}

/**
 * Builds the tieBreakPath for the trace: the ordered list of steps that were evaluated
 * between the winning candidate and the closest runner-up, up to and including the step
 * that resolved the tie. Empty when winner and runner-up differed on overallScore.
 */
function buildTieBreakPath(winner: ScoredEntry, runnerUp: ScoredEntry, sp: SourcePriority): TieBreakStep[] {
  const steps: TieBreakStep[] = ["overallScore", "confidenceTier", "rankingScore", "sourcePriority", "candidateId"];
  const path: TieBreakStep[] = [];

  for (const step of steps) {
    path.push(step);
    let diff = 0;
    if (step === "overallScore") diff = winner.overallScore - runnerUp.overallScore;
    else if (step === "confidenceTier") diff = tierScore(winner.tier) - tierScore(runnerUp.tier);
    else if (step === "rankingScore") {
      const wRank = winner.scored.candidate.candidate.rankingScore ?? 0;
      const rRank = runnerUp.scored.candidate.candidate.rankingScore ?? 0;
      diff = wRank - rRank;
    } else if (step === "sourcePriority") {
      diff = sourcePriorityFor(winner.scored.candidate.candidate.source, sp)
           - sourcePriorityFor(runnerUp.scored.candidate.candidate.source, sp);
    } else {
      diff = winner.scored.candidate.candidate.candidateId < runnerUp.scored.candidate.candidate.candidateId ? -1 : 1;
    }
    if (diff !== 0) return path; // this step resolved it — stop
  }
  return path;
}

function buildTieBreakReason(path: TieBreakStep[], winner: ScoredEntry, runnerUp: ScoredEntry, sp: SourcePriority): string {
  const decidingStep = path[path.length - 1];
  const wc = winner.scored.candidate.candidate;
  const rc = runnerUp.scored.candidate.candidate;
  if (decidingStep === "overallScore") return `Resolved by overallScore (${winner.overallScore} > ${runnerUp.overallScore}).`;
  if (decidingStep === "confidenceTier") return `Equal overallScore; resolved by confidence tier (${winner.tier} > ${runnerUp.tier}).`;
  if (decidingStep === "rankingScore") return `Equal overallScore and tier; resolved by rankingScore (${(wc.rankingScore ?? 0).toFixed(3)} > ${(rc.rankingScore ?? 0).toFixed(3)}).`;
  if (decidingStep === "sourcePriority") return `Equal overallScore, tier, rankingScore; resolved by source priority (${wc.source}=${sourcePriorityFor(wc.source, sp)} > ${rc.source}=${sourcePriorityFor(rc.source, sp)}).`;
  return `All signals tied; resolved by candidateId lexicographic order.`;
}

function detectResearchReason(scored: ScoredCandidate[], eligible: ScoredEntry[]): ResearchReason {
  if (scored.length === 0) return "NO_CANDIDATES";
  const allZeroVision = scored.every((s) => s.visionScores.overallScore === 0 && !s.cacheHit);
  if (allZeroVision) return "VISION_FAILED";
  const allFallback = scored.every((s) => s.visionScores.reasoning.startsWith("No embeddable image"));
  if (allFallback) return "NO_IMAGES";
  return "ALL_REJECTED";
}

// ─── Main export ───────────────────────────────────────────────────────────────

/**
 * Selects one winner (or returns needsResearch=true) from a list of Vision-scored
 * candidates. The sole decision-making component in the V2 pipeline.
 *
 * Config is read from the provider on every call so experiments can vary thresholds
 * per video, per subscription tier, or per A/B bucket without code changes.
 */
export function selectCandidate(
  intent: VisualIntent,
  scored: ScoredCandidate[],
  configProvider: SelectionConfigProvider = new DefaultSelectionConfigProvider()
): SelectionResult {
  const startedAt = new Date().toISOString();
  const start = Date.now();

  logSelector("start", { beatId: intent.beatId, candidateCount: scored.length });

  const config = configProvider.getSelectionConfig();
  const thresholds = config.thresholds;
  const sourcePriority = config.sourcePriority ?? DEFAULT_SOURCE_PRIORITY;

  // Build immutable entries (no mutation of input scored array or its elements).
  const entries: ScoredEntry[] = scored.map((s) => ({
    scored: s,
    overallScore: s.visionScores.overallScore,
    confidence: toConfidence(s.visionScores.overallScore),
    tier: toTier(s.visionScores.overallScore, thresholds),
  }));

  // Sort the full list by the tiebreaker chain — sets display order in allCandidates and
  // verdicts, and makes the winner == eligible[0] after filtering.
  const sorted = [...entries].sort((a, b) => sortEntries(a, b, sourcePriority));
  const eligible = sorted.filter((e) => e.tier !== "reject");
  const needsResearch = eligible.length === 0;

  let winner: ScoredEntry | null = null;
  let tieBreakApplied = false;
  let tieBreakPath: TieBreakStep[] = [];
  let tieBreakReason: string | null = null;
  let selectionReason: string;
  let confidenceTier: ConfidenceTier | null = null;
  let confidence: number | null = null;
  let researchReason: ResearchReason | null = null;
  let winnerSnapshot: WinnerSnapshot | null = null;

  if (!needsResearch) {
    winner = eligible[0];
    confidenceTier = winner.tier;
    confidence = winner.confidence;

    if (eligible.length >= 2 && eligible[0].overallScore === eligible[1].overallScore) {
      tieBreakApplied = true;
      tieBreakPath = buildTieBreakPath(eligible[0], eligible[1], sourcePriority);
      tieBreakReason = buildTieBreakReason(tieBreakPath, eligible[0], eligible[1], sourcePriority);
      logSelector("tieBreak", {
        beatId: intent.beatId,
        tieBreakPath,
        tieBreakReason,
        winnerId: winner.scored.candidate.candidate.candidateId,
      });
    }

    const wc = winner.scored.candidate.candidate;
    winnerSnapshot = {
      candidateId: wc.candidateId,
      source: wc.source,
      overallScore: winner.overallScore,
      confidence: winner.confidence,
      confidenceTier: winner.tier,
      rankingScore: wc.rankingScore ?? null,
      clipSimilarity: wc.clipSimilarity ?? null,
      embeddingSimilarity: wc.embeddingSimilarity ?? null,
      keywordScore: wc.keywordScore ?? null,
      rankPosition: winner.scored.candidate.position,
    };

    selectionReason = `Selected ${wc.candidateId} (${wc.source}) — overallScore=${winner.overallScore}, confidence=${winner.confidence.toFixed(2)}, tier=${confidenceTier}.`;
  } else {
    researchReason = detectResearchReason(scored, eligible);
    selectionReason = `No winner: ${researchReason} — all ${scored.length} candidate(s) below acceptable threshold (${thresholds.acceptable}).`;
    logSelector("reject", { beatId: intent.beatId, researchReason, candidateCount: scored.length });
  }

  // Build per-candidate verdicts — new objects, no mutation of inputs.
  const verdicts: CandidateVerdict[] = sorted.map((e) => {
    const c = e.scored.candidate.candidate;
    const isWinner = winner !== null && c.candidateId === winner.scored.candidate.candidate.candidateId;
    return {
      candidateId: c.candidateId,
      overallScore: e.overallScore,
      confidence: e.confidence,
      confidenceTier: e.tier,
      rankingScore: c.rankingScore ?? null,
      clipSimilarity: c.clipSimilarity ?? null,
      embeddingSimilarity: c.embeddingSimilarity ?? null,
      keywordScore: c.keywordScore ?? null,
      rejectedReason: isWinner ? null
        : e.tier === "reject"
          ? `overallScore ${e.overallScore} below acceptable threshold ${thresholds.acceptable}.`
          : `Outscored by ${winner?.scored.candidate.candidate.candidateId ?? "another candidate"}.`,
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
    tieBreakPath,
    tieBreakReason,
    selectedCandidateId: winner?.scored.candidate.candidate.candidateId ?? null,
    selectionReason,
    confidence,
    confidenceTier,
    needsResearch,
    researchReason,
    winnerSnapshot,
    verdicts,
  };

  recordSelectionOutcome({
    selected: !needsResearch,
    needsResearch,
    researchReason,
    tieBreakApplied,
    winnerSource: winner?.scored.candidate.candidate.source ?? null,
    winnerTier: confidenceTier,
    winnerOverallScore: winner?.overallScore ?? null,
    winnerConfidence: confidence,
    winnerRankPosition: winner?.scored.candidate.position ?? null,
    winnerClipSimilarity: winner?.scored.candidate.candidate.clipSimilarity ?? null,
    winnerEmbeddingSimilarity: winner?.scored.candidate.candidate.embeddingSimilarity ?? null,
    winnerVisionScore: winner?.overallScore ?? null,
  });

  logSelector(needsResearch ? "reject" : "complete", {
    beatId: intent.beatId,
    selectedCandidateId: trace.selectedCandidateId,
    confidence,
    confidenceTier,
    needsResearch,
    researchReason,
    durationMs,
    tieBreakApplied,
    tieBreakPath,
  });

  return {
    selectedCandidate: winner?.scored ?? null,
    selectedCandidateId: winner?.scored.candidate.candidate.candidateId ?? null,
    confidence,
    confidenceTier,
    needsResearch,
    researchReason,
    selectionReason,
    trace,
    allCandidates: sorted.map((e) => e.scored),
  };
}
