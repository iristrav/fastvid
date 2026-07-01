/** Visual Matching Engine V2 — Async trace writer.
 *
 *  Wraps any BeatSelectionTraceStore so that save() returns immediately without waiting
 *  for the actual write. The pipeline gets its result back; the DB write happens in a
 *  subsequent microtask. Failure is isolated here: errors are caught, logged, and counted
 *  in traceMetrics — never propagated to the caller.
 *
 *  Composition:
 *    AsyncTraceWriter → DatabaseTraceStore (or any BeatSelectionTraceStore)
 *
 *  When async writing is not needed (e.g. integration tests), use the inner store directly. */
import { logBeatSelectionTrace } from "../logging";
import { recordTraceWrite, setQueueLength } from "./traceMetrics";
import type { BeatSelectionTraceStore, TraceContext } from "./types";
import type { SelectorTrace } from "../types";

type QueueItem = {
  trace: SelectorTrace;
  context?: TraceContext;
  enqueuedAt: number;
};

export class AsyncTraceWriter implements BeatSelectionTraceStore {
  private readonly queue: QueueItem[] = [];
  private draining = false;

  constructor(private readonly inner: BeatSelectionTraceStore) {}

  /** Returns immediately. The actual write is dispatched as a microtask. */
  async save(trace: SelectorTrace, context?: TraceContext): Promise<void> {
    this.queue.push({ trace, context, enqueuedAt: Date.now() });
    setQueueLength(this.queue.length);
    if (!this.draining) {
      this.draining = true;
      // Fire-and-forget via microtask — caller's await resolves before the write runs.
      Promise.resolve().then(() => this.drain()).catch(() => {});
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      setQueueLength(this.queue.length);
      const start = Date.now();
      let failed = false;

      try {
        await this.inner.save(item.trace, item.context);
      } catch (err) {
        failed = true;
        logBeatSelectionTrace("error", {
          beatId: item.trace.beatId,
          queueWaitMs: start - item.enqueuedAt,
          error: (err as Error).message,
        });
      }

      recordTraceWrite({
        saveLatencyMs: Date.now() - start,
        serializeLatencyMs: 0,  // DatabaseTraceStore measures its own serialize time if needed
        payloadBytes: 0,        // updated by DatabaseTraceStore via metrics if wired up
        failed,
        retries: 0,
      });

      if (!failed) {
        logBeatSelectionTrace("saved", {
          beatId: item.trace.beatId,
          queueWaitMs: start - item.enqueuedAt,
          saveLatencyMs: Date.now() - start,
        });
      }
    }
    this.draining = false;
  }

  /** Flushes all queued items synchronously — for graceful shutdown or test teardown. */
  async flush(): Promise<void> {
    await this.drain();
  }

  get queueLength(): number {
    return this.queue.length;
  }
}
