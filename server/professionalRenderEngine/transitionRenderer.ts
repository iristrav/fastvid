/** Professional Render Engine — Transition Renderer (Phase 7).
 *
 *  Turns a TransitionInstruction (already decided by Phase 4's TransitionPlanner — this file
 *  makes no transition-choice decisions of its own) into a real FFmpeg `xfade` filter node.
 *
 *  Reuses the exact xfade template already proven in production (videoPipeline.ts's montage
 *  builder, confirmed by this phase's research): `xfade=transition=X:duration=Y:offset=Z`, and
 *  the same offset-safety clamp that keeps a transition from overrunning the clip it starts
 *  from. `cross_dissolve` maps to ffmpeg's native "dissolve" name and `fade` to its native
 *  "fade" name — both are the same two names montageTransitions.ts already uses in live
 *  production, so this is the proven pattern, not a guess.
 *
 *  `cut` and `match_cut` intentionally return null — a hard cut needs no filter at all (the
 *  real production code takes the identical shortcut: it falls back to plain `concat` whenever
 *  the transition duration is ~0). A match cut's cinematic effect comes entirely from *which*
 *  two shots were chosen to sit next to each other — a decision already made upstream by the
 *  Cinematic Editing Engine — not from any filter applied at render time, so it is rendered
 *  exactly like a cut.
 *
 *  Eight of the fourteen TransitionType values (dip_to_black/white, blur, motion_blur, flash,
 *  light_leak, film_burn, whip, slide, push) have no prior implementation anywhere in this
 *  codebase (also confirmed by research). These are mapped to real, valid native FFmpeg xfade
 *  transition names (fadeblack, fadewhite, hblur, distance, radial, hrwind, slideleft,
 *  coverleft) that this repo has simply never used yet — not invented syntax. Several are
 *  honest approximations of a request FFmpeg's xfade filter has no exact primitive for,
 *  documented individually below rather than oversold as bespoke effects:
 *    - `blur` and `motion_blur` both use "hblur" — xfade only has one blur-style transition,
 *      so both requests reuse the same primitive rather than fabricating a second one.
 *    - `flash` reuses `dip_to_white`'s "fadewhite" primitive but forces a much shorter
 *      duration, so it reads as a snap-to-white flash rather than a slow dip.
 *    - `light_leak` and `film_burn` have no true texture-overlay asset in this codebase (no
 *      light-leak/film-grain footage library exists to composite) — they use the closest
 *      available native wipe-style primitives ("distance", "radial") as a placeholder, not a
 *      real texture effect.
 *    - `whip` uses "hrwind", xfade's directional wind-smear transition — the closest native
 *      primitive to a fast whip pan.
 *    - `push` uses "coverleft" — xfade's "cover" family pushes the incoming clip over the
 *      outgoing one, which is what a push transition means.
 */
import type { FilterGraphNode, TransitionInstruction, TransitionType } from "./types";

const NATIVE_XFADE_NAME: Partial<Record<TransitionType, string>> = {
  fade: "fade",
  cross_dissolve: "dissolve",
  dip_to_black: "fadeblack",
  dip_to_white: "fadewhite",
  blur: "hblur",
  motion_blur: "hblur",
  flash: "fadewhite",
  light_leak: "distance",
  film_burn: "radial",
  whip: "hrwind",
  slide: "slideleft",
  push: "coverleft",
};

/** `cut` and `match_cut` need no xfade filter — both render as a plain hard cut. */
export function isHardCut(type: TransitionType): boolean {
  return type === "cut" || type === "match_cut";
}

/** Same offset-safety clamp as the live production montage builder: the crossfade must start
 *  late enough to leave `transitionDurationSec` of the previous clip to blend with, and never
 *  overruns it even when durations are tight (the -0.01 margin absorbs rounding). */
export function computeXfadeOffset(prevDurationSec: number, transitionDurationSec: number): number {
  const offset = prevDurationSec - transitionDurationSec;
  const safeOffset = Math.max(0, Math.min(offset, Math.max(0, prevDurationSec - transitionDurationSec - 0.01)));
  return safeOffset;
}

/** `flash` reuses the "fadewhite" primitive but is capped short so it reads as a snap rather
 *  than a slow dip to white. */
const FLASH_MAX_DURATION_SEC = 0.15;

/** Builds this transition's xfade graph node joining `inputs[0]` (the outgoing stream) and
 *  `inputs[1]` (the incoming stream) into `output`. `prevDurationSec` is the duration of the
 *  accumulated timeline ending at `inputs[0]` at the point this transition starts. Returns null
 *  for cut/match_cut — callers must fall back to plain concat for those, matching the real
 *  production shortcut for a zero-duration transition. */
export function renderTransition(
  instruction: TransitionInstruction,
  inputs: [string, string],
  prevDurationSec: number,
  output: string
): FilterGraphNode | null {
  if (isHardCut(instruction.type)) return null;

  const xfadeName = NATIVE_XFADE_NAME[instruction.type];
  if (!xfadeName) return null;

  const durationSec =
    instruction.type === "flash" ? Math.min(instruction.durationSec, FLASH_MAX_DURATION_SEC) : instruction.durationSec;
  const offset = computeXfadeOffset(prevDurationSec, durationSec);

  return {
    inputs,
    filter: `xfade=transition=${xfadeName}:duration=${durationSec.toFixed(3)}:offset=${offset.toFixed(3)}`,
    output,
  };
}
