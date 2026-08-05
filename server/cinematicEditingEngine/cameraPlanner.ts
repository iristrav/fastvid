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
 *  Live production's own Ken Burns (documentaryStyle.ts's buildSimpleKenBurnsVF) is the actual
 *  renderer this maps onto once wired — not duplicated, just planned ahead of it here.
 */
import type { CandidateAsset } from "../visualMatchingV2/types";
import type { CameraInstruction, CameraMovementType, PacingProfile, ShotInstruction } from "./types";

const VERTICAL_SIGNALS = ["tower", "building", "skyscraper", "mountain", "cliff", "monument"];
const HORIZONTAL_SIGNALS = ["skyline", "landscape", "panorama", "coastline", "horizon"];
const OVERHEAD_SIGNALS = ["aerial", "overhead", "birds eye", "bird's eye", "from above"];

function candidateSearchText(candidate: CandidateAsset): string {
  return [candidate.searchQuery, candidate.title ?? "", candidate.description ?? ""].join(" ").toLowerCase();
}

function textMatchesAny(text: string, signals: string[]): string | null {
  return signals.find((s) => text.includes(s)) ?? null;
}

/** Deterministic pan direction, varied across candidates for visual variety — same seeded-pick
 *  idea as montageTransitions.ts's pickMontageXfadeTransition, just hashed on candidateId
 *  instead of scene/join index since this planner doesn't see a join index. */
function panDirection(candidateId: string): "pan_left" | "pan_right" {
  let hash = 0;
  for (const ch of candidateId) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return hash % 2 === 0 ? "pan_left" : "pan_right";
}

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
export function planCameraMovement(
  shot: ShotInstruction,
  candidate: CandidateAsset,
  pacing: PacingProfile
): CameraInstruction {
  const searchText = candidateSearchText(candidate);
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

  // Video clip from here on.
  if (["reaction", "cutaway", "b_roll"].includes(shot.shotType)) {
    return hold(`${shot.shotType} footage already carries its own incidental motion — held static rather than layering synthetic movement on top.`);
  }

  const overhead = textMatchesAny(searchText, OVERHEAD_SIGNALS);
  if (overhead && ["establishing", "wide"].includes(shot.shotType)) {
    return moved("tilt_down", pacing.movementIntensity, `Candidate's search text matches "${overhead}" — a downward tilt matches an overhead/aerial framing.`);
  }

  if (["establishing", "wide"].includes(shot.shotType)) {
    const vertical = textMatchesAny(searchText, VERTICAL_SIGNALS);
    if (vertical) {
      return moved("tilt_up", pacing.movementIntensity, `Candidate's search text matches "${vertical}" — a vertical subject reads best with an upward tilt.`);
    }
    const horizontal = textMatchesAny(searchText, HORIZONTAL_SIGNALS);
    if (horizontal) {
      const dir = panDirection(candidate.candidateId);
      return moved(dir, pacing.movementIntensity, `Candidate's search text matches "${horizontal}" — a horizontal ${dir === "pan_left" ? "left" : "right"} pan matches a wide horizontal subject.`);
    }
    return moved("camera_drift", pacing.movementIntensity, `${shot.shotType} video shot with no directional cue — a subtle drift adds life without implying a direction the footage doesn't have.`);
  }

  if (["detail", "extreme_close_up"].includes(shot.shotType)) {
    return moved("slow_push", pacing.movementIntensity, `${shot.shotType} shot — a slow push draws the viewer into the detail.`);
  }

  if (shot.shotType === "close_up") {
    if (pacing.tone === "dramatic") {
      return moved("slow_push", pacing.movementIntensity, "Dramatic pacing on a close-up — a slow push adds gravity to the moment.");
    }
    if (pacing.tone === "exciting") {
      return moved("zoom_in", pacing.movementIntensity + 0.1, "Exciting pacing on a close-up — a quicker push-in adds emphasis.");
    }
    return hold("Neutral/educational pacing on a close-up — held static keeps the subject's expression clear and unfussy.");
  }

  if (shot.shotType === "medium" && pacing.tone === "exciting") {
    return moved("virtual_dolly", pacing.movementIntensity, "Exciting pacing on an otherwise static medium shot — a virtual dolly adds energy the footage alone doesn't have.");
  }

  return hold(`${shot.shotType} video shot with no signal favoring movement — held static is the safe documentary default.`);
}
