/** Visual Matching Engine V2 — LLM Vision Scorer metrics.
 *  Global, cross-beat aggregates: avg latency, cache-hit rate, tokens/candidate,
 *  tokens/beat, avg overallScore, avg per-dimension score, estimated cost per video.
 *  Deliberately separate from VisionScoreTrace (per-beat) so this can feed a dashboard. */

type VisionAccumulator = {
  calls: number;
  candidatesScored: number;
  cacheHits: number;
  totalLatencyMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalOverallScore: number;
  dimensionTotals: {
    subjectMatch: number;
    actionMatch: number;
    historicalAccuracy: number;
    contextMatch: number;
    locationMatch: number;
    emotionMatch: number;
  };
};

function emptyAccumulator(): VisionAccumulator {
  return {
    calls: 0,
    candidatesScored: 0,
    cacheHits: 0,
    totalLatencyMs: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalOverallScore: 0,
    dimensionTotals: { subjectMatch: 0, actionMatch: 0, historicalAccuracy: 0, contextMatch: 0, locationMatch: 0, emotionMatch: 0 },
  };
}

let acc = emptyAccumulator();

export type VisionCallOutcome = {
  candidatesScored: number;
  cacheHits: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  overallScores: number[];
  dimensionScores: {
    subjectMatch: number[];
    actionMatch: number[];
    historicalAccuracy: number[];
    contextMatch: number[];
    locationMatch: number[];
    emotionMatch: number[];
  };
};

/** Records one scoreCandidates() call's outcome. Called once per beat; never throws. */
export function recordVisionCallOutcome(outcome: VisionCallOutcome): void {
  acc.calls += 1;
  acc.candidatesScored += outcome.candidatesScored;
  acc.cacheHits += outcome.cacheHits;
  acc.totalLatencyMs += outcome.latencyMs;
  acc.totalPromptTokens += outcome.promptTokens;
  acc.totalCompletionTokens += outcome.completionTokens;
  for (const s of outcome.overallScores) acc.totalOverallScore += s;
  for (const s of outcome.dimensionScores.subjectMatch) acc.dimensionTotals.subjectMatch += s;
  for (const s of outcome.dimensionScores.actionMatch) acc.dimensionTotals.actionMatch += s;
  for (const s of outcome.dimensionScores.historicalAccuracy) acc.dimensionTotals.historicalAccuracy += s;
  for (const s of outcome.dimensionScores.contextMatch) acc.dimensionTotals.contextMatch += s;
  for (const s of outcome.dimensionScores.locationMatch) acc.dimensionTotals.locationMatch += s;
  for (const s of outcome.dimensionScores.emotionMatch) acc.dimensionTotals.emotionMatch += s;
}

export type VisionMetricsSnapshot = {
  calls: number;
  candidatesScored: number;
  cacheHitRate: number;
  avgLatencyMs: number;
  avgPromptTokensPerBeat: number;
  avgCompletionTokensPerBeat: number;
  avgTotalTokensPerBeat: number;
  avgPromptTokensPerCandidate: number;
  avgCompletionTokensPerCandidate: number;
  avgOverallScore: number | null;
  avgDimensionScores: {
    subjectMatch: number | null;
    actionMatch: number | null;
    historicalAccuracy: number | null;
    contextMatch: number | null;
    locationMatch: number | null;
    emotionMatch: number | null;
  };
  /** Rough cost estimate (USD) based on gpt-4o-mini pricing: $0.15/M input, $0.60/M output. */
  estimatedCostUsd: number;
};

const GPT4O_MINI_INPUT_USD_PER_TOKEN = 0.15 / 1_000_000;
const GPT4O_MINI_OUTPUT_USD_PER_TOKEN = 0.60 / 1_000_000;

export function getVisionMetrics(): VisionMetricsSnapshot {
  const n = acc.candidatesScored;
  const calls = acc.calls;
  const avg = (total: number) => (n > 0 ? total / n : null);
  return {
    calls,
    candidatesScored: n,
    cacheHitRate: n > 0 ? acc.cacheHits / n : 0,
    avgLatencyMs: calls > 0 ? acc.totalLatencyMs / calls : 0,
    avgPromptTokensPerBeat: calls > 0 ? acc.totalPromptTokens / calls : 0,
    avgCompletionTokensPerBeat: calls > 0 ? acc.totalCompletionTokens / calls : 0,
    avgTotalTokensPerBeat: calls > 0 ? (acc.totalPromptTokens + acc.totalCompletionTokens) / calls : 0,
    avgPromptTokensPerCandidate: n > 0 ? acc.totalPromptTokens / n : 0,
    avgCompletionTokensPerCandidate: n > 0 ? acc.totalCompletionTokens / n : 0,
    avgOverallScore: avg(acc.totalOverallScore),
    avgDimensionScores: {
      subjectMatch: avg(acc.dimensionTotals.subjectMatch),
      actionMatch: avg(acc.dimensionTotals.actionMatch),
      historicalAccuracy: avg(acc.dimensionTotals.historicalAccuracy),
      contextMatch: avg(acc.dimensionTotals.contextMatch),
      locationMatch: avg(acc.dimensionTotals.locationMatch),
      emotionMatch: avg(acc.dimensionTotals.emotionMatch),
    },
    estimatedCostUsd:
      acc.totalPromptTokens * GPT4O_MINI_INPUT_USD_PER_TOKEN +
      acc.totalCompletionTokens * GPT4O_MINI_OUTPUT_USD_PER_TOKEN,
  };
}

/** Test/debug helper — not used by production code paths. */
export function resetVisionMetrics(): void {
  acc = emptyAccumulator();
}
