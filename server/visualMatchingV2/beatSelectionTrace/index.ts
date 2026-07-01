/** Visual Matching Engine V2 — BeatSelectionTrace factory.
 *
 *  Returns a BeatSelectionTraceStore appropriate for the current environment:
 *  - NullTraceStore when the feature flag is off
 *  - DatabaseTraceStore otherwise
 *
 *  The factory is the ONLY place that reads the feature flag; callers receive a store and
 *  call save() without knowing which implementation is behind it. */
import { visualMatchingV2BeatSelectionTraceEnabled } from "../../sourcingPolicy";
import type { BeatSelectionTraceStore } from "./types";
import { DatabaseTraceStore } from "./databaseTraceStore";
import { NullTraceStore } from "./nullTraceStore";

export function createBeatSelectionTraceStore(): BeatSelectionTraceStore {
  if (!visualMatchingV2BeatSelectionTraceEnabled()) {
    return new NullTraceStore();
  }
  return new DatabaseTraceStore();
}

export type { BeatSelectionTraceStore } from "./types";
export { MemoryTraceStore } from "./memoryTraceStore";
export { NullTraceStore } from "./nullTraceStore";
export { DatabaseTraceStore } from "./databaseTraceStore";
export { JsonTraceSerializer, TRACE_VERSION, SELECTOR_VERSION, VISION_VERSION, RANKING_VERSION, PROMPT_VERSION } from "./types";
export type { VersionedSelectorTrace, TraceSerializer } from "./types";
