/** Visual Matching Engine V2 — BeatSelectionTrace storage metrics.
 *  Tracks write-path performance separately from Selector decision metrics. */

type TraceStorageAccumulator = {
  saves: number;
  failedWrites: number;
  retryCount: number;
  totalSaveLatencyMs: number;
  totalSerializeLatencyMs: number;
  totalPayloadBytes: number;
  payloadCount: number;
  totalCompressedBytes: number;
  compressedCount: number;
  queueLength: number;
};

function emptyAcc(): TraceStorageAccumulator {
  return {
    saves: 0,
    failedWrites: 0,
    retryCount: 0,
    totalSaveLatencyMs: 0,
    totalSerializeLatencyMs: 0,
    totalPayloadBytes: 0,
    payloadCount: 0,
    totalCompressedBytes: 0,
    compressedCount: 0,
    queueLength: 0,
  };
}

let acc = emptyAcc();

export type TraceWriteOutcome = {
  saveLatencyMs: number;
  serializeLatencyMs: number;
  payloadBytes: number;
  /** Compressed bytes — only set when a compressing serializer is in use. */
  compressedBytes?: number;
  failed: boolean;
  retries: number;
};

export function recordTraceWrite(outcome: TraceWriteOutcome): void {
  acc.saves += 1;
  if (outcome.failed) acc.failedWrites += 1;
  acc.retryCount += outcome.retries;
  acc.totalSaveLatencyMs += outcome.saveLatencyMs;
  acc.totalSerializeLatencyMs += outcome.serializeLatencyMs;
  acc.totalPayloadBytes += outcome.payloadBytes;
  acc.payloadCount += 1;
  if (outcome.compressedBytes !== undefined) {
    acc.totalCompressedBytes += outcome.compressedBytes;
    acc.compressedCount += 1;
  }
}

export function setQueueLength(length: number): void {
  acc.queueLength = length;
}

export type TraceStorageMetricsSnapshot = {
  saves: number;
  failedWrites: number;
  failedWriteRate: number;
  retryCount: number;
  avgSaveLatencyMs: number | null;
  avgSerializeLatencyMs: number | null;
  avgPayloadBytes: number | null;
  avgCompressionRatio: number | null;
  queueLength: number;
};

export function getTraceStorageMetrics(): TraceStorageMetricsSnapshot {
  return {
    saves: acc.saves,
    failedWrites: acc.failedWrites,
    failedWriteRate: acc.saves > 0 ? acc.failedWrites / acc.saves : 0,
    retryCount: acc.retryCount,
    avgSaveLatencyMs: acc.saves > 0 ? acc.totalSaveLatencyMs / acc.saves : null,
    avgSerializeLatencyMs: acc.saves > 0 ? acc.totalSerializeLatencyMs / acc.saves : null,
    avgPayloadBytes: acc.payloadCount > 0 ? acc.totalPayloadBytes / acc.payloadCount : null,
    avgCompressionRatio: acc.compressedCount > 0 && acc.payloadCount > 0
      ? acc.totalCompressedBytes / acc.totalPayloadBytes
      : null,
    queueLength: acc.queueLength,
  };
}

/** Test/debug helper. */
export function resetTraceStorageMetrics(): void {
  acc = emptyAcc();
}
