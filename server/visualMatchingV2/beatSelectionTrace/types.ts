/** Visual Matching Engine V2 — BeatSelectionTrace types.
 *
 *  Pure storage layer. No pipeline logic — only receives SelectorTrace from the Selector
 *  and persists it. Imports nothing from retrieval, ranking, vision, or CLIP modules. */
import type { SelectorTrace } from "../types";
import { PROMPT_VERSION } from "../visionPromptBuilder";

// ─── Version constants ──────────────────────────────────────────────────────────

export const TRACE_VERSION = "1";
export const SELECTOR_VERSION = "1";
export const VISION_VERSION = "1";
export const RANKING_VERSION = "1";

// Re-export for convenience so DatabaseTraceStore does not need to import visionPromptBuilder.
export { PROMPT_VERSION };

// ─── Versioned wrapper ──────────────────────────────────────────────────────────

export type VersionedSelectorTrace = SelectorTrace & {
  traceVersion: string;
  selectorVersion: string;
  visionVersion: string;
  rankingVersion: string;
  promptVersion: string;
};

// ─── Serializer interface ───────────────────────────────────────────────────────

export interface TraceSerializer {
  serialize(trace: VersionedSelectorTrace): string;
  contentType: string;
}

export class JsonTraceSerializer implements TraceSerializer {
  readonly contentType = "application/json";
  serialize(trace: VersionedSelectorTrace): string {
    return JSON.stringify(trace);
  }
}

// ─── Store interface ────────────────────────────────────────────────────────────

/** The sole contract for persisting a SelectorTrace. Implementations: DatabaseTraceStore,
 *  MemoryTraceStore (tests), NullTraceStore (feature flag off). A failed save MUST NOT
 *  propagate — video production continues regardless of trace storage outcome. */
export interface BeatSelectionTraceStore {
  save(trace: SelectorTrace): Promise<void>;
}
