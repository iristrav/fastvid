/** Editorial Review Engine V2 — Quality Scorer (Phase 6).
 *
 *  Aggregates every reviewer's DimensionScore into one weighted Overall Professional Quality
 *  score — same weighted-sum approach as the legacy engine's computeOverall(), reused as a
 *  pattern (not a literal import, since the dimension set and weights are entirely different
 *  here). Does no analysis of its own; purely a weighting function over already-computed scores.
 */
import type { DimensionScore, ReviewDimension } from "./types";

export type ScorableDimension = Exclude<ReviewDimension, "overallProfessionalQuality">;

/** Weights sum to 1.0. Narrative clarity and viewer retention are weighted highest — a
 *  professional documentary editor cares most about whether the story lands and whether
 *  viewers stay, with everything else (shot/transition/text mechanics) in service of that. */
const DIMENSION_WEIGHTS: Record<ScorableDimension, number> = {
  narrativeClarity: 0.14,
  viewerRetention: 0.14,
  visualAccuracy: 0.13,
  visualDiversity: 0.1,
  pacing: 0.1,
  emotionalFlow: 0.09,
  shotVariety: 0.08,
  transitionQuality: 0.06,
  textUsage: 0.06,
  historicalAccuracy: 0.05,
  contextConsistency: 0.05,
};

function qualityTier(score: number): string {
  if (score >= 85) return "excellent";
  if (score >= 70) return "solid";
  if (score >= 55) return "needs work";
  return "weak";
}

export function computeOverallScore(scores: Record<ScorableDimension, DimensionScore>): {
  overallScore: number;
  overallQuality: DimensionScore;
} {
  let total = 0;
  for (const [dim, weight] of Object.entries(DIMENSION_WEIGHTS) as [ScorableDimension, number][]) {
    total += scores[dim].score * weight;
  }
  const overallScore = Math.round(Math.max(0, Math.min(100, total)));

  const weakest = (Object.entries(scores) as [ScorableDimension, DimensionScore][])
    .sort((a, b) => a[1].score - b[1].score)
    .slice(0, 2)
    .map(([dim, ds]) => `${dim} (${ds.score})`);

  return {
    overallScore,
    overallQuality: {
      score: overallScore,
      feedback: `Overall professional quality: ${qualityTier(overallScore)} (${overallScore}/100), weighted across ${Object.keys(DIMENSION_WEIGHTS).length} dimensions. Weakest: ${weakest.join(", ")}.`,
    },
  };
}
