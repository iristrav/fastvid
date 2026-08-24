/**
 * RONDE 59 — which part of a long video do we actually use?
 *
 * Render 531 downloaded 41 clips. Seventeen of them were longer than a minute; the longest was
 * 272 seconds and was fetched eight times. Every one of them was trimmed like this:
 *
 *     trimDownloadedStockClip(rawPath, outPath, holdSec, sourceDur, label)
 *                                                                   ^ no start offset
 *
 * which means `ss = 0`. From a four-and-a-half minute archive documentary the pipeline took the
 * first 3.5 seconds — one and a third percent of it, and for archive material that opening is
 * almost always a title card, a leader, a countdown or a credit roll. The substance starts after
 * it.
 *
 * That is a large part of why the pictures did not match the words: not because the wrong VIDEO
 * was chosen, but because the wrong SECOND of the right video was.
 *
 * It also poisoned everything downstream. The CLIP score, the vision gate, the beat-image
 * judgement — all of them were looking at title cards and leaders, which is exactly the kind of
 * flat, low-contrast, text-heavy frame that produces the narrow uninformative similarity band
 * (0.19–0.25 for everything) measured in that render.
 *
 * This module decides where to cut instead. It is deliberately deterministic and free: no
 * probing, no model, no extra ffmpeg pass. A short source still starts at zero — there is
 * nothing to choose. A long one skips its opening and spreads consecutive beats across the rest,
 * so a scene reusing the same source twice does not get the same 3.5 seconds twice.
 */

/** Fraction of a long source assumed to be titles/leader before the content starts. */
const LEADER_FRACTION = 0.12;
/** Never skip less than this on a source long enough to have an opening at all. */
const MIN_LEADER_SEC = 2;
/** Never skip more than this — a long documentary's content starts well before the 30s mark. */
const MAX_LEADER_SEC = 30;
/** Below this much slack there is nothing meaningful to choose, so start at zero as before. */
const MIN_SLACK_SEC = 1.5;

export function beatSegmentChoiceEnabled(): boolean {
  return process.env.ENABLE_BEAT_SEGMENT_CHOICE !== "false";
}

/**
 * Where to start the trim, in seconds.
 *
 * `index` spreads consecutive uses of the same source: beat 0 takes the first usable segment,
 * beat 1 the next, and so on, wrapping when the source runs out. Deterministic, so the same beat
 * of the same render always makes the same choice and a re-run is reproducible.
 */
export function pickBeatSegmentStartSec(
  sourceDurationSec: number,
  takeSec: number,
  index = 0
): number {
  if (!beatSegmentChoiceEnabled()) return 0;
  if (!Number.isFinite(sourceDurationSec) || !Number.isFinite(takeSec)) return 0;
  if (sourceDurationSec <= 0 || takeSec <= 0) return 0;

  // Everything the clip could possibly use, before any opening is skipped.
  const fullSlack = sourceDurationSec - takeSec;
  if (fullSlack < MIN_SLACK_SEC) return 0;

  const leader = Math.min(MAX_LEADER_SEC, Math.max(MIN_LEADER_SEC, sourceDurationSec * LEADER_FRACTION));
  // The leader is only worth skipping when doing so still leaves something to choose from —
  // on a 10-second clip a 30-second skip would be nonsense, and on a 12-second one a 2-second
  // skip is fine.
  const usableStart = leader + takeSec <= sourceDurationSec - MIN_SLACK_SEC ? leader : 0;
  const slack = sourceDurationSec - takeSec - usableStart;
  if (slack < MIN_SLACK_SEC) return Math.max(0, Math.min(usableStart, fullSlack));

  // Spread across the remaining span. The golden-ratio step keeps consecutive indices far apart
  // instead of walking forward in small steps, so two beats from one source look different.
  const step = 0.61803398875;
  const offsetFraction = (index * step) % 1;
  const start = usableStart + offsetFraction * slack;
  return Math.max(0, Math.min(start, fullSlack));
}

/** Opening of a long video assumed to be intro/branding before the content starts. */
const LONG_HEAD_FRACTION = 0.1;
const LONG_HEAD_MIN_SEC = 4;
const LONG_HEAD_MAX_SEC = 90;
/** Tail assumed to be outro, credits or an end card. */
const LONG_TAIL_FRACTION = 0.05;
const LONG_TAIL_MAX_SEC = 60;

/** Stable, well-spread [0,1) from a string. FNV-1a — no dependency, no collisions that matter. */
function seedFraction(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100_000) / 100_000;
}

/**
 * RONDE 60 — where to start in a long video nothing has told us anything about.
 *
 * This is the LAST resort on the YouTube path, used only when the transcript could not locate
 * the subject. It cannot know where the right moment is; what it can know is where the right
 * moment is NOT. In render 531 every YouTube clip started at second 8 or second 12, whether the
 * video ran four minutes or forty — which on YouTube is reliably the channel leader, the host
 * introducing themselves, and the subscribe card.
 *
 * So: skip the opening, skip the outro, and place the cut somewhere in the body, chosen from a
 * hash of the video id so two different videos do not both land on the same fraction and a
 * re-run of the same render is reproducible.
 */
export function pickLongVideoStartSec(
  sourceDurationSec: number,
  takeSec: number,
  seed: string
): number {
  if (!beatSegmentChoiceEnabled()) return 0;
  if (!Number.isFinite(sourceDurationSec) || !Number.isFinite(takeSec)) return 0;
  if (sourceDurationSec <= 0 || takeSec <= 0) return 0;

  const fullSlack = sourceDurationSec - takeSec;
  if (fullSlack < MIN_SLACK_SEC) return 0;

  const head = Math.min(
    LONG_HEAD_MAX_SEC,
    Math.max(LONG_HEAD_MIN_SEC, sourceDurationSec * LONG_HEAD_FRACTION)
  );
  const tail = Math.min(LONG_TAIL_MAX_SEC, sourceDurationSec * LONG_TAIL_FRACTION);
  // On a video too short to carry both, fall back to the plain leader skip rather than to zero.
  const span = sourceDurationSec - takeSec - head - tail;
  if (span < MIN_SLACK_SEC) return pickBeatSegmentStartSec(sourceDurationSec, takeSec, 0);

  return Math.max(0, Math.min(head + seedFraction(seed) * span, fullSlack));
}

/**
 * The fractions of a trimmed clip to sample when judging what it shows.
 *
 * One frame is not a clip. Even a 3.5-second cut can contain a shot change, and the frame that
 * happens to sit at 45% is not necessarily representative of what a viewer sees. Sampling across
 * the clip means a judgement covers the whole of what will be on screen, not one instant of it.
 */
export const JUDGEMENT_FRAME_FRACTIONS = [0.2, 0.5, 0.8] as const;
