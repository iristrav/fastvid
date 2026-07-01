import type { BeatSelectionTraceStore, VersionedSelectorTrace } from "./types";
import { TRACE_VERSION, SELECTOR_VERSION, VISION_VERSION, RANKING_VERSION, PROMPT_VERSION } from "./types";
import type { SelectorTrace } from "../types";

/** In-memory store for tests. Thread-safe for the Node.js event loop (single-threaded). */
export class MemoryTraceStore implements BeatSelectionTraceStore {
  private readonly traces: VersionedSelectorTrace[] = [];

  async save(trace: SelectorTrace): Promise<void> {
    this.traces.push({
      ...trace,
      traceVersion: TRACE_VERSION,
      selectorVersion: SELECTOR_VERSION,
      visionVersion: VISION_VERSION,
      rankingVersion: RANKING_VERSION,
      promptVersion: PROMPT_VERSION,
    });
  }

  /** Returns a snapshot of all saved traces — for test assertions only. */
  getAll(): readonly VersionedSelectorTrace[] {
    return [...this.traces];
  }

  clear(): void {
    this.traces.length = 0;
  }
}
