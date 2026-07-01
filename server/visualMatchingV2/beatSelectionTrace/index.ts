/** Visual Matching Engine V2 — BeatSelectionTrace factory.
 *
 *  Active composition (flag on):  AsyncTraceWriter → DatabaseTraceStore
 *  Flag off:                      NullTraceStore
 *
 *  The factory is the ONLY place that reads the feature flag and wires up the composition.
 *  Callers receive a BeatSelectionTraceStore and call save() without knowing the impl. */
import { visualMatchingV2BeatSelectionTraceEnabled } from "../../sourcingPolicy";
import type { BeatSelectionTraceStore } from "./types";
import { AsyncTraceWriter } from "./asyncTraceWriter";
import { DatabaseTraceStore } from "./databaseTraceStore";
import { NullTraceStore } from "./nullTraceStore";

export function createBeatSelectionTraceStore(): BeatSelectionTraceStore {
  if (!visualMatchingV2BeatSelectionTraceEnabled()) {
    return new NullTraceStore();
  }
  return new AsyncTraceWriter(new DatabaseTraceStore());
}

export type { BeatSelectionTraceStore, TraceContext, VersionedSelectorTrace, TraceSerializer, TraceRetentionPolicy } from "./types";
export { MemoryTraceStore } from "./memoryTraceStore";
export { NullTraceStore } from "./nullTraceStore";
export { DatabaseTraceStore } from "./databaseTraceStore";
export { AsyncTraceWriter } from "./asyncTraceWriter";
export { BatchTraceBuffer } from "./batchTraceBuffer";
export { JsonTraceSerializer, GzipJsonSerializer, MsgPackSerializer } from "./types";
export { TRACE_VERSION, SELECTOR_VERSION, VISION_VERSION, RANKING_VERSION, PROMPT_VERSION, SCHEMA_VERSION, ENGINE_VERSION } from "./types";
export { getTraceStorageMetrics, resetTraceStorageMetrics } from "./traceMetrics";
