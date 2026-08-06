/** Professional Render Engine — public barrel (Phase 7).
 *
 *  The one intended import point for anything outside this directory that eventually wires
 *  this module up for real (see featureFlags.ts — nothing does yet). Internal helpers stay
 *  reachable via their own files for tests; this barrel surfaces only the pieces a caller
 *  actually needs: the top-level entry point, the per-format export orchestrator (for callers
 *  that want more control than the single entry point gives), and every public type.
 */
export { professionalRenderEngineEnabled, gpuEncodingEnabled } from "./featureFlags";
export { ProfessionalRenderEngineDisabledError, renderApprovedEDL } from "./professionalRenderEngine";
export { exportVideo, type ExportDependencies } from "./exportManager";
export { planRender, planScene, planEditDecision, type ClipAssetResolver } from "./renderPlanner";
export { validateEDL, validateRenderPlan, mergeValidationResults } from "./renderValidator";
export { encode, buildEncodeCommand, isForkPressureError } from "./encoder";
export { dimensionsFor, buildAspectRatioFilter } from "./aspectRatio";

export type {
  ApprovedEDL,
  AspectRatioName,
  CommandExecutor,
  Dimensions,
  EncodeAttempt,
  EncodeOptions,
  EncodeResult,
  ExportFormatResult,
  ExportRequest,
  ExportResult,
  FilterFragment,
  FilterGraphNode,
  RenderPlan,
  RenderResult,
  RenderStep,
  RenderStepType,
  SceneRenderPlan,
  ValidationIssue,
  ValidationIssueType,
  ValidationResult,
  ValidationSeverity,
} from "./types";
