/**
 * VIDEO 663 — ONE LINE PER FILM: WOULD A VIEWER CALL THIS PROFESSIONAL?
 *
 * The owner: "Waardoor het echt een professionele video wordt." Until now that question was answered
 * by reading a render's logs line by line: held frames (`[ShotFreeze]`, `[ShotHold]`), fallback
 * scenes, repeats, long texts, pictures nobody approved. This counts what the viewer sees in the
 * made film, from the timeline it was rendered from and the renderer's own measurement of held
 * frames, and says it in one line. It decides nothing: a film is delivered whatever it says.
 *
 *   still       seconds of a held last frame (the renderer measured each segment)
 *   fallback    fallback scenes (the drawn colour field with words), count and seconds
 *   repeated    seconds of footage shown twice (same asset, overlapping source seconds)
 *   jumpCuts    two shots in a row from one source that jump inside it (back, or seconds ahead)
 *   longText    texts in the picture of more than two words (`onScreenWords`)
 *   unapproved  pictures on screen the picture editor did not approve for their sentence
 *
 * "professional" only when held frames stay under `STILL_SHARE_LIMIT` of the film and every other
 * count is zero.
 *
 * VIDEO 663 (R2) — and the made file itself, measured (`measuredPicture`): seconds where the picture
 * stands still, hardly moves, or comes back. Any of those makes it NOT_YET; a file that could not be
 * measured says so on the line.
 */
import { isFallbackSceneClip } from "./fallbackScene";
import { footageKey, OVERLAP_TOLERANCE_SEC, sourceWindow } from "./noRepeatedFootage";
import { MAX_ON_SCREEN_WORDS, wordCount } from "./onScreenWords";
import type { PictureMeasurement } from "./measuredPicture";
import type { ProjectTimeline, TimelineVideoClip } from "./projectTimeline";

/** VIDEO 663 (R2) — how far the next shot of the same source may start before / after where the last ended. */
export const JUMP_BACK_SEC = 0.1;
export const JUMP_AHEAD_SEC = 0.6;
/** Held frames above this share of the film are named a problem (a frame or two at a cut is not). */
export const STILL_SHARE_LIMIT = 0.03;

export type ViewerReport = {
  filmSec: number;
  stillSec: number;
  fallbackScenes: number;
  fallbackSec: number;
  repeatedSec: number;
  /** VIDEO 663 (R2) — two shots in a row from one source that jump inside it: "steeds hetzelfde beeld terug" */
  jumpCuts: string[];
  longTexts: string[];
  unapproved: string[];
  /** VIDEO 663 (R2) — the made file, measured; null when it could not be read, absent when not asked */
  measured?: PictureMeasurement | null;
  problems: string[];
  professional: boolean;
};

const APPROVED = new Set(["judge_fit", "judge_acceptable", "generic_footage", "ai_generated"]);
/** The invisible ground under a sentence's card shows no footage of its own. */
const isCardGround = (c: TimelineVideoClip) => /_graphic\d+(_p\d+)?$/.test(c.id);

export function viewerReport(
  timeline: ProjectTimeline,
  heldFrames: ReadonlyArray<{ clipId: string; sec: number }> = [],
  measured?: PictureMeasurement | null
): ViewerReport {
  const filmSec = Math.max(0, timeline.durationSec);
  const clips = timeline.tracks
    .flatMap((t) => (t.kind === "VIDEO" ? t.clips : []))
    .filter((c) => !c.disabled)
    .sort((a, b) => a.timelineStart - b.timelineStart);
  const slot = (c: TimelineVideoClip) => Math.max(0, c.timelineEnd - c.timelineStart);

  const fallback = clips.filter((c) => isFallbackSceneClip(c));
  const fallbackSec = fallback.reduce((s, c) => s + slot(c), 0);
  const fallbackIds = new Set(fallback.map((c) => c.id));
  /** a fallback scene is a drawn field, not a frozen picture: its seconds are counted once, there */
  const stillSec = heldFrames.filter((h) => !fallbackIds.has(h.clipId)).reduce((s, h) => s + h.sec, 0);

  let repeatedSec = 0;
  const seen = new Map<string, Array<[number, number]>>();
  for (const c of clips) {
    if (c.kind === "image" || isCardGround(c) || fallbackIds.has(c.id)) continue;
    const key = footageKey(c);
    if (!key) continue;
    const w = sourceWindow(c);
    for (const prior of seen.get(key) ?? []) {
      const overlap = Math.min(w[1], prior[1]) - Math.max(w[0], prior[0]);
      if (overlap > OVERLAP_TOLERANCE_SEC) repeatedSec += overlap / (c.speed ?? 1);
    }
    seen.set(key, [...(seen.get(key) ?? []), w]);
  }

  /**
   * VIDEO 663 (R2) — a jump inside one source: the next shot is the same footage, but starts back
   * before where the last one ended, or seconds after it. Stepping over one cut in the source (its
   * margins) is not a jump; more is.
   */
  const jumpCuts: string[] = [];
  for (let i = 1; i < clips.length; i++) {
    const a = clips[i - 1]!;
    const b = clips[i]!;
    if (a.kind === "image" || b.kind === "image" || isCardGround(a) || isCardGround(b)) continue;
    if (Math.abs(b.timelineStart - a.timelineEnd) > 0.05) continue;
    const key = footageKey(a);
    if (!key || footageKey(b) !== key) continue;
    const [aFrom, ended] = sourceWindow(a);
    const [starts, bTo] = sourceWindow(b);
    /** overlapping seconds are counted once, above, as footage shown twice */
    if (Math.min(ended, bTo) - Math.max(aFrom, starts) > OVERLAP_TOLERANCE_SEC) continue;
    if (starts < ended - JUMP_BACK_SEC || starts > ended + JUMP_AHEAD_SEC) {
      jumpCuts.push(`${a.id}→${b.id} (${ended.toFixed(1)}s → ${starts.toFixed(1)}s)`);
    }
  }

  const longTexts: string[] = [];
  for (const t of timeline.tracks) {
    if (t.kind === "TEXT") {
      for (const x of t.texts ?? []) if (!x.disabled && wordCount(x.text) > MAX_ON_SCREEN_WORDS) longTexts.push(x.text.replace(/\n/g, " / "));
    } else if (t.kind === "GRAPHICS") {
      for (const g of t.graphics ?? []) {
        if (g.disabled || !g.label || g.data?.titleHidden === true) continue;
        if (/chart|counter|statistic|map|route|point|shape|icon|progress|ring|highlight/.test(g.graphicType)) continue;
        if (wordCount(g.label) > MAX_ON_SCREEN_WORDS) longTexts.push(g.label);
      }
    }
  }

  const unapproved = clips
    .filter((c) => !isCardGround(c) && !fallbackIds.has(c.id) && !APPROVED.has(c.source?.contentApproval ?? "unverified"))
    .map((c) => c.id);

  const problems: string[] = [];
  if (filmSec > 0 && stillSec / filmSec > STILL_SHARE_LIMIT) problems.push(`${stillSec.toFixed(1)}s held frame (${((stillSec / filmSec) * 100).toFixed(0)}%)`);
  if (fallback.length) problems.push(`${fallback.length} fallback scene(s), ${fallbackSec.toFixed(1)}s`);
  if (repeatedSec > OVERLAP_TOLERANCE_SEC) problems.push(`${repeatedSec.toFixed(1)}s footage shown twice`);
  if (jumpCuts.length) problems.push(`${jumpCuts.length} jump(s) inside one source: ${jumpCuts.slice(0, 3).join(", ")}`);
  if (longTexts.length) problems.push(`${longTexts.length} text(s) over ${MAX_ON_SCREEN_WORDS} words`);
  if (unapproved.length) problems.push(`${unapproved.length} picture(s) not approved for their sentence`);
  const at = (xs: ReadonlyArray<{ fromSec: number; toSec: number }>) => xs.slice(0, 4).map((x) => `${x.fromSec.toFixed(1)}–${x.toSec.toFixed(1)}s`).join(", ");
  if (measured) {
    if (measured.stillSec > 0) problems.push(`measured: ${measured.stillSec.toFixed(1)}s the picture stands still (${at(measured.still)})`);
    if (measured.slowSec > 0) problems.push(`measured: ${measured.slowSec.toFixed(1)}s the picture hardly moves (${at(measured.slow)})`);
    if (measured.repeatSec > 0) {
      problems.push(
        `measured: ${measured.repeatSec.toFixed(1)}s a picture comes back (` +
          measured.repeats.slice(0, 4).map((r) => `${r.fromSec.toFixed(1)}s, first at ${r.firstSeenSec.toFixed(1)}s`).join("; ") + ")"
      );
    }
  }
  return {
    filmSec,
    stillSec: Number(stillSec.toFixed(2)),
    fallbackScenes: fallback.length,
    fallbackSec: Number(fallbackSec.toFixed(2)),
    repeatedSec: Number(repeatedSec.toFixed(2)),
    jumpCuts,
    longTexts,
    unapproved,
    ...(measured !== undefined ? { measured } : {}),
    problems,
    professional: problems.length === 0,
  };
}

export function formatViewerReport(videoId: number | string, r: ViewerReport): string {
  return (
    `[ViewerReport] video=${videoId} film=${r.filmSec.toFixed(1)}s stillSec=${r.stillSec.toFixed(1)} ` +
    `(${r.filmSec > 0 ? ((r.stillSec / r.filmSec) * 100).toFixed(1) : "0.0"}%) fallbackScenes=${r.fallbackScenes} (${r.fallbackSec.toFixed(1)}s) ` +
    `repeatedSec=${r.repeatedSec.toFixed(1)} jumpCuts=${r.jumpCuts.length} longTexts=${r.longTexts.length} unapproved=${r.unapproved.length} ` +
    (r.measured === undefined
      ? ""
      : r.measured === null
        ? "measured=UNREADABLE "
        : `measured=still ${r.measured.stillSec.toFixed(1)}s slow ${r.measured.slowSec.toFixed(1)}s repeat ${r.measured.repeatSec.toFixed(1)}s `) +
    `verdict=${r.professional ? "PROFESSIONAL" : `NOT_YET — ${r.problems.join("; ")}`}`
  );
}
