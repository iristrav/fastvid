/**
 * Post-generation validation for each adopted montage clip — metadata + Vidrush layout rules.
 */
import * as path from "path";
import { PIPELINE_ERROR, pipelineError } from "@shared/appErrors";
// RONDE 242: `extractMotionOverlayCandidates` and `MotionOverlayPlan` are gone with the check that
// called the extractor only to discard its answer. Only the constant this module returns is left.
import { STANDARD_TRANSITION } from "./motionGraphicsLayer";
import type { ScriptVisualIntentEntry } from "./scriptVisualKeywords";

export const STANDARD_OVERLAY_POSITION = "center" as const;

export type GeneratedClipPlanCheck = {
  sceneIndex: number;
  beatIndex: number;
  clipBasename: string;
  visual_description: string;
  keywords: string[];
  image_prompt: string;
  transition: typeof STANDARD_TRANSITION;
  overlay_position: typeof STANDARD_OVERLAY_POSITION;
};

export type GeneratedClipPlanInput = {
  sceneIndex: number;
  beatIndex: number;
  clipPath: string;
  visualDescription?: string;
  visualIntent?: ScriptVisualIntentEntry;
  keywords?: string[];
  searchQuery?: string;
  beatText?: string;
  powerWord?: string;
  highlightWords?: string[];
};

function resolveVisualDescription(input: GeneratedClipPlanInput): string {
  return (
    input.visualDescription?.trim() ||
    input.visualIntent?.visual_description?.trim() ||
    input.visualIntent?.visual_intent?.trim() ||
    ""
  );
}

function resolveImagePrompt(input: GeneratedClipPlanInput): string {
  return (
    input.searchQuery?.trim() ||
    input.visualIntent?.search_query?.trim() ||
    input.visualIntent?.primary_keyword?.trim() ||
    ""
  );
}

function resolveKeywords(input: GeneratedClipPlanInput): string[] {
  return Array.from(
    new Set((input.keywords ?? []).map((k) => k.trim()).filter((k) => k.length >= 2))
  );
}

/**
 * Validate clip metadata; throws pipelineError and logs on failure.
 *
 * ── RONDE 242 — THREE OF THE FIVE CHECKS COULD NOT FAIL ─────────────────────────────────────
 *
 * What stood here:
 *
 *     const transition = STANDARD_TRANSITION;
 *     if (transition !== "crossfade") errors.push(…);          // STANDARD_TRANSITION IS "crossfade"
 *
 *     const overlay_position = STANDARD_OVERLAY_POSITION;
 *     if (overlay_position !== "center") errors.push(…);       // …and that one IS "center"
 *
 *     const overlayPlans = extractMotionOverlayCandidates(…).map(() => ({ position: overlay_position }));
 *     for (const overlay of overlayPlans)
 *       if (overlay.position !== "center") errors.push(…);     // …every element set FROM that constant
 *
 * Each compares a constant with its own definition. Not "rarely fails" — cannot fail, and the
 * compiler knows: both are `as const`, and `MotionOverlayPlan.position` is typed `"center"`, a
 * literal with exactly one inhabitant. The third is the worst of the three, because it reads as a
 * check over real overlay data: it calls the extractor, throws the answer away with
 * `.map(() => ({ position: overlay_position }))`, and validates the constant it just substituted.
 *
 * A check that cannot fail is worse than no check. It costs a call, it appears in the success line
 * as though something was verified, and it spends the reader's trust on nothing — which is exactly
 * how the real gaps in this pipeline kept surviving review.
 *
 * The three REAL checks are kept, unchanged: a clip must carry a visual description, at least one
 * keyword, and an image prompt. Those can fail, and do.
 *
 * The constants are still exported and still returned in the result — callers read them, and the
 * shape of `GeneratedClipPlanCheck` is unchanged. What is gone is pretending they were checked.
 *
 * The thrown code was `NO_SCENES` (10106), which says the script produced no scenes. It produced
 * scenes; one clip's metadata was incomplete. A render that failed here sent its reader to the
 * wrong end of the pipeline, so it now throws `QUALITY_GATE` (10115) — what this function is.
 */
export function validateGeneratedClipPlan(input: GeneratedClipPlanInput): GeneratedClipPlanCheck {
  const errors: string[] = [];
  const clipBasename = path.basename(input.clipPath);

  const visual_description = resolveVisualDescription(input);
  if (!visual_description) errors.push("missing visual_description");

  const keywords = resolveKeywords(input);
  if (keywords.length < 1) errors.push("missing keywords (need at least 1)");

  const image_prompt = resolveImagePrompt(input);
  if (!image_prompt) errors.push("missing image_prompt");

  if (errors.length > 0) {
    const msg =
      `Scene ${input.sceneIndex} beat ${input.beatIndex} clip "${clipBasename}": ${errors.join("; ")}`;
    console.error(`[ClipValidation] FAIL — ${msg}`);
    throw pipelineError(PIPELINE_ERROR.QUALITY_GATE, msg);
  }

  /** Says what was actually checked. The transition and overlay position are constants, not findings. */
  console.log(
    `[ClipValidation] OK scene ${input.sceneIndex} beat ${input.beatIndex} "${clipBasename}" ` +
      `(visual_description present, ${keywords.length} keyword(s), image_prompt present)`
  );

  return {
    sceneIndex: input.sceneIndex,
    beatIndex: input.beatIndex,
    clipBasename,
    visual_description,
    keywords,
    image_prompt,
    /** Constants, returned because callers read them — never checked, because they cannot vary. */
    transition: STANDARD_TRANSITION,
    overlay_position: STANDARD_OVERLAY_POSITION,
  };
}
