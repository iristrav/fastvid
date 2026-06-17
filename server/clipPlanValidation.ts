/**
 * Post-generation validation for each adopted montage clip — metadata + Vidrush layout rules.
 */
import * as path from "path";
import { PIPELINE_ERROR, pipelineError } from "@shared/appErrors";
import {
  STANDARD_TRANSITION,
  extractMotionOverlayCandidates,
  type MotionOverlayPlan,
} from "./motionGraphicsLayer";
import type { ScriptVisualIntentEntry } from "./scriptVisualKeywords";

export const STANDARD_OVERLAY_POSITION = "bottom_left" as const;

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

/** Validate clip metadata; throws pipelineError and logs on failure. */
export function validateGeneratedClipPlan(input: GeneratedClipPlanInput): GeneratedClipPlanCheck {
  const errors: string[] = [];
  const clipBasename = path.basename(input.clipPath);

  const visual_description = resolveVisualDescription(input);
  if (!visual_description) errors.push("missing visual_description");

  const keywords = resolveKeywords(input);
  if (keywords.length < 1) errors.push("missing keywords (need at least 1)");

  const image_prompt = resolveImagePrompt(input);
  if (!image_prompt) errors.push("missing image_prompt");

  const transition = STANDARD_TRANSITION;
  if (transition !== "crossfade") errors.push(`invalid transition: ${transition} (expected crossfade)`);

  const overlay_position = STANDARD_OVERLAY_POSITION;
  if (overlay_position !== "bottom_left") {
    errors.push(`invalid overlay position: ${overlay_position} (expected bottom_left)`);
  }

  const beatText = input.beatText?.trim() ?? "";
  if (beatText) {
    const overlayPlans: Pick<MotionOverlayPlan, "position">[] = extractMotionOverlayCandidates(
      beatText,
      {
        text: beatText,
        powerWord: input.powerWord,
        highlightWords: input.highlightWords,
      }
    ).map(() => ({ position: overlay_position }));
    for (const overlay of overlayPlans) {
      if (overlay.position !== "bottom_left") {
        errors.push(`overlay position must be bottom_left (got ${overlay.position})`);
      }
    }
  }

  if (errors.length > 0) {
    const msg =
      `Scene ${input.sceneIndex} beat ${input.beatIndex} clip "${clipBasename}": ${errors.join("; ")}`;
    console.error(`[ClipValidation] FAIL — ${msg}`);
    throw pipelineError(PIPELINE_ERROR.NO_SCENES, msg);
  }

  console.log(
    `[ClipValidation] OK scene ${input.sceneIndex} beat ${input.beatIndex} "${clipBasename}" ` +
      `(visual_description present, ${keywords.length} keyword(s), image_prompt present, crossfade, bottom_left)`
  );

  return {
    sceneIndex: input.sceneIndex,
    beatIndex: input.beatIndex,
    clipBasename,
    visual_description,
    keywords,
    image_prompt,
    transition,
    overlay_position,
  };
}
