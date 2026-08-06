/** Editorial Review Engine V2 — public entry point (Phase 6).
 *
 * Everything a future renderer (Phase 7+) needs to consume this module's output lives behind
 * this one import. Gated behind editorialReviewEngineV2Enabled() (featureFlags.ts) and NOT
 * wired into the live production pipeline — nothing here renders anything, downloads media,
 * or calls FFmpeg; it only evaluates an already-produced EDL + AI Director output and reports
 * on it.
 */

// ─── Main entry point ───────────────────────────────────────────────────────
export { generateReviewReport, produceApprovedEDL } from "./reviewReportGenerator";

// ─── Feature flag ───────────────────────────────────────────────────────────
export { editorialReviewEngineV2Enabled } from "./featureFlags";

// ─── Individual reviewers, for callers that want one dimension directly ────────────────────
export { reviewShots } from "./shotReviewer";
export { reviewTransitions } from "./transitionReviewer";
export { reviewCaptions } from "./captionReviewer";
export { reviewPacing } from "./pacingReviewer";
export { reviewNarrative } from "./narrativeReviewer";
export { reviewRetention } from "./retentionReviewer";
export { reviewContinuity } from "./continuityReviewer";
export { reviewVisuals } from "./visualReviewer";
export { computeOverallScore } from "./qualityScorer";
export type { ScorableDimension } from "./qualityScorer";
export { planAutoFixes, planRecommendations } from "./improvementPlanner";
export { applyAutoFix, revertAutoFix } from "./autoFixApply";

// ─── Types ───────────────────────────────────────────────────────────────────────────────────
export type {
  ReviewInputV2,
  ReviewDimension,
  ProblemType,
  ProblemSeverity,
  Problem,
  RecommendationPriority,
  Recommendation,
  AutoFixType,
  AutoFix,
  ApprovalStatus,
  ReviewReport,
  ApprovedEDL,
  FlatBeat,
  DimensionScore,
} from "./types";
export { flattenEDLs } from "./types";
