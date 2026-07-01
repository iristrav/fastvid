import type { BeatSelectionTraceStore, TraceContext, VersionedSelectorTrace } from "./types";
import { TRACE_VERSION, SELECTOR_VERSION, VISION_VERSION, RANKING_VERSION, PROMPT_VERSION, SCHEMA_VERSION, ENGINE_VERSION } from "./types";
import type { SelectorTrace } from "../types";
import { randomUUID } from "crypto";
import * as os from "os";

/** In-memory store for tests. Thread-safe for the Node.js event loop (single-threaded). */
export class MemoryTraceStore implements BeatSelectionTraceStore {
  private readonly traces: VersionedSelectorTrace[] = [];

  async save(trace: SelectorTrace, _context?: TraceContext): Promise<void> {
    this.traces.push({
      ...trace,
      traceVersion: TRACE_VERSION,
      selectorVersion: SELECTOR_VERSION,
      visionVersion: VISION_VERSION,
      rankingVersion: RANKING_VERSION,
      promptVersion: PROMPT_VERSION,
      traceId: randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      createdAt: new Date().toISOString(),
      host: os.hostname(),
      workerId: String(process.pid),
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
