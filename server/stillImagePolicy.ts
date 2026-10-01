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

