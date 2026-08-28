/**
 * RONDE 128 — a photograph is shown whole, centred, and for five seconds.
 *
 * ── What a still used to become ──────────────────────────────────────────────────────────────
 *
 * The image→video encoder built this filter chain, for a duration the beat asked for with no
 * upper bound:
 *
 *     scale=2150:1210:force_original_aspect_ratio=increase,   ← COVER: upscale past the frame
 *     crop=1920:1080:(iw-1920)/2:(ih-1080)/2,                 ← cut off whatever overflowed
 *     zoompan=z='min(zoom+…,1.2)':x='iw/2-(iw/zoom/2)-on*N'   ← zoom in, and pan sideways
 *
 * Three things at once, and all three are the opposite of what a documentary does with an
 * archive photograph: it enlarged the picture past the frame, cut the edges off, and then moved
 * across what was left — for as long as the narration ran, which in the measured render meant a
 * single image carrying tens of seconds.
 *
 * ── What it becomes ──────────────────────────────────────────────────────────────────────────
 *
 * Contained, centred, still, and short. The whole picture is inside the frame, in its own aspect
 * ratio, in the middle, and it is replaced after five seconds instead of being stretched.
 *
 * ── The tension this resolves, stated plainly ────────────────────────────────────────────────
 *
 * RONDE 111 required Ken Burns to keep moving, on the reasoning that a motionless picture reads
 * as a frozen frame. That reasoning was correct FOR AN UNBOUNDED DURATION: thirty seconds of a
 * motionless photograph is indistinguishable from a stuck render. It stops applying once a still
 * is capped at five seconds, which is a shot length, not a stall — and the cap is what makes the
 * motion unnecessary rather than the motion being what made the length bearable.
 *
 * The rule the two rounds share is unchanged: the viewer must never be looking at the same
 * unchanging thing for a long time. RONDE 111 achieved it by moving the picture. This achieves it
 * by changing the picture.
 */

/** The longest a single photograph may be on screen. */
export const MAX_STILL_IMAGE_DURATION_SEC = 5;

/** Below this a segment is not a shot, it is a flash — see planStillSegments. */
export const MIN_STILL_SEGMENT_SEC = 1.2;

/**
 * The cap, overridable without a deploy.
 *
 * Bounded at 15s: the point of this round is that a still is a shot rather than a slide, and an
 * override that removes the cap entirely would remove the round.
 */
export function stillImageMaxSec(): number {
  const raw = process.env.MAX_STILL_IMAGE_DURATION_SEC?.trim();
  if (!raw) return MAX_STILL_IMAGE_DURATION_SEC;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return MAX_STILL_IMAGE_DURATION_SEC;
  return Math.min(n, 15);
}

/**
 * Is Ken Burns allowed on an ordinary archive still?
 *
 * Off by default from this round. `ENABLE_STILL_KEN_BURNS=true` restores the previous behaviour
 * in one place, for one setting, so the change is reversible in production without a redeploy.
 */
export function stillKenBurnsEnabled(): boolean {
  return process.env.ENABLE_STILL_KEN_BURNS === "true";
}

/**
 * The filter that puts a whole picture in the middle of the frame.
 *
 * `decrease` rather than `increase` is the entire difference between contain and cover: it scales
 * the image until it FITS, never past it, so nothing is ever outside the frame and the crop that
 * used to follow has nothing to cut. `pad` then centres what is left over — the `(ow-iw)/2` and
 * `(oh-ih)/2` offsets are the centring, horizontal and vertical.
 *
 * `setsar=1` because a padded frame inherits the source's pixel aspect ratio otherwise, which is
 * how a correctly scaled image still ends up stretched on playback.
 */
export function containCenterFilter(params: {
  widthPx: number;
  heightPx: number;
  /** What fills the area around the picture. Default is the grade's own near-black. */
  backgroundColor?: string;
}): string {
  const { widthPx, heightPx } = params;
  const bg = params.backgroundColor ?? "0x111111";
  return (
    `scale=${widthPx}:${heightPx}:force_original_aspect_ratio=decrease,` +
    `pad=${widthPx}:${heightPx}:(ow-iw)/2:(oh-ih)/2:color=${bg},` +
    `setsar=1`
  );
}

export type StillSegment = {
  /** Index into the caller's image list. */
  imageIndex: number;
  durationSec: number;
};

/**
 * Split a stretch of narration across the images available for it.
 *
 * The rules, in order:
 *
 *  · no segment longer than the cap;
 *  · never the same image twice in a row — a repeat is the same picture standing still with a cut
 *    in the middle of it, which is the thing being removed;
 *  · images are used in order and then reused from the start, so a beat with two images alternates
 *    rather than exhausting one and holding it.
 *
 * Returns an empty list when it cannot be done honestly — no images, or so little material that
 * every segment would fall below MIN_STILL_SEGMENT_SEC. An empty plan is a coverage failure the
 * caller must report, NOT a licence to hold one frame for the whole stretch.
 */
export function planStillSegments(params: {
  totalSec: number;
  imageCount: number;
  maxSegmentSec?: number;
}): StillSegment[] {
  const { totalSec, imageCount } = params;
  const cap = params.maxSegmentSec ?? stillImageMaxSec();
  if (!(totalSec > 0) || imageCount < 1 || !(cap > 0)) return [];

  // One image and a stretch that fits: the simple case, and the common one.
  if (totalSec <= cap) return [{ imageIndex: 0, durationSec: totalSec }];

  const needed = Math.ceil(totalSec / cap);
  /**
   * With only one image there is no honest way to cover more than the cap: repeating it back to
   * back is the same picture held longer with a cut drawn in it. The caller has to find another
   * picture or report the gap.
   */
  if (imageCount < 2) return [];

  const segments: StillSegment[] = [];
  let remaining = totalSec;
  for (let i = 0; i < needed; i++) {
    const isLast = i === needed - 1;
    const dur = isLast ? remaining : cap;
    segments.push({ imageIndex: i % imageCount, durationSec: Number(dur.toFixed(3)) });
    remaining -= dur;
  }

  /**
   * A last segment shorter than a shot is folded into the one before it rather than shown as a
   * flash — and only when that leaves the previous segment within the cap plus the sliver.
   */
  const last = segments[segments.length - 1]!;
  if (segments.length > 1 && last.durationSec < MIN_STILL_SEGMENT_SEC) {
    const prev = segments[segments.length - 2]!;
    prev.durationSec = Number((prev.durationSec + last.durationSec).toFixed(3));
    segments.pop();
  }

  // Consecutive duplicates can only appear when imageCount is 1, which returned above — but the
  // invariant is asserted rather than assumed, because it is the whole point of the plan.
  for (let i = 1; i < segments.length; i++) {
    if (segments[i]!.imageIndex === segments[i - 1]!.imageIndex) return [];
  }
  return segments;
}

/** Does this plan honour the cap and the no-repeat rule? The invariant, as a function. */
export function stillPlanIsValid(segments: readonly StillSegment[], maxSegmentSec?: number): boolean {
  const cap = maxSegmentSec ?? stillImageMaxSec();
  if (segments.length === 0) return false;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.durationSec > cap + 0.01) return false;
    if (i > 0 && segments[i]!.imageIndex === segments[i - 1]!.imageIndex) return false;
  }
  return true;
}

/** One line, so a render can be read without reconstructing it. */
export function formatStillPlan(sceneIndex: number, beatIndex: number, totalSec: number, segments: readonly StillSegment[]): string {
  if (segments.length === 0) {
    return (
      `[StillPlan] s${sceneIndex}b${beatIndex} ${totalSec.toFixed(1)}s needs more than one image ` +
      `and only one is available — coverage gap, NOT a held frame`
    );
  }
  const parts = segments.map((s) => `img${s.imageIndex}:${s.durationSec.toFixed(1)}s`).join(" + ");
  return (
    `[StillPlan] s${sceneIndex}b${beatIndex} ${totalSec.toFixed(1)}s across ` +
    `${segments.length} still(s), max ${stillImageMaxSec().toFixed(1)}s each — ${parts}`
  );
}

/**
 * RONDE 152 — the gentle push that keeps a contained still from being a frozen frame.
 *
 * Eases from `STILL_DRIFT_ZOOM` back to 1.0 across the clip, so the LAST frame is exactly the
 * contained picture — whole, centred, uncropped, which is RONDE 128's rule. Everything before it
 * is the same picture very slightly larger, which for any image narrower than 16:9 is eating the
 * letterbox padding rather than the photograph.
 *
 * The amount is small on purpose. It only has to defeat `mpdecimate`, which is what the stillness
 * audit measures with: a picture that changes at all is not a held frame. Four percent over five
 * seconds is roughly 15 pixels of scale per second at 1080p — visible as life, not as a move.
 */
export const STILL_DRIFT_ZOOM = 1.04;

export function stillZoomOutExpr(totalFrames: number): string {
  const frames = Math.max(2, Math.round(totalFrames));
  const delta = (STILL_DRIFT_ZOOM - 1).toFixed(7);
  // Linear in `on`, clamped, so the final frame lands exactly on 1.0 however ffmpeg rounds the
  // frame count. A trailing fraction of a frame must not leave the picture slightly cropped.
  return `max(${STILL_DRIFT_ZOOM.toFixed(4)}-${delta}*on/${frames - 1},1.0)`;
}
