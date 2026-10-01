/** Cinematic Editing Engine — public entry point (Phase 4).
 *
 * Everything a future renderer (Phase 5) needs to consume this module lives behind this one
 * import. Nothing here reshapes what the internal planners already produce — this file only
 * re-exports.
 *
 * The cinematic timeline is FastVid's one render path; this module plans its edit decisions.
 * Nothing in this directory renders pixels or audio.
 */

// ─── Main entry point ───────────────────────────────────────────────────────
export { generateEDL } from "./edlGenerator";

// ─── Feature flag ───────────────────────────────────────────────────────────

// ─── Input contract (Scene / Visual Intent / Best Candidate / Timeline / Word Timestamps /
// Video Context / Visual Continuity — the literal Phase 4 INPUT list) ───────────────────────
export type { CinematicEditingInput, VisualContinuityState } from "./types";

// ─── Individual planners, for callers that want one decision directly ──────────────────────
export { deriveEmotionalTone } from "./emotionalPacing";
export { planShot } from "./shotPlanner";
export { planCameraMovement } from "./cameraPlanner";
export { planTransition } from "./transitionPlanner";
export type { TransitionContext } from "./transitionPlanner";
export { planClipTiming } from "./timelinePlanner";
export { planCaptions } from "./captionPlanner";
export type { CaptionPlannerOptions } from "./captionPlanner";
export { planMotionGraphics } from "./motionGraphicsPlanner";
export { planVisualEffects } from "./effectsPlanner";
export { planSoundEffects } from "./soundPlanner";

// ─── EDL output types ───────────────────────────────────────────────────────────────────────
export type {
  EDL,
  EditDecision,
  ShotType,
  ShotInstruction,
  CameraMovementType,
  CameraInstruction,
  TransitionType,
  TransitionInstruction,
  CaptionType,
  CaptionAnimation,
  CaptionPosition,
  CaptionInstruction,
  MotionGraphicType,
  MotionGraphicInstruction,
  VisualEffectType,
  EffectInstruction,
  SoundEffectType,
  SoundInstruction,
  EmotionalTone,
  PacingProfile,
  ClipInstruction,
} from "./types";
