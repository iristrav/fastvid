/** Professional Render Engine — Clip Renderer (Phase 7).
 *
 *  Turns a ClipInstruction (already decided upstream — which candidate asset, which portion of
 *  it, which slot on the beat's timeline — this file makes no footage-selection decisions of
 *  its own) into the trim/scale/pad filter fragments that prepare one clip for compositing.
 *
 *  Reuses two proven production templates directly (confirmed by this phase's research):
 *    - `trim=start=X:duration=Y,setpts=PTS-STARTPTS` — the exact video-trim template
 *      videoPipeline.ts's montage clip-prep chain uses (`start`+`duration` form, not
 *      `start`+`end`, so the effective clip length matches exactly what was requested even if
 *      `trimEndSec` were ever inconsistent with duration elsewhere).
 *    - aspectRatio.ts's `buildAspectRatioFilter()` (this phase's own generalization of the
 *      legacy `SCALE_PAD_VF`/`CROP_FILL_VF` templates) for aspect-ratio-aware scale/pad-or-crop.
 *
 *  Still images skip the trim filter entirely — a still's on-screen duration is enforced by
 *  the encoder's own `-loop 1 -i image.png` INPUT flag (confirmed by research: every still
 *  render site in this codebase uses that input-level loop, never a video `trim` filter, since
 *  a static image has no timeline of its own to trim from) — that's an encoder-level concern
 *  (encoder.ts, task #118), not a filter-graph one, so this renderer only emits the aspect
 *  ratio filter for images.
 */
import { buildAspectRatioFilter } from "./aspectRatio";
import type { AspectRatioName, ClipInstruction, Dimensions, FilterFragment } from "./types";

/** Builds this clip's trim (video only) + aspect-ratio-aware scale/pad-or-crop fragments. */
export function renderClip(
  clip: ClipInstruction,
  targetAspect: AspectRatioName,
  sourceDims: Dimensions | null
): FilterFragment[] {
  const fragments: FilterFragment[] = [];
  const reason = `clip ${clip.candidateId} (${clip.timingSource})`;

  if (clip.assetType === "video") {
    const durationSec = Math.max(0, clip.trimEndSec - clip.trimStartSec);
    fragments.push({
      filter: `trim=start=${Math.max(0, clip.trimStartSec).toFixed(3)}:duration=${durationSec.toFixed(3)},setpts=PTS-STARTPTS`,
      reason,
    });
  }

  fragments.push({ filter: buildAspectRatioFilter(sourceDims, targetAspect), reason });

  return fragments;
}

/** This beat's on-timeline duration — the frame-accurate span the clip (after camera/caption/
 *  effect fragments are layered on top) must occupy, independent of the source asset's own
 *  trim length. Word-alignment-sourced timing (`timingSource: "tts_word_alignment"`) and
 *  proportional-estimate timing both already resolve to concrete startSec/endSec by the time
 *  this EDL instruction exists — this function doesn't distinguish between them, it just reads
 *  the resolved span. */
export function clipTimelineDurationSec(clip: ClipInstruction): number {
  return Math.max(0, clip.endSec - clip.startSec);
}
