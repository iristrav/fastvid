/** Cinematic Editing Engine — Transition Planner (Phase 4).
 *
 *  Chooses the transition INTO each beat from the one before it. Cut is the default and the
 *  most common answer by design — every other transition type must earn its place with a
 *  specific trigger, per "do not overuse effects" and "DOCUMENTARY STYLE: not TikTok spam."
 *  An explicit overuse guard forces a hard cut back in whenever two fancy transitions would
 *  otherwise land back to back, regardless of what would otherwise be chosen.
 *
 *  Reuses montageTransitions.ts's cross-dissolve concept (that module already varies xfade
 *  transitions for montage clip joins in the live pipeline) rather than inventing a
 *  differently-named "soft cut" concept — cross_dissolve here maps onto the same underlying
 *  idea a future renderer would hand to montageTransitions.ts's xfade builder.
 */
import type { PacingProfile, ShotType, TransitionInstruction, TransitionType, VisualContinuityState } from "./types";

/** Minimal projection of the two decisions being joined — a transition only ever needs to
 *  know shot type and subject continuity, not the full VisualIntent/ClipInstruction, which
 *  keeps this planner trivially testable with plain objects. */
export type TransitionContext = {
  shotType: ShotType;
  /** The beat's primary visual subject, for match-cut/continuity detection. Empty string when
   *  the beat has no clear single subject. */
  subject: string;
};

const DEFAULT_DURATION: Record<TransitionType, number> = {
  cut: 0,
  fade: 0.6,
  cross_dissolve: 0.6,
  dip_to_black: 0.7,
  dip_to_white: 0.7,
  blur: 0.35,
  motion_blur: 0.25,
  flash: 0.15,
  light_leak: 0.5,
  film_burn: 0.4,
  whip: 0.25,
  slide: 0.3,
  push: 0.3,
  match_cut: 0,
};

function transition(type: TransitionType, reason: string): TransitionInstruction {
  return { type, durationSec: DEFAULT_DURATION[type], reason };
}

/**
 * Chooses the transition from `prev` into `next`. `prev === null` means this is the first
 * decision in the scene — always a hard cut, since there is nothing to transition from.
 */
export function planTransition(
  prev: TransitionContext | null,
  next: TransitionContext,
  pacing: PacingProfile,
  continuity?: VisualContinuityState
): TransitionInstruction {
  if (!prev) {
    return transition("cut", "First shot in the scene — nothing to transition from.");
  }

  const recent = continuity?.recentTransitions ?? [];
  const lastTwoNonCut = recent.length >= 2 && recent.slice(-2).every((t) => t !== "cut");
  if (lastTwoNonCut) {
    return transition("cut", "The last two transitions in this scene were both stylized — cutting back to a hard cut avoids transition fatigue.");
  }

  const sameSubject = prev.subject.trim().length > 0 && prev.subject.trim().toLowerCase() === next.subject.trim().toLowerCase();
  if (prev.shotType === next.shotType && sameSubject) {
    return transition("match_cut", `Same shot type (${next.shotType}) and same subject ("${next.subject}") as the previous beat — a match cut keeps the action continuous.`);
  }

  if (next.shotType === "archive_footage" && prev.shotType !== "archive_footage") {
    return transition("film_burn", "Cutting into archival footage from modern footage — a film burn signals the jump back in time.");
  }
  if (prev.shotType === "archive_footage" && next.shotType !== "archive_footage") {
    return transition("dip_to_black", "Cutting out of archival footage back to modern footage — a dip to black marks the return to the present.");
  }

  if (next.shotType === "establishing") {
    if (pacing.tone === "dramatic") {
      return transition("dip_to_black", "New location established under dramatic pacing — a dip to black gives the moment weight before revealing it.");
    }
    if (pacing.tone === "exciting") {
      return transition("cut", "New location established under exciting pacing — a hard cut keeps the energy up rather than slowing for a fade.");
    }
    return transition("fade", "New location established — a fade cleanly orients the viewer before the establishing shot.");
  }

  if ((next.shotType === "reaction" || next.shotType === "cutaway") && pacing.tone === "exciting") {
    return transition("slide", `Cutting to a ${next.shotType} shot under exciting pacing — a slide adds lateral energy while staying quick.`);
  }

  if (prev.shotType === next.shotType) {
    return transition("cut", `Shot type unchanged (${next.shotType}) — a hard cut is enough, no transition effect needed.`);
  }

  if (pacing.tone === "exciting" && pacing.cutSpeedMultiplier > 1.2) {
    return transition("whip", "Shot type changed under fast, exciting pacing — a whip transition matches the energy.");
  }
  if (pacing.tone === "dramatic") {
    return transition("cross_dissolve", "Shot type changed under dramatic pacing — a cross dissolve softens the cut to match the slower mood.");
  }
  if (pacing.tone === "educational") {
    return transition("cut", "Educational pacing prioritizes clean, readable edits — a hard cut over a stylized transition.");
  }

  return transition("cross_dissolve", "Shot type changed with no stronger stylistic signal — a soft cross dissolve is a safe, unobtrusive default.");
}
