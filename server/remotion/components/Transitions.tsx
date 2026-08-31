/**
 * RONDE 150 §9 — transitions, and the ones that are refused rather than faked.
 *
 * ── §9's rule, which is the reason this file is short ────────────────────────────────────────
 *
 * "Een unsupported transition mag nooit stil veranderen in hard_cut."
 *
 * So `transitionOpacity` returns null for a transition it does not know, and the caller reports it.
 * The tempting shape — a switch with `default: return 1` — is exactly the silent fallback the rule
 * forbids: a film burn would render as a cut and nothing anywhere would say the plan was not
 * followed.
 */
import { interpolate } from "remotion";

/** Transitions this layer executes. Adding one means adding a case below, not just a name. */
export const REMOTION_TRANSITIONS: ReadonlySet<string> = new Set([
  "hard_cut",
  "crossfade",
  "dissolve",
  "dip_to_black",
  "dip_to_white",
]);

export function transitionIsSupported(kind: string): boolean {
  return REMOTION_TRANSITIONS.has(kind);
}

export type TransitionStyle = { opacity: number; overlay: string | null };

/**
 * How a clip looks `frame` frames into its own transition.
 *
 * Returns null — not a default — for an unknown transition, so the caller must decide what to do
 * and can report it.
 *
 * crossfade and dissolve differ in intent (a crossfade blends two pictures, a dissolve softens
 * through) and are the same opacity ramp at this layer; the difference lives in whether the
 * outgoing clip is still drawn underneath, which the composition decides.
 */
export function transitionStyleAt(
  kind: string,
  frame: number,
  durationInFrames: number
): TransitionStyle | null {
  if (kind === "hard_cut") return { opacity: 1, overlay: null };
  if (!REMOTION_TRANSITIONS.has(kind)) return null;
  if (durationInFrames <= 0) return { opacity: 1, overlay: null };

  const t = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  switch (kind) {
    case "crossfade":
    case "dissolve":
      return { opacity: t, overlay: null };
    case "dip_to_black":
      /**
       * A dip goes THROUGH a colour: the first half fades the colour in, the second fades it out.
       * A single ramp would be a fade from black, which is a different edit.
       */
      return { opacity: 1, overlay: `rgba(0,0,0,${(1 - Math.abs(t * 2 - 1)).toFixed(4)})` };
    case "dip_to_white":
      return { opacity: 1, overlay: `rgba(255,255,255,${(1 - Math.abs(t * 2 - 1)).toFixed(4)})` };
    default:
      return null;
  }
}
