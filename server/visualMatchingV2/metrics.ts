/** Visual Matching Engine V2 — Candidate Fetcher metrics.
 *  Global, cross-beat aggregates per source (avg search time, timeout rate, retry rate,
 *  cache hit rate, avg candidates per search). Deliberately separate from the per-beat
 *  CandidateFetchTrace/logging so this can feed a dashboard later without parsing logs. */

import type { CandidateSource, SourceFetchOutcome, SourceMetricsSnapshot } from "./types";

type SourceAccumulator = {
  searches: number;
  totalDurationMs: number;
  timeouts: number;
  retries: number;
  cacheHits: number;
  totalCandidates: number;
};

function emptyAccumulator(): SourceAccumulator {
  return { searches: 0, totalDurationMs: 0, timeouts: 0, retries: 0, cacheHits: 0, totalCandidates: 0 };
}

const accumulators = new Map<CandidateSource, SourceAccumulator>();

/** Records one source's outcome from a single beat's fetch. Called by the Candidate
 *  Fetcher after every source search; never throws. */
export function recordSourceOutcome(outcome: SourceFetchOutcome): void {
  const acc = accumulators.get(outcome.source) ?? emptyAccumulator();
  acc.searches += 1;
  acc.totalDurationMs += outcome.durationMs;
  if (outcome.timedOut) acc.timeouts += 1;
  if (outcome.retries > 0) acc.retries += 1;
  if (outcome.cacheHit) acc.cacheHits += 1;
  acc.totalCandidates += outcome.candidates.length;
  accumulators.set(outcome.source, acc);
}

export function getSourceMetrics(source: CandidateSource): SourceMetricsSnapshot | undefined {
  const acc = accumulators.get(source);
  if (!acc || acc.searches === 0) return undefined;
  return {
    source,
    searches: acc.searches,
    avgDurationMs: acc.totalDurationMs / acc.searches,
    timeoutRate: acc.timeouts / acc.searches,
    retryRate: acc.retries / acc.searches,
    cacheHitRate: acc.cacheHits / acc.searches,
    avgCandidatesPerSearch: acc.totalCandidates / acc.searches,
  };
}

export function getAllSourceMetrics(): SourceMetricsSnapshot[] {
  return Array.from(accumulators.keys())
    .map((source) => getSourceMetrics(source))
    .filter((m): m is SourceMetricsSnapshot => !!m);
}

/** Test/debug helper — not used by production code paths. */
export function resetMetrics(): void {
  accumulators.clear();
}
