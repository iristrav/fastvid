/** Visual Matching Engine V2 — VectorStore metrics (stage 3, Qdrant migration).
 *  Global, cross-call aggregates per operation (avg latency, error rate, retry rate),
 *  kept separate from per-call logging so this can feed a dashboard later. Backend-agnostic
 *  — any VectorStore implementation can record through this, not just Qdrant. */

export type VectorStoreOperation = "upsert" | "batchUpsert" | "search" | "delete" | "deleteMany" | "ensureCollection" | "healthCheck";

type OperationAccumulator = {
  calls: number;
  totalDurationMs: number;
  errors: number;
  retries: number;
};

function emptyAccumulator(): OperationAccumulator {
  return { calls: 0, totalDurationMs: 0, errors: 0, retries: 0 };
}

const accumulators = new Map<VectorStoreOperation, OperationAccumulator>();

export function recordVectorStoreCall(
  operation: VectorStoreOperation,
  durationMs: number,
  outcome: { error?: boolean; retries?: number } = {}
): void {
  const acc = accumulators.get(operation) ?? emptyAccumulator();
  acc.calls += 1;
  acc.totalDurationMs += durationMs;
  if (outcome.error) acc.errors += 1;
  if (outcome.retries) acc.retries += outcome.retries;
  accumulators.set(operation, acc);
}

export type VectorStoreMetricsSnapshot = {
  operation: VectorStoreOperation;
  calls: number;
  avgDurationMs: number;
  errorRate: number;
  avgRetries: number;
};

export function getVectorStoreMetrics(operation: VectorStoreOperation): VectorStoreMetricsSnapshot | undefined {
  const acc = accumulators.get(operation);
  if (!acc || acc.calls === 0) return undefined;
  return {
    operation,
    calls: acc.calls,
    avgDurationMs: acc.totalDurationMs / acc.calls,
    errorRate: acc.errors / acc.calls,
    avgRetries: acc.retries / acc.calls,
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
