/** AI Director — public entry point (Phase 5).
 *
 * Everything Phase 6 (or the Cinematic Editing Engine's optional directorGuidance hook) needs
 * to consume this module lives behind this one import. Gated behind aiDirectorEnabled()
 * (featureFlags.ts) and NOT wired into the live production pipeline — see the Phase 5
 * migration summary. This module makes no rendering, media-search, or FFmpeg decisions —
 * only structured editorial judgments.
 */

// ─── Main entry point ───────────────────────────────────────────────────────
export { runAIDirector } from "./aiDirector";
export type { SceneInput } from "./aiDirector";

// ─── Feature flag ───────────────────────────────────────────────────────────
export { aiDirectorEnabled } from "./featureFlags";

// ─── Single-scene planner, for callers that want one decision directly ─────────────────────
export { planDirectorDecision } from "./directorPlanner";

// ─── Cinematic Editing Engine integration ───────────────────────────────────────────────────
export { toDirectorGuidance } from "./integration";

// ─── Individual sub-planners ────────────────────────────────────────────────────────────────
export {
  classifyNarrative,
  classifySceneEmotion,
  classifyVisualStrategy,
  deriveSupportingVisuals,
  directorEmotionToPacingTone,
  pickSubjectFocus,
} from "./narrativeAnalysis";
export { planShotOrder } from "./shotOrderPlanner";
export { decideEnergyTrend, decidePacing, decideTransitionStyle, suggestSoundCue, suggestTextOverlay, averageSceneDurationSec } from "./pacingAdvisor";
export { buildAttentionRecommendations, buildHookGuidance, buildRetentionRisk, HOOK_WINDOW_SEC } from "./attentionManager";

// ─── Types ───────────────────────────────────────────────────────────────────────────────────
export type {
  DirectorContext,
  DirectorDecision,
  DirectorOutput,
  NarrativeFunction,
  DirectorEmotion,
  VisualStrategy,
  PacingLabel,
  EnergyTrend,
  ShotOrderItem,
  AttentionRecommendationType,
  AttentionRecommendation,
  HookGuidance,
  RetentionRisk,
  HighlightMoment,
  RetentionRiskEntry,
} from "./types";
