/** Visual Matching Engine V2 — VectorStore metrics (stage 3, Qdrant migration; extended
 *  for cloud-independence hardening). Global, cross-call aggregates per operation (avg/p95/p99
 *  latency, error rate, retry rate, and category-specific failure counters), kept separate
 *  from per-call logging so this can feed a dashboard later. Backend-agnostic — any
 *  VectorStore implementation can record through this, not just Qdrant. */

export type VectorStoreOperation = "upsert" | "batchUpsert" | "search" | "delete" | "deleteMany" | "ensureCollection" | "healthCheck";

/** Caps how many recent latency samples are kept per operation for percentile
 *  computation. Bounded so memory stays flat even after millions of calls — recent
 *  samples are a good enough approximation of p95/p99 for an in-process dashboard
 *  feed; this is not meant to be an exact, unbounded histogram. */
const MAX_LATENCY_SAMPLES = 1000;

type OperationAccumulator = {
  calls: number;
  totalDurationMs: number;
  errors: number;
  retries: number;
  timeoutErrors: number;
  providerErrors: number;
  healthFailures: number;
  /** Ring buffer of recent latencies, used only for percentile estimation. */
  latencySamples: number[];
  nextSampleIndex: number;
};

function emptyAccumulator(): OperationAccumulator {
  return {
    calls: 0,
    totalDurationMs: 0,
    errors: 0,
    retries: 0,
    timeoutErrors: 0,
    providerErrors: 0,
    healthFailures: 0,
    latencySamples: [],
    nextSampleIndex: 0,
  };
}

const accumulators = new Map<VectorStoreOperation, OperationAccumulator>();

function recordLatencySample(acc: OperationAccumulator, durationMs: number): void {
  if (acc.latencySamples.length < MAX_LATENCY_SAMPLES) {
    acc.latencySamples.push(durationMs);
  } else {
    acc.latencySamples[acc.nextSampleIndex] = durationMs;
    acc.nextSampleIndex = (acc.nextSampleIndex + 1) % MAX_LATENCY_SAMPLES;
  }
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function recordVectorStoreCall(
  operation: VectorStoreOperation,
  durationMs: number,
  outcome: { error?: boolean; retries?: number; timeout?: boolean; providerError?: boolean; healthFailure?: boolean } = {}
): void {
  const acc = accumulators.get(operation) ?? emptyAccumulator();
  acc.calls += 1;
  acc.totalDurationMs += durationMs;
  recordLatencySample(acc, durationMs);
  if (outcome.error) acc.errors += 1;
  if (outcome.retries) acc.retries += outcome.retries;
  if (outcome.timeout) acc.timeoutErrors += 1;
  if (outcome.providerError) acc.providerErrors += 1;
  if (outcome.healthFailure) acc.healthFailures += 1;
  accumulators.set(operation, acc);
}

export type VectorStoreMetricsSnapshot = {
  operation: VectorStoreOperation;
  calls: number;
  avgDurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  errorRate: number;
  avgRetries: number;
  timeoutErrors: number;
  providerErrors: number;
  healthFailures: number;
};

export function getVectorStoreMetrics(operation: VectorStoreOperation): VectorStoreMetricsSnapshot | undefined {
  const acc = accumulators.get(operation);
  if (!acc || acc.calls === 0) return undefined;
  return {
    operation,
    calls: acc.calls,
    avgDurationMs: acc.totalDurationMs / acc.calls,
    p95DurationMs: percentile(acc.latencySamples, 95),
    p99DurationMs: percentile(acc.latencySamples, 99),
    errorRate: acc.errors / acc.calls,
    avgRetries: acc.retries / acc.calls,
    timeoutErrors: acc.timeoutErrors,
    providerErrors: acc.providerErrors,
    healthFailures: acc.healthFailures,
  };
}

export function getAllVectorStoreMetrics(): VectorStoreMetricsSnapshot[] {
  return Array.from(accumulators.keys())
    .map((op) => getVectorStoreMetrics(op))
    .filter((m): m is VectorStoreMetricsSnapshot => !!m);
}

/** Test/debug helper — not used by production code paths. */
export function resetVectorStoreMetrics(): void {
  accumulators.clear();
}
