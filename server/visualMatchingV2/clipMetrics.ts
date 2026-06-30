/** Visual Matching Engine V2 — CLIP Pre-Filter metrics.
 *  Global, cross-beat aggregates: average embed latency, embeddings/sec, average batch
 *  size, average similarity, cache-hit rate, and the inference mode (cpu/gpu, when
 *  determinable) the embedder ran in. Separate from clipPreFilter.ts's own per-beat
 *  ClipFilterTrace so this can feed a dashboard later without parsing logs. */

type ClipAccumulator = {
  candidatesScored: number;
  batches: number;
  totalBatchSize: number;
  totalLatencyMs: number;
  totalSimilarity: number;
  similarityCount: number;
  cacheHits: number;
};

function emptyAccumulator(): ClipAccumulator {
  return {
    candidatesScored: 0,
    batches: 0,
    totalBatchSize: 0,
    totalLatencyMs: 0,
    totalSimilarity: 0,
    similarityCount: 0,
    cacheHits: 0,
  };
}

let acc = emptyAccumulator();

export type ClipBatchOutcome = {
  /** Number of candidates in this batch (cache hits + freshly embedded). */
  batchSize: number;
  /** Total wall-clock ms for this batch's embedding work (0 when every candidate was a cache hit). */
  durationMs: number;
  /** Per-candidate similarity values successfully computed in this batch (cache hits included). */
  similarities: number[];
  /** Count of candidates in this batch resolved from the permanent cache instead of re-embedded. */
  cacheHits: number;
};

/** Records one clipPreFilter() batch's outcome. Called once per beat; never throws. */
export function recordClipBatchOutcome(outcome: ClipBatchOutcome): void {
  acc.candidatesScored += outcome.batchSize;
  acc.batches += 1;
  acc.totalBatchSize += outcome.batchSize;
  acc.totalLatencyMs += outcome.durationMs;
  acc.cacheHits += outcome.cacheHits;
  for (const sim of outcome.similarities) {
    acc.totalSimilarity += sim;
    acc.similarityCount += 1;
  }
}

export type ClipMetricsSnapshot = {
  candidatesScored: number;
  batches: number;
  avgBatchSize: number;
  avgLatencyMs: number;
  embeddingsPerSec: number;
  avgSimilarity: number | null;
  cacheHitRate: number;
  /** Inference backend mode. The ONNX runtime used by @xenova/transformers here always
   *  runs WASM/CPU (no GPU backend wired up in this codebase) — reported for forward
   *  compatibility if a GPU backend is added later. */
  inferenceMode: "cpu" | "gpu";
};

export function getClipMetrics(): ClipMetricsSnapshot {
  const totalLatencySec = acc.totalLatencyMs / 1000;
  return {
    candidatesScored: acc.candidatesScored,
    batches: acc.batches,
    avgBatchSize: acc.batches > 0 ? acc.totalBatchSize / acc.batches : 0,
    avgLatencyMs: acc.batches > 0 ? acc.totalLatencyMs / acc.batches : 0,
    embeddingsPerSec: totalLatencySec > 0 ? acc.candidatesScored / totalLatencySec : 0,
    avgSimilarity: acc.similarityCount > 0 ? acc.totalSimilarity / acc.similarityCount : null,
    cacheHitRate: acc.candidatesScored > 0 ? acc.cacheHits / acc.candidatesScored : 0,
    inferenceMode: "cpu",
  };
}

/** Test/debug helper — not used by production code paths. */
export function resetClipMetrics(): void {
  acc = emptyAccumulator();
}
