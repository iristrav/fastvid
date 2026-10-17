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
 *  know shot type, subject, place and time, not the full VisualIntent/ClipInstruction, which
 *  keeps this planner trivially testable with plain objects. */
export type TransitionContext = {
  shotType: ShotType;
  /** The beat's primary visual subject, for match-cut/continuity detection. Empty string when
   *  the beat has no clear single subject. */
  subject: string;
  /** VIDEO 663 — where the picture is (`visualLocation`); empty when the beat names no place. */
  location?: string;
  /** VIDEO 663 — when the picture is (`visualTime`); empty when the beat names no time. */
  time?: string;
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

/**
 * VIDEO 663 — a chapter's opening dips through black this long: short enough that the black itself
 * stays well under the delivered file's black check (`blackdetect d=0.35`), long enough to read as a
 * pause between chapters.
 */
export const CHAPTER_DIP_SEC = 0.5;

function transition(type: TransitionType, reason: string, durationSec = DEFAULT_DURATION[type]): TransitionInstruction {
  return { type, durationSec, reason };
}

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
/** Two named values that differ — an unnamed one is never a change. */
const changed = (a: string | undefined, b: string | undefined) => norm(a).length > 0 && norm(b).length > 0 && norm(a) !== norm(b);

/**
 * Chooses the transition from `prev` into `next`. `prev === null` means this is the first
 * decision in the scene.
 *
 * VIDEO 663 — THE WAY A DOCUMENTARY EDITOR USES A DISSOLVE. The owner asked what dissolves could
 * still do; render 73 had ten, put where the shot type happened to change ("no stronger stylistic
 * signal — a soft cross dissolve is a safe default"), whips, slides and film burns among the plans.
 * Now:
 *
 *   a new chapter (the first shot of any scene after the first)   a short dip through black
 *   a jump in time (archive ↔ present, or another named time)    a cross dissolve
 *   a jump in place (another named location)                     a cross dissolve (a cut when exciting)
 *   everything else inside a scene                                a hard cut (a match cut on the same subject)
 *
 * Never two dissolves in a row, and pieces of one shot are always cut (`youtubeShotLimit`,
 * `longShotLimit`).
 */
export function planTransition(
  prev: TransitionContext | null,
  next: TransitionContext,
  pacing: PacingProfile,
  continuity?: VisualContinuityState,
  opts: { chapterStart?: boolean } = {}
): TransitionInstruction {
  if (!prev) {
    if (opts.chapterStart) {
      return transition("dip_to_black", "A new chapter begins — a short dip through black marks the pause between chapters.", CHAPTER_DIP_SEC);
    }
    return transition("cut", "First shot in the scene — nothing to transition from.");
  }

  const recent = continuity?.recentTransitions ?? [];
  const lastWasSoft = recent.length > 0 && recent[recent.length - 1] !== "cut" && recent[recent.length - 1] !== "match_cut";
  if (lastWasSoft) {
    return transition("cut", "The previous transition was already soft — a hard cut keeps dissolves for the moments that need them.");
  }

  const sameSubject = norm(prev.subject).length > 0 && norm(prev.subject) === norm(next.subject);
  if (prev.shotType === next.shotType && sameSubject) {
    return transition("match_cut", `Same shot type (${next.shotType}) and same subject ("${next.subject}") as the previous beat — a match cut keeps the action continuous.`);
  }

  const intoArchive = next.shotType === "archive_footage" && prev.shotType !== "archive_footage";
  const outOfArchive = prev.shotType === "archive_footage" && next.shotType !== "archive_footage";
  if (intoArchive || outOfArchive || changed(prev.time, next.time)) {
    return transition(
      "cross_dissolve",
      intoArchive
        ? "Into archival footage — a dissolve carries the viewer back in time."
        : outOfArchive
          ? "Out of archival footage — a dissolve brings the viewer back to the present."
          : `A jump in time ("${prev.time}" → "${next.time}") — a dissolve marks it.`
    );
  }

  if (changed(prev.location, next.location)) {
    if (pacing.tone === "exciting") {
      return transition("cut", `A new place ("${next.location}") under exciting pacing — a hard cut keeps the energy up.`);
    }
    return transition("cross_dissolve", `A jump in place ("${prev.location}" → "${next.location}") — a dissolve takes the viewer there.`);
  }

  return transition("cut", "Same time and place — a hard cut, as a documentary editor cuts inside a scene.");
}
