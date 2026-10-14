/** Cinematic Editing Engine — Camera Planner (Phase 4).
 *
 *  Chooses one CameraMovementType per beat, or explicitly Camera Hold when movement wouldn't
 *  improve the shot — "only apply movement when it improves the storytelling" is enforced by
 *  making Hold a first-class, frequently-correct answer, not a fallback that's avoided.
 *
 *  Superset of cinematicMotion/types.ts's ImageAnimation vocabulary (ken_burns_in/out,
 *  pan_left/right, slow_zoom) generalized to cover video clips as well as stills — that
 *  module's planner (`planSceneMotion`) is a dormant, image-card-only implementation of the
 *  same idea; rather than resurrecting a second still-only planner, this one supersedes it for
 *  Phase 4's purposes while keeping the same movement names it already established (ken_burns,
 *  pan_left/right) so a future renderer's image-card path can stay unchanged where reused.
 *  This plan is the only motion a still gets: the photo encoder holds the frame
 *  (documentaryStyle.ts's buildStillHoldTail) and cameraChain moves it in renderTimeline.
 */
import type { CandidateAsset } from "../visualMatchingV2/types";
import type { CameraInstruction, CameraMovementType, PacingProfile, ShotInstruction } from "./types";

function hold(reason: string): CameraInstruction {
  return { movement: "camera_hold", intensity: 0, reason };
}

function moved(movement: CameraMovementType, intensity: number, reason: string): CameraInstruction {
  return { movement, intensity: Math.max(0.1, Math.min(1, intensity)), reason };
}

/**
 * Chooses this beat's camera movement from the shot type already chosen (ShotPlanner), the
 * winning candidate (still vs. video, and any directional cues in its search text), and the
 * scene's pacing profile (EmotionalPacingPlanner) — dramatic pacing favors slow/subtle
 * movement, exciting pacing favors more overt movement, educational pacing favors stillness
 * on shots where the viewer needs to read/focus.
 */
function decideCameraMovement(
  shot: ShotInstruction,
  candidate: CandidateAsset,
  pacing: PacingProfile
): CameraInstruction {
  const isStill = candidate.assetType === "image";

  if (pacing.tone === "educational" && ["close_up", "detail", "extreme_close_up"].includes(shot.shotType)) {
    return hold(`Educational pacing on a ${shot.shotType} shot — stillness keeps the subject readable without distraction.`);
  }

  if (shot.shotType === "overlay_shot") {
    return hold("Overlay shots carry their own motion-graphic animation; a moving camera underneath would compete with it.");
  }

  if (shot.shotType === "archive_footage" && !isStill) {
    return hold("Archive video footage — held static to preserve the footage's own authentic motion rather than adding synthetic camera movement.");
  }

  if (isStill) {
    if (["establishing", "wide", "archive_footage"].includes(shot.shotType)) {
      return moved("ken_burns", pacing.movementIntensity, `Still image on a ${shot.shotType} shot — a slow Ken Burns drift keeps a static photo visually alive.`);
    }
    if (["close_up", "extreme_close_up"].includes(shot.shotType)) {
      if (pacing.tone === "exciting") {
        return moved("parallax", pacing.movementIntensity, "Exciting pacing on a close still — parallax adds dynamism beyond a plain zoom.");
      }
      return moved("zoom_in", pacing.movementIntensity + 0.1, `Still image on a ${shot.shotType} shot — a slow push-in draws focus onto the subject.`);
    }
    if (shot.shotType === "detail") {
      return moved("slow_push", pacing.movementIntensity, "Still image on a detail shot — a slow push reveals the detail without an abrupt zoom.");
    }
    return moved("ken_burns", pacing.movementIntensity, "Still image with no stronger shot-type signal — Ken Burns is the safe default over a static frame.");
  }

  /**
   * Video clip from here on. Real footage keeps its own motion: no synthetic pan, tilt, push or
   * dolly is laid over it, whatever the shot type or pacing. A shot whose file is shorter than its
   * slot is kept alive at render time instead (`timelineRenderer`, `holdTailCamera`), so the held
   * last frame never stands still.
   */
  return hold(`${shot.shotType} video shot — real footage keeps its own motion; no synthetic camera movement is added.`);
}

/** Phase 9: each of `decideCameraMovement`'s branches picks the single best movement for its
 *  own shot type/pacing signal in isolation — it has no memory of what the previous beat did.
 *  Repeating the identical movement (e.g. zoom_in twice in a row) reads as visually monotonous
 *  even when each choice was individually correct — a professional editor varies the camera
 *  treatment shot-to-shot. This table maps each movement to a documented, comparable
 *  alternative (same rough intent — e.g. `zoom_in`'s alternate is `slow_push`, another subtle
 *  push-in, not an unrelated movement) so swapping never contradicts the reason the original
 *  choice was made. `camera_hold` deliberately has no entry — repeated stillness two beats in a
 *  row is not the same problem as repeated motion. */
const VARIETY_ALTERNATE: Partial<Record<CameraMovementType, CameraMovementType>> = {
  zoom_in: "slow_push",
  zoom_out: "slow_pull",
  slow_push: "zoom_in",
  slow_pull: "zoom_out",
  pan_left: "pan_right",
  pan_right: "pan_left",
  tilt_up: "camera_drift",
  tilt_down: "camera_drift",
  ken_burns: "camera_drift",
  camera_drift: "ken_burns",
  virtual_dolly: "slow_push",
  parallax: "zoom_in",
};

/**
 * Chooses this beat's camera movement, then — when it would exactly repeat the immediately
 * preceding beat's movement within the same scene — swaps to a documented alternative for
 * shot-to-shot variety. `previousMovement` is optional and defaults to no variety check, so
 * every existing call site (and the underlying decision logic) is unchanged when omitted.
 */
export function planCameraMovement(
  shot: ShotInstruction,
  candidate: CandidateAsset,
  pacing: PacingProfile,
  previousMovement?: CameraMovementType | null
): CameraInstruction {
  const decision = decideCameraMovement(shot, candidate, pacing);

  if (previousMovement && decision.movement !== "camera_hold" && decision.movement === previousMovement) {
    const alternate = VARIETY_ALTERNATE[decision.movement];
    if (alternate) {
      return {
        movement: alternate,
        intensity: decision.intensity,
        reason: `${decision.reason} Varied from the previous beat's identical ${decision.movement} for shot-to-shot rhythm.`,
      };
    }
  }

  return decision;
}
