/**
 * RONDE 111 — how a scene that is short of footage may be filled, and how it may not.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────────────────────
 *
 * RONDE 26 filled a montage that was shorter than its own voice track by holding the last frame.
 * RONDE 85 measured what that costs (render 536: one 10.6-second frozen frame, 30 frozen segments
 * in the final file) and replaced it with slowing the montage down instead — deliberately with no
 * cap, on the reasoning that a cap would leave a remainder and the only things that could fill a
 * remainder were the two that round existed to remove.
 *
 * That reasoning was right about the remainder and wrong about the cure. Measured against real
 * ffmpeg, on footage that actually moves:
 *
 *     ratio  1.5x  →  each picture stands still for 0.10s
 *     ratio  3.0x  →  0.18s
 *     ratio  6.0x  →  0.32s
 *     ratio 10.0x  →  0.59s      ← under two new pictures per second
 *
 * There is no interpolation in the chain: `setpts` spreads the timeline and `fps=25` fills the
 * space by repeating frames. So past about 2x the result is not slow motion, it is a slideshow of
 * held frames — the exact thing RONDE 85 set out to remove, arriving through a different filter.
 * And the render's own QA never saw it: freezedetect needs 2.5 seconds of stillness, and a 0.6s
 * hold never reaches that.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────────────────────
 *
 * Slowing is a finishing touch, not a source of footage. It may absorb a small shortfall and
 * nothing more. Everything past that must be answered with real pictures — found by the same beat
 * → search-query → vision-relevance chain that every other clip goes through — and a held frame
 * is what happens when the pipeline has genuinely run out of ways to show something, not a
 * routine filler.
 *
 * This module is only the arithmetic of that rule. It knows nothing about ffmpeg, providers or
 * relevance, so both the compose step and the coverage backfill can ask it the same question and
 * get the same answer.
 */

/**
 * The most a montage may be slowed to cover its own scene.
 *
 * 2x holds each picture about 0.13s at 25fps — a slow-motion look, still motion. It is the point
 * measured above where "slowed footage" stops being a fair description of what the viewer sees.
 */
export const MAX_COVERAGE_SLOWDOWN = 2;

/**
 * Shortest source clip that can still be stitched into a montage.
 *
 * Distinct from the STANDALONE floor (VIDRUSH_MIN_SOURCE_VIDEO_SEC, 2.8s), which asks a different
 * question: "is this long enough to carry a beat on its own". A clip that will be concatenated
 * between two others does not have to carry anything alone, and refusing it there threw away
 * on-topic footage while the same scene was being padded with slowed frames. Render 536 refused
 * 594 clips this way in one video.
 *
 * Below this a clip is a flash frame rather than a shot: it cannot survive an xfade, and it reads
 * as a glitch rather than as an edit. That is the part of the old floor that is technical, and it
 * stays.
 */
export const MIN_STITCHABLE_SOURCE_SEC = 1.2;

/**
 * How long a source clip must be to be worth trimming for a `requestedSec` slot.
 *
 * Two ideas that used to be one number:
 *
 *   · never demand more source than the slot will actually use. Asking for 1.5 seconds of filler
 *     and refusing a 2.2-second clip for being "too short" is the blockage, not the safeguard.
 *   · never accept something too short to be an edit at all.
 *
 * `standaloneFloor` still applies whenever the slot is long enough to want it, so the ordinary
 * beat path is unchanged: a beat asking for five seconds still refuses a 2.2-second source.
 */
export function stitchSourceFloorSec(requestedSec: number, standaloneFloor: number): number {
  const wanted = Number.isFinite(requestedSec) && requestedSec > 0 ? requestedSec : standaloneFloor;
  return Math.max(MIN_STITCHABLE_SOURCE_SEC, Math.min(standaloneFloor, wanted));
}
