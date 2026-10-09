/**
 * STEP 0 (QUALITY RESCUE) — ONE LINE THAT SAYS WHAT THE VIEWER GOT, AND WHAT THE RENDER STARTED FROM.
 *
 * The render already prints each part on its own: `[VisualShots]` (before the edit), `[YouTubeInFilm]`
 * (YouTube seconds of the delivered timeline), `[SENTENCE_PICTURE]` (per sentence), `[FitChain]`
 * (judged → approved → placed), `[YouTubeFunnel]` (downloads), `[FitPlacement]` (why an approval was
 * lost). None of them answered "how much of this film is real moving footage, how much is a card, how
 * much is nothing" in one place, and none said what the render could already use when it started —
 * which is what a second render of the same video has more of (the pool's searches, the prefetch's
 * archive clips), and what an A/B comparison must see before it credits a change.
 *
 * Pure: every number is passed in by the caller from a register the render already keeps. A number
 * the caller does not have is printed as UNKNOWN — never estimated, never zero.
 *
 * Units differ per step and are named: found and downloaded are VIDEOS, judged is LOOKS, approved is
 * PICTURES, placed and rendered are SHOTS. Judged/approved/placed count every source (as `[FitChain]`).
 */
import type { TimelineVideoClip } from "./projectTimeline";
import { pictureIsHidden } from "./youtubeFootageInFilm";

export type QualityRescueBaseline = {
  /** Searches the video had already spent before this render (a second render reuses the first one's). */
  poolSearchesBefore: number | null;
  /** Pool candidates (usable) carried over from an earlier render of this video. */
  poolUsableBefore: number | null;
  /** Usable pool candidates at the end of this render. */
  poolUsable: number | null;
  /** Archive clips the pool's planner counted as usable for this video. */
  archiveUsable: number | null;
  /** Pool videos the background prefetch had put in the archive before this render started. */
  prefetchedBefore: number | null;
  /** Seconds of the delivered film that came from YouTube through the archive (the prefetch's route). */
  viaArchiveSec: number | null;
};

export type QualityRescueFunnel = {
  /** YouTube videos the pool found usable. */
  foundVideos: number | null;
  /** YouTube videos this render downloaded at least once (P1 funnel), and the transfers that delivered. */
  downloadedVideos: number | null;
  deliveredTransfers: number | null;
  /** Looks of the picture editor (every source). */
  judged: number | null;
  /** MISMATCH answers of the picture editor (every source). */
  mismatch: number | null;
  /** Pictures approved for a sentence, and the real shots of them placed (every source, `[FitPlacement]`). */
  approved: number | null;
  placed: number | null;
  /** Why an approved picture was not placed (P4 classes). */
  lossCauses?: Readonly<Record<string, number>>;
  /** Why a download did not deliver (P1 classes). */
  downloadFailures?: Readonly<Record<string, number>>;
};

export type QualityRescueInventory = {
  sentencesOffered: number;
  offered: number;
  approved: number;
  /** Approved inventory pictures that are in the film's result after the final placement. */
  placed: number | null;
  excluded: Readonly<Record<string, number>>;
};

export type QualityRescueSeconds = {
  basis: "rendered_timeline" | "planned_timeline" | "unmeasured";
  filmSec: number;
  /** Seconds a visible moving clip (kind video) is on screen. */
  realMovingSec: number;
  /** Seconds a visible still is on screen and no moving clip. */
  stillSec: number;
  /** Seconds only a hidden card ground (opacity 0, a graphic over it) is on screen. */
  cardSec: number;
  /** Seconds with no clip at all on the video track (the plain background). */
  greySec: number;
  sentences: number;
  sentencesWithMoving: number;
  /** Visible clips on the timeline (pieces of one shot count once). */
  renderedShots: number;
};

type Interval = [number, number];
function union(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
const total = (xs: Interval[]) => xs.reduce((s, [a, b]) => s + (b - a), 0);
/** Seconds of `xs` not covered by `cover` (both already unions). */
function minus(xs: Interval[], cover: Interval[]): number {
  let left = 0;
  for (const [a, b] of xs) {
    let covered = 0;
    for (const [c, d] of cover) covered += Math.max(0, Math.min(b, d) - Math.max(a, c));
    left += Math.max(0, b - a - covered);
  }
  return left;
}

/** The film's seconds by what the viewer sees, measured on the timeline the file was rendered from. */
export function qualitySecondsOfTimeline(
  clips: readonly TimelineVideoClip[],
  sentences: ReadonlyArray<{ sceneIndex: number; beatIndex: number }>,
  basis: QualityRescueSeconds["basis"],
  filmSec?: number
): QualityRescueSeconds {
  const live = clips.filter((c) => !c.disabled);
  const span = (c: TimelineVideoClip): Interval => [Number(c.timelineStart) || 0, Number(c.timelineEnd) || 0];
  const visible = live.filter((c) => !pictureIsHidden(c));
  const moving = union(visible.filter((c) => c.kind === "video").map(span));
  const shown = union(visible.map(span));
  const any = union(live.map(span));
  const film = filmSec ?? live.reduce((m, c) => Math.max(m, Number(c.timelineEnd) || 0), 0);
  const withMoving = sentences.filter((s) =>
    visible.some((c) => c.kind === "video" && c.sceneIndex === s.sceneIndex && c.beatIndex === s.beatIndex)
  ).length;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    basis,
    filmSec: r2(film),
    realMovingSec: r2(total(moving)),
    stillSec: r2(total(shown) - total(moving)),
    cardSec: r2(minus(any, shown)),
    greySec: r2(Math.max(0, film - total(any))),
    sentences: sentences.length,
    sentencesWithMoving: withMoving,
    renderedShots: new Set(visible.map((c) => c.id.replace(/_p\d+$/, ""))).size,
  };
}

const n = (v: number | null | undefined) => (v == null ? "UNKNOWN" : String(v));
const counts = (r: Readonly<Record<string, number>> | undefined) =>
  r == null
    ? "UNKNOWN"
    : `{${Object.entries(r)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}}`;

/** The render's quality in two lines: what the film is made of, and what the render started from. */
export function formatQualityRescue(
  videoId: number,
  sec: QualityRescueSeconds | null,
  funnel: QualityRescueFunnel,
  inventory: QualityRescueInventory,
  baseline: QualityRescueBaseline
): string[] {
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "UNKNOWN");
  const film = sec
    ? `basis=${sec.basis} sentences=${sec.sentences} withRealMoving=${sec.sentencesWithMoving} (${pct(sec.sentencesWithMoving, sec.sentences)}) ` +
      `filmSec=${sec.filmSec} realMovingSec=${sec.realMovingSec} (${pct(sec.realMovingSec, sec.filmSec)}) stillSec=${sec.stillSec} ` +
      `cardSec=${sec.cardSec} greySec=${sec.greySec}`
    : "basis=unmeasured — no readable timeline; seconds UNKNOWN";
  const notPlaced = funnel.approved != null && funnel.placed != null ? funnel.approved - funnel.placed : null;
  return [
    `[QualityRescue] video=${videoId} ${film} | ` +
      `foundVideos=${n(funnel.foundVideos)} downloadedVideos=${n(funnel.downloadedVideos)} deliveredTransfers=${n(funnel.deliveredTransfers)} ` +
      `judgedLooks=${n(funnel.judged)} approvedPictures=${n(funnel.approved)} placedShots=${n(funnel.placed)} renderedShots=${n(sec?.renderedShots)} | ` +
      `losses: download=${counts(funnel.downloadFailures)} judgeMismatch=${n(funnel.mismatch)} approvedNotPlaced=${n(notPlaced)} ${counts(funnel.lossCauses)} | ` +
      `inventory sentences=${inventory.sentencesOffered} offered=${inventory.offered} approved=${inventory.approved} placed=${n(inventory.placed)} ` +
      `excluded=${counts(inventory.excluded)}`,
    `[QualityRescue] video=${videoId} baseline poolSearchesBefore=${n(baseline.poolSearchesBefore)} poolUsableBefore=${n(baseline.poolUsableBefore)} ` +
      `poolUsable=${n(baseline.poolUsable)} archiveUsable=${n(baseline.archiveUsable)} prefetchedBefore=${n(baseline.prefetchedBefore)} ` +
      `viaArchiveSec=${n(baseline.viaArchiveSec)}` +
      (baseline.poolSearchesBefore != null && baseline.poolSearchesBefore > 0
        ? " — REUSED: this render started from an earlier render's searches"
        : "") +
      (baseline.prefetchedBefore != null && baseline.prefetchedBefore > 0 ? " — ARCHIVE_HEAD_START: prefetched footage was available" : ""),
  ];
}
