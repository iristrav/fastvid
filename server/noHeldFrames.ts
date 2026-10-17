/**
 * VIDEO 663 — NO HELD FRAME, ANYWHERE.
 *
 * The owner, after render 73: "Er mag geen vastgehouden beeld in de video." Its own [ViewerReport]
 * said `stillSec=5.5 (7.2%)`: seven segments whose file ended before their slot ([ShotFreeze]) or
 * that were planned to read to an out-point and hold it ([ShotHold]), one of them behind the opening
 * map card. Every earlier rule ended on "the last frame holds" as its floor.
 *
 * The renderer is the one place that knows each file's real length. Before any segment is encoded,
 * every shot that cannot fill its slot with its own seconds gives the rest of its slot to the shot
 * beside it — the next one starts earlier, or the one before runs on — as long as that neighbour has
 * seconds of its own left that no other shot of the film shows (`footageKey`/`sourceWindow`, the
 * same test as `removeRepeatedFootage`). A photograph can always take the time (it keeps moving). The
 * narration, captions and graphics keep their times; only the cut between two pictures moves.
 *
 * VIDEO 663 (R2) — and before any cut moves, the shot first reads earlier in its own file (seconds
 * before its in-point nobody else shows); a neighbour may also start earlier with its own unshown
 * seconds before its in-point. Only when nothing anywhere is left does a shot still hold: that is
 * logged as an ERROR and the held frame is given a visible move by the renderer (never a frozen picture).
 */
import type { TimelineVideoClip } from "./projectTimeline";
import { footageKey, OVERLAP_TOLERANCE_SEC, sourceWindow } from "./noRepeatedFootage";

const EPS = 0.04;
/** A neighbour keeps at least this much of its own slot. */
const MIN_SLOT_SEC = 0.6;

const slot = (c: TimelineVideoClip) => Math.max(0, c.timelineEnd - c.timelineStart);
const speedOf = (c: TimelineVideoClip) => (c.speed && c.speed > 0 ? c.speed : 1);
const round = (n: number) => Number(n.toFixed(3));

/**
 * The seconds of slot a clip can fill with its own picture: from its in-point to the end of its file
 * (and, for a clip planned to stop at its out-point, to that out-point), at its speed. `fileSecIn` is
 * the file's length in the clip's own in-point seconds (the caller adds any `providerWindow` start).
 * Infinity for a photograph or an unknown length.
 */
export function ownSeconds(c: TimelineVideoClip, fileSecIn: number | null): number {
  if (c.kind === "image" || fileSecIn == null || !(fileSecIn > 0)) return Number.POSITIVE_INFINITY;
  const from = Math.max(0, c.sourceIn ?? 0);
  let to = fileSecIn;
  if (c.holdAtSourceOut && c.sourceOut != null && c.sourceOut > from) to = Math.min(to, c.sourceOut);
  return Math.max(0, to - from) / speedOf(c);
}

/** Would `c` reading `[from, to)` of its source show seconds another shot of the film shows? */
function showsAnotherShotsSeconds(c: TimelineVideoClip, from: number, to: number, all: readonly TimelineVideoClip[]): boolean {
  const key = footageKey(c);
  if (!key || c.kind === "image") return false;
  return all.some((o) => {
    if (o === c || o.disabled || footageKey(o) !== key) return false;
    const [a, b] = sourceWindow(o);
    return Math.min(b, to) - Math.max(a, from) > OVERLAP_TOLERANCE_SEC;
  });
}

/**
 * Move cuts so no shot holds a frame. `clips` are the enabled video clips in time order, mutated in
 * place; `fileSecIn(c)` is each file's length in that clip's in-point seconds (null: unknown).
 * Returns one line per change, and one per shot that still holds.
 */
/** How many more seconds of its own a neighbour can play past its current end, without a repeat. */
function spareAfterFor(clips: readonly TimelineVideoClip[], fileSecIn: (c: TimelineVideoClip) => number | null, cap?: (c: TimelineVideoClip) => number) {
  return (n: TimelineVideoClip): number => {
    const own = Math.min(ownSeconds(n, fileSecIn(n)), cap ? cap(n) : Number.POSITIVE_INFINITY);
    const spare = own - slot(n);
    if (!(spare > EPS)) return 0;
    if (!Number.isFinite(spare)) return Number.POSITIVE_INFINITY;
    /** the extra seconds it would read: right after what it reads now */
    const from = Math.max(0, n.sourceIn ?? 0) + slot(n) * speedOf(n);
    const to = from + spare * speedOf(n);
    return showsAnotherShotsSeconds(n, from, to, clips) ? 0 : spare;
  };
}

/** The file's first second in the clip's in-point seconds: a provider window starts the file later in the video. */
const fileStartIn = (c: TimelineVideoClip): number => Math.max(0, c.source?.providerWindow?.inSec ?? 0);

/**
 * VIDEO 663 (R2) — how many seconds of slot a clip can fill with the seconds of its own file BEFORE its
 * in-point, back to the file's start or to the nearest window another shot of the same footage shows.
 * Zero for a photograph (it never runs short) and for a clip that already overlaps another shot.
 */
function spareBeforeFor(clips: readonly TimelineVideoClip[]) {
  return (n: TimelineVideoClip): number => {
    if (n.kind === "image") return 0;
    const at = Math.max(0, n.sourceIn ?? 0);
    let earliest = fileStartIn(n);
    if (!(at - earliest > EPS)) return 0;
    const key = footageKey(n);
    if (key) {
      for (const o of clips) {
        if (o === n || o.disabled || footageKey(o) !== key) continue;
        const [a, b] = sourceWindow(o);
        if (a < at - OVERLAP_TOLERANCE_SEC && b > at + OVERLAP_TOLERANCE_SEC) return 0;
        if (b <= at + OVERLAP_TOLERANCE_SEC && b > earliest) earliest = b;
      }
    }
    return Math.max(0, at - earliest) / speedOf(n);
  };
}

/**
 * Hand `want` seconds of clip `i`'s slot to the shot after it (it starts earlier: reading on past its
 * end, then — VIDEO 663 (R2) — from the unshown seconds before its in-point), then to the shot before
 * it (it runs on). Returns how many seconds were handed over, with one note per move.
 */
function handOver(
  clips: TimelineVideoClip[],
  i: number,
  want: number,
  spareAfter: (n: TimelineVideoClip) => number,
  why: string,
  notes: string[],
  spareBefore?: (n: TimelineVideoClip) => number
): number {
  const c = clips[i]!;
  const next = clips[i + 1];
  const prev = clips[i - 1];
  let left = want;
  if (next && Math.abs(next.timelineStart - c.timelineEnd) < EPS && !next.disabled) {
    const give = Math.min(left, spareAfter(next), Math.max(0, slot(c) - MIN_SLOT_SEC));
    if (give > EPS) {
      c.timelineEnd = round(c.timelineEnd - give);
      next.timelineStart = c.timelineEnd;
      if (next.sourceOut != null && next.kind !== "image") next.sourceOut = round((next.sourceIn ?? 0) + slot(next) * speedOf(next));
      left -= give;
      notes.push(`${c.id}: ${why} ${give.toFixed(2)}s — ${next.id} starts that much earlier`);
    }
  }
  if (left > EPS && spareBefore && next && Math.abs(next.timelineStart - c.timelineEnd) < EPS && !next.disabled && next.kind !== "image") {
    /** the next shot starts earlier on the timeline AND in its source: its own frame at the cut it had stays where it was */
    const give = Math.min(left, spareBefore(next), Math.max(0, slot(c) - MIN_SLOT_SEC));
    if (give > EPS) {
      c.timelineEnd = round(c.timelineEnd - give);
      next.timelineStart = c.timelineEnd;
      next.sourceIn = round(Math.max(fileStartIn(next), (next.sourceIn ?? 0) - give * speedOf(next)));
      left -= give;
      notes.push(`${c.id}: ${why} ${give.toFixed(2)}s — ${next.id} starts that much earlier, with its own seconds before its in-point`);
    }
  }
  if (left > EPS && prev && Math.abs(prev.timelineEnd - c.timelineStart) < EPS && !prev.disabled) {
    const give = Math.min(left, spareAfter(prev), Math.max(0, slot(c) - MIN_SLOT_SEC));
    if (give > EPS) {
      prev.timelineEnd = round(prev.timelineEnd + give);
      c.timelineStart = prev.timelineEnd;
      if (prev.sourceOut != null && prev.kind !== "image") prev.sourceOut = round((prev.sourceIn ?? 0) + slot(prev) * speedOf(prev));
      left -= give;
      notes.push(`${c.id}: ${why} ${give.toFixed(2)}s — ${prev.id} runs that much longer`);
    }
  }
  return want - left;
}

/**
 * VIDEO 663 — A SHOT THAT HARDLY MOVES IS KEPT SHORT.
 *
 * Render 73 ended on a slow aerial of Brussels for 5.9 s (a frame-to-frame difference of about 0.8 on
 * a 32×18 grey thumbnail) and held the EU quarter for 5 s the same way: to a viewer, a still. A shot
 * the renderer measured as hardly moving (`isSlow`) keeps at most `SLOW_SHOT_MAX_SEC`; the rest goes to
 * the shots beside it when they have unshown seconds of their own (the same rule as a held frame). What
 * cannot be handed over stays, and the renderer gives it a slow push so it moves.
 */
export const SLOW_SHOT_MAX_SEC = 3.5;
export function shortenSlowShots(
  clips: TimelineVideoClip[],
  fileSecIn: (c: TimelineVideoClip) => number | null,
  isSlow: (c: TimelineVideoClip) => boolean
): string[] {
  const notes: string[] = [];
  /** a slow neighbour may not grow past the same limit */
  const spareAfter = spareAfterFor(clips, fileSecIn, (n) => (isSlow(n) ? SLOW_SHOT_MAX_SEC : Number.POSITIVE_INFINITY));
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    if (c.kind === "image" || !isSlow(c)) continue;
    const excess = slot(c) - SLOW_SHOT_MAX_SEC;
    if (!(excess > EPS)) continue;
    handOver(clips, i, excess, spareAfter, "hardly moves — shortened by", notes);
  }
  return notes;
}

export function giveHeldSecondsToNeighbours(
  clips: TimelineVideoClip[],
  fileSecIn: (c: TimelineVideoClip) => number | null
): { notes: string[]; stillHeld: Array<{ clipId: string; sec: number }> } {
  const notes: string[] = [];
  const stillHeld: Array<{ clipId: string; sec: number }> = [];
  const spareAfter = spareAfterFor(clips, fileSecIn);
  const spareBefore = spareBeforeFor(clips);
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    if (c.kind === "image") continue;
    let deficit = slot(c) - ownSeconds(c, fileSecIn(c));
    if (!(deficit > EPS)) continue;
    /**
     * VIDEO 663 (R2) — first its own file: the shot starts earlier in its source, into seconds no other
     * shot of the film shows. No cut moves; the sentence keeps its own picture.
     */
    const own = Math.min(deficit, spareBefore(c));
    if (own > EPS) {
      c.sourceIn = round(Math.max(fileStartIn(c), (c.sourceIn ?? 0) - own * speedOf(c)));
      deficit -= own;
      notes.push(`${c.id}: its file ends before its slot — it starts ${own.toFixed(2)}s earlier in its own source`);
    }
    if (!(deficit > EPS)) continue;
    deficit -= handOver(clips, i, deficit, spareAfter, "its own seconds end before its slot by", notes, spareBefore);
    if (deficit > EPS) {
      stillHeld.push({ clipId: c.id, sec: round(deficit) });
      notes.push(`${c.id}: ERROR ${deficit.toFixed(2)}s HELD — no unshown seconds in its own file or beside it; the held frame is given a visible move`);
    }
  }
  return { notes, stillHeld };
}

