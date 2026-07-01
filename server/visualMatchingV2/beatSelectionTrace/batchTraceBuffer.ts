/** Visual Matching Engine V2 — Batch trace buffer (infrastructure only, not yet activated).
 *
 *  Buffers traces and flushes in bulk to the inner store either when the batch reaches
 *  maxBatchSize or after flushIntervalMs, whichever comes first. Reduces DB round-trips
 *  at high write volumes (100k+ videos/day).
 *
 *  Not activated by default — use createBeatSelectionTraceStore() which builds the active
 *  composition. Activate by injecting BatchTraceBuffer between AsyncTraceWriter and
 *  DatabaseTraceStore when per-beat latency is acceptable but DB throughput is a concern. */
import { logBeatSelectionTrace } from "../logging";
import type { BeatSelectionTraceStore, TraceContext } from "./types";
import type { SelectorTrace } from "../types";

type BufferItem = {
  trace: SelectorTrace;
  context?: TraceContext;
};

export type BatchTraceBufferOptions = {
  /** Flush when the buffer reaches this many traces. Default: 50. */
  maxBatchSize?: number;
  /** Flush after this many milliseconds even if maxBatchSize is not reached. Default: 2000. */
  flushIntervalMs?: number;
};

export class BatchTraceBuffer implements BeatSelectionTraceStore {
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly buffer: BufferItem[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly inner: BeatSelectionTraceStore,
    options: BatchTraceBufferOptions = {}
  ) {
    this.maxBatchSize = options.maxBatchSize ?? 50;
    this.flushIntervalMs = options.flushIntervalMs ?? 2000;
  }

  async save(trace: SelectorTrace, context?: TraceContext): Promise<void> {
    this.buffer.push({ trace, context });

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush().catch((err) => {
          logBeatSelectionTrace("error", { source: "BatchTraceBuffer.timer", error: (err as Error).message });
        });
      }, this.flushIntervalMs);
    }

    if (this.buffer.length >= this.maxBatchSize) {
      await this.flush();
    }
  }

  /** Flushes all buffered traces to the inner store immediately. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    for (const item of batch) {
      await this.inner.save(item.trace, item.context);
    }
  }

  get bufferLength(): number {
    return this.buffer.length;
  }
}
