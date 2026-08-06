/** Professional Render Engine — Aspect Ratio / Output Format (Phase 7).
 *
 *  Generalizes the legacy pipeline's `SCALE_PAD_VF`/`CROP_FILL_VF` filter templates
 *  (videoPipeline.ts, hardcoded to 1920x1080 — confirmed by this phase's research to be the
 *  ONLY output dimensions the live pipeline produces today) to accept any target aspect
 *  ratio, so 16:9/9:16/1:1 output is a real, parameterized code path instead of three copies
 *  of a hardcoded constant.
 *
 *  "Automatic intelligent cropping" is honestly scoped as an aspect-ratio-mismatch heuristic
 *  (crop-fill when the source's own aspect ratio is already close to the target, pad-fit when
 *  it's far off enough that cropping would likely cut off the subject) — not content-aware or
 *  face-aware cropping. No such model exists anywhere in this codebase (confirmed by
 *  research), and simulating one without ever validating it against real footage in this
 *  sandbox would be dishonest scope creep; this is a plain, defensible geometric rule,
 *  documented as such.
 */
import type { AspectRatioName, Dimensions } from "./types";

const DIMENSIONS: Record<AspectRatioName, Dimensions> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

export function dimensionsFor(aspectRatio: AspectRatioName): Dimensions {
  return DIMENSIONS[aspectRatio];
}

export type CropMode = "fit" | "fill";

/** Fit: scale down to bounds, pad the remainder — never crops, may add bars. Direct
 *  generalization of the legacy SCALE_PAD_VF template. */
export function buildScalePadFilter(dims: Dimensions, padColor = "0x2a2a2a"): string {
  return `scale=${dims.width}:${dims.height}:force_original_aspect_ratio=decrease,pad=${dims.width}:${dims.height}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`;
}

/** Fill: scale up to cover, crop the excess — never adds bars, always fills the frame. Direct
 *  generalization of the legacy CROP_FILL_VF template. */
export function buildScaleCropFilter(dims: Dimensions): string {
  return `scale=${dims.width}:${dims.height}:force_original_aspect_ratio=increase,crop=${dims.width}:${dims.height}:(iw-${dims.width})/2:(ih-${dims.height})/2`;
}

/** How far source and target aspect ratios can diverge before cropping risks cutting off the
 *  subject — beyond this, fit (pad) is the safer default. */
const MISMATCH_THRESHOLD = 0.35;

export function chooseCropMode(sourceDims: Dimensions, targetAspect: AspectRatioName): CropMode {
  const target = dimensionsFor(targetAspect);
  const sourceRatio = sourceDims.width / sourceDims.height;
  const targetRatio = target.width / target.height;
  const mismatch = Math.abs(sourceRatio - targetRatio) / targetRatio;
  return mismatch > MISMATCH_THRESHOLD ? "fit" : "fill";
}

/** Builds the scale/pad-or-crop filter for one clip's source dimensions targeting one output
 *  aspect ratio. Unknown source dimensions (candidate width/height not populated) always fall
 *  back to fit — cropping without knowing the source's own shape risks cutting off content
 *  blind, so "unknown" defaults to the non-destructive option. */
export function buildAspectRatioFilter(sourceDims: Dimensions | null, targetAspect: AspectRatioName): string {
  const dims = dimensionsFor(targetAspect);
  if (!sourceDims || sourceDims.width <= 0 || sourceDims.height <= 0) {
    return buildScalePadFilter(dims);
  }
  const mode = chooseCropMode(sourceDims, targetAspect);
  return mode === "fill" ? buildScaleCropFilter(dims) : buildScalePadFilter(dims);
}
