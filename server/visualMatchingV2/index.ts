/** Visual Matching Engine V2 — public entry point (Phase 3 "foundation for Phase 4").
 *
 * Everything Phase 4 needs to consume this module lives behind this one import, instead of
 * reaching into internal files directly. Nothing here is reshaped from what the internal
 * stages already produce — this file only re-exports, so Phase 4 always sees exactly the same
 * data the internal pipeline itself works with.
 *
 * Still gated behind visualMatchingV2PipelineEnabled() (sourcingPolicy.ts) and NOT wired into
 * the live production pipeline — see the Phase 3 migration summary. Wiring this in for real is
 * explicitly Phase 4 scope.
 */

// ─── Main entry point ───────────────────────────────────────────────────────
export { runV2Pipeline } from "./v2Pipeline";
export type { BeatInput, V2BeatResult, V2PipelineOptions, V2PipelineResult } from "./v2Pipeline";

// ─── Scene / Timeline — reuses Phase 2's pipeline contracts verbatim, not reshaped ──────────
export type { Scene, Timeline, TimelineEntry } from "../pipeline/types";

// ─── VisualIntent — richer entity extraction (Phase 3) ──────────────────────────────────────
export { extractVisualIntentsForScene } from "./visualIntentExtractor";
export { buildVideoContext } from "./videoContext";
export type { VideoContext, VisualIntent } from "./types";

// ─── Ranked search queries (Phase 3) — 10-30 ranked candidates per beat, not 2 keywords ─────
export { generateRankedSearchQueries } from "./queryGeneration";
export type { RankedQuery, RankedQuerySource } from "./types";

// ─── Candidate List / Best Candidate ────────────────────────────────────────────────────────
export { rankCandidates, DEFAULT_RANKING_CONFIG, DEFAULT_RANKING_WEIGHTS } from "./candidateRanking";
export { selectCandidate } from "./candidateSelector";
export type {
  CandidateAsset,
  CandidateSource,
  RankedCandidate,
  RankingOptions,
  ScoredCandidate,
  SelectionResult,
} from "./types";

// ─── Supporting Phase 3 capabilities, for callers that want them directly ───────────────────
export { planSubBeatCuts } from "./timingAlignment";
export type { SubBeatCut } from "./timingAlignment";
export { isOffTopicForVideoContext } from "./continuity";
export { buildEntityFallbackIntents, reliesOnSpecificEntity } from "./intelligentFallback";
