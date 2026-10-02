/**
 * OCTOBER 2026 — THE MOMENT OF A YOUTUBE VIDEO IS CHOSEN BY THE PICTURE EDITOR, NOT BY A HASH.
 *
 * ── What went wrong ──────────────────────────────────────────────────────────────────────────
 *
 * A beat that took a YouTube video got exactly one window of it: `pickLongVideoStartSec` hashed
 * the video id into a start second, the beat downloaded those few seconds, and the picture editor
 * could only say yes or no to that one window. A video that is right for the sentence was lost
 * whenever the hash landed on an intro card, a presenter or a cutaway — and when it said yes, it
 * said yes to whatever the hash happened to pick.
 *
 * ── What this does ───────────────────────────────────────────────────────────────────────────
 *
 * A short section of the video is fetched (one download, one slot), cut where the picture
 * changes, and up to `youtubeMomentsPerVideo()` single shots of it go to the beat as separate
 * candidates. The existing picture editor looks at each of them against the beat's exact sentence
 * and only the shot it approves is used. Nothing here judges a picture; it only decides which
 * shots are put in front of the one judge.
 *
 * A start the script located in the transcript is honoured as before: that is one moment, found.
 */
import * as fs from "fs";
import * as path from "path";

import { cutLocalVideoIntoShots, type LocalShotCutter } from "./archiveShotPieces";

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** How many moments of one YouTube video a beat's picture editor is shown (3–5 asked; 3 by default). */
export function youtubeMomentsPerVideo(): number {
  return envInt("YOUTUBE_MOMENTS_PER_VIDEO", 3, 1, 5);
}

/** The most the download service fetches in one section. */
export const MAX_MOMENT_SPAN_SEC = 120;

/**
 * How many seconds of the video are fetched to find those moments: long enough to hold several
 * shots, never past the video's end, never more than the service fetches in one section.
 */
export function youtubeMomentSpanSec(clipDurSec: number, sourceDurationSec: number): number {
  const wanted = envInt("YOUTUBE_MOMENT_SPAN_SEC", 20, 5, MAX_MOMENT_SPAN_SEC);
  const span = Math.max(clipDurSec, wanted);
  return sourceDurationSec > 0 ? Math.min(span, sourceDurationSec) : span;
}

/** Where the section starts: centred on the planned window, kept inside the video. */
export function youtubeMomentSpanStartSec(
  plannedStartSec: number,
  clipDurSec: number,
  spanSec: number,
  sourceDurationSec: number
): number {
  const centred = plannedStartSec + clipDurSec / 2 - spanSec / 2;
  const latest = sourceDurationSec > 0 ? Math.max(0, sourceDurationSec - spanSec) : Number.POSITIVE_INFINITY;
  return Math.round(Math.max(0, Math.min(centred, latest)) * 10) / 10;
}

/** A moment: a single shot, with where it sits in the YouTube video. */
export type MomentShot = { path: string; sourceStartSec: number; sourceEndSec: number; handedOut?: number };

/** `k` items spread evenly over `list`, first and last included. */
function spread<T>(list: readonly T[], k: number): T[] {
  if (list.length <= k) return [...list];
  if (k === 1) return [list[0]!];
  const out: T[] = [];
  for (let i = 0; i < k; i++) out.push(list[Math.round((i * (list.length - 1)) / (k - 1))]!);
  return [...new Set(out)];
}

/**
 * Which of a section's shots are shown to the picture editor.
 *
 * The shots offered to fewest beats first (so beats running at the same time see different
 * moments), spread over the section rather than three neighbouring shots, and — when the caller
 * has a planned second — the one nearest that plan first in line. The editor decides; the order
 * only says which it looks at first.
 */
export function chooseMoments<T extends MomentShot>(shots: readonly T[], max: number, preferSec?: number): T[] {
  if (max <= 0 || !shots.length) return [];
  const byTime = [...shots].sort((a, b) => a.sourceStartSec - b.sourceStartSec);
  const least = Math.min(...byTime.map((s) => s.handedOut ?? 0));
  const fresh = byTime.filter((s) => (s.handedOut ?? 0) === least);
  const picks = spread(fresh, max);
  if (picks.length < max) {
    const rest = byTime.filter((s) => !picks.includes(s)).sort((a, b) => (a.handedOut ?? 0) - (b.handedOut ?? 0));
    picks.push(...rest.slice(0, max - picks.length));
  }
  if (preferSec != null) {
    const distance = (s: T) => Math.abs(s.sourceStartSec - preferSec);
    picks.sort((a, b) => distance(a) - distance(b) || a.sourceStartSec - b.sourceStartSec);
  } else {
    picks.sort((a, b) => a.sourceStartSec - b.sourceStartSec);
  }
  return picks;
}

/**
 * The single shots of a downloaded section, each with its seconds in the YouTube video.
 *
 * When the cut scan cannot finish, the planned window itself is the one moment — what the beat
 * would have got before this change, never less. A section that is nothing but rapid cuts has no
 * shot long enough to use and yields nothing, the same rule the film's stock applies.
 */
export async function sectionMoments(
  sectionPath: string,
  sectionStartSec: number,
  plannedStartSec: number,
  clipDurSec: number,
  workDir: string,
  cutter: LocalShotCutter
): Promise<MomentShot[]> {
  fs.mkdirSync(workDir, { recursive: true });
  const cut = await cutLocalVideoIntoShots(sectionPath, workDir, cutter);
  const at = (startSec: number, endSec: number) => ({
    sourceStartSec: Number((sectionStartSec + startSec).toFixed(2)),
    sourceEndSec: Number((sectionStartSec + endSec).toFixed(2)),
  });
  if (cut.kind === "pieces") return cut.pieces.map((p) => ({ path: p.path, ...at(p.startSec, p.endSec) }));
  if (cut.kind === "one_shot") return [{ path: sectionPath, ...at(0, cut.durationSec) }];
  if (cut.kind === "no_clean_shot") return [];
  const offset = Math.max(0, plannedStartSec - sectionStartSec);
  const out = path.join(workDir, "planned_window.mp4");
  await cutter.extract(sectionPath, out, offset, offset + clipDurSec);
  return fs.existsSync(out) && fs.statSync(out).size > 0 ? [{ path: out, ...at(offset, offset + clipDurSec) }] : [];
}

/**
 * OCTOBER 2026 — THE BEST MOMENT, NOT THE FIRST ONE THAT PASSED.
 *
 * The beat's queue walks its candidates in cheap-rank order and adopted the first the editor
 * approved, so of three moments of the same video the one ranked first won whenever it passed at
 * all. Now an approved moment first lets its unlooked siblings be looked at (once), and then lets
 * any approved sibling the editor scored higher go before it (once). Both are the queue's existing
 * deferral idiom — a candidate goes to the back — so the bound is the same queue, and the judge
 * calls are the sibling moments the beat already holds, nothing more.
 */
export type MomentChoice = "adopt" | "look_at_siblings_first" | "better_moment_first";

/** The YouTube video id inside a fragment key (`youtube_cc:<id>@t12d4`), or null for any other clip. */
export function momentVideoOf(fragmentKey: string | null | undefined): string | null {
  if (!fragmentKey) return null;
  const m = /^youtube_cc:([^@]+)@/.exec(fragmentKey);
  return m ? m[1]! : null;
}

export function chooseAmongMoments(params: {
  /** The video this approved candidate is a moment of; null means it is not a moment and is adopted. */
  video: string | null;
  ownScore: number | undefined;
  /** Candidates still waiting in the queue that the editor has not looked at yet, with their video. */
  unlooked: ReadonlyArray<{ video: string | null }>;
  /** Approved moments held by this beat (not this one), with their video and score. */
  approved: ReadonlyArray<{ video: string | null; score: number | undefined }>;
  waitedForSiblings: boolean;
  yieldedToBetter: boolean;
}): MomentChoice {
  if (!params.video) return "adopt";
  if (!params.waitedForSiblings && params.unlooked.some((c) => c.video === params.video)) {
    return "look_at_siblings_first";
  }
  if (!params.yieldedToBetter) {
    const own = params.ownScore ?? 0;
    if (params.approved.some((c) => c.video === params.video && (c.score ?? 0) > own)) {
      return "better_moment_first";
    }
  }
  return "adopt";
}
