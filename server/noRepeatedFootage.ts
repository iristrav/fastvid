/**
 * VIDEO 656 — THE SAME SECONDS OF FOOTAGE ARE NEVER SHOWN TWICE IN ONE FILM.
 *
 * Render 656 showed the same 2.9 s of a YouTube shot three times in a row, twice (vc_c94d525f36 and
 * vc_8f81249bcc: a 4 s source held for 8.2 s under a sentence that had no picture of its own, cut
 * into three pieces with one distinct window), and a 3 s clip came back seven seconds after it was
 * first shown, as a filler for a hole (`vc_032cede8cd_fill1`). Every earlier rule chose a repeat as
 * its last resort. The owner's rule (14 October): no repeated pictures.
 *
 * So this is the last pass over the finished clip list, after the holds, the fillers and the
 * five-second YouTube pieces. A clip whose source seconds overlap seconds already on screen is taken
 * out, and the shot before it keeps playing over its time: slower, down to the renderer's floor
 * (`MIN_FIT_SPEED`), and past that its last frame holds (`tpad`). A held frame is a still, not a
 * repeat. The clip list still covers exactly the same span, so the narration is untouched.
 *
 * What counts as "the same footage": the same asset (archive id, else provider + provider id, else
 * the canonical URL) and source windows that overlap by more than `OVERLAP_TOLERANCE_SEC`. A still
 * image counts once, whatever part of it a camera move shows. A clip the customer placed by hand is
 * never removed; its seconds still count.
 */
import type { TimelineVideoClip } from "./projectTimeline";

/** Below this, two windows touch rather than repeat: a cut point read twice on rounding. */
export const OVERLAP_TOLERANCE_SEC = 0.25;
/** The renderer's own floor (`MIN_FIT_SPEED` in timelineRenderer): past it, the last frame holds. */
const SLOWEST = 0.5;
const EPS = 0.001;
/** A held frame reads one frame and a little of its source (the renderer clones it for the rest). */
const HOLD_READ_SEC = 0.05;

/** The identity of the footage a clip shows, or null when it shows nothing that can repeat. */
export function footageKey(clip: Pick<TimelineVideoClip, "source">): string | null {
  const s = clip.source;
  if (s.archiveAssetId != null) return `archive:${s.archiveAssetId}`;
  if (s.providerAssetId) return `${s.provider}:${s.providerAssetId}`;
  if (s.canonicalUrl) return `url:${s.canonicalUrl}`;
  return null;
}

/** The source seconds a clip reads: from its in-point, for its slot at its speed. */
export function sourceWindow(clip: TimelineVideoClip): [number, number] {
  const from = Math.max(0, clip.sourceIn ?? 0);
  if (clip.kind === "image") return [0, Number.POSITIVE_INFINITY];
  const slot = Math.max(0, clip.timelineEnd - clip.timelineStart);
  const reads = clip.sourceOut != null && clip.sourceOut > from ? clip.sourceOut - from : slot * (clip.speed ?? 1);
  return [from, from + reads];
}

function overlaps(a: [number, number], b: [number, number]): boolean {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]) > OVERLAP_TOLERANCE_SEC;
}

/** The ground under a graphic and other invisible clips show no footage of their own. */
function showsFootage(clip: TimelineVideoClip, skip: (c: TimelineVideoClip) => boolean): boolean {
  return !clip.disabled && !skip(clip) && footageKey(clip) != null;
}

/**
 * Let `keep` cover [start, end): slower down to the floor, the rest a held last frame. Its in-point
 * stays where the planner put it; `sourceOut` records what it now reads, so a later clip of the same
 * footage that would show those seconds again is taken out too.
 */
function stretchOver(keep: TimelineVideoClip, start: number, end: number): void {
  const [from, to] = sourceWindow(keep);
  const ownSec = to - from;
  keep.timelineStart = Number(start.toFixed(3));
  keep.timelineEnd = Number(end.toFixed(3));
  if (keep.kind === "image") return;
  const slot = keep.timelineEnd - keep.timelineStart;
  if (!(slot > EPS) || !(ownSec > EPS)) return;
  const speed = Math.min(keep.speed ?? 1, Math.max(SLOWEST, ownSec / slot));
  keep.speed = Number(speed.toFixed(4));
  keep.sourceOut = Number((from + Math.min(ownSec, slot * speed)).toFixed(3));
  /** Its own seconds even at the floor do not fill the slot: it stops on its last frame, not on the file's next seconds. */
  if (slot * speed > ownSec + EPS) keep.holdAtSourceOut = true;
}

/**
 * The frame `src` starts on (`at: "first"`) or ends on (`"last"`), held over [start, end): a still of
 * a shot already on screen, never seconds it has not shown. Used after the five-second YouTube rule,
 * where a shot may no longer grow.
 */
function holdOf(src: TimelineVideoClip, at: "first" | "last", start: number, end: number, id: string): TimelineVideoClip {
  const [from, to] = sourceWindow(src);
  const frame = at === "first" ? from : Math.max(from, (Number.isFinite(to) ? to : from) - HOLD_READ_SEC);
  const hold: TimelineVideoClip = {
    ...src,
    id,
    timelineStart: Number(start.toFixed(3)),
    timelineEnd: Number(end.toFixed(3)),
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
  };
  delete hold.transitionInSec;
  delete hold.transitionOutSec;
  if (src.kind === "image") return hold;
  delete hold.speed;
  hold.sourceIn = Number(frame.toFixed(3));
  hold.sourceOut = Number((frame + HOLD_READ_SEC).toFixed(3));
  hold.holdAtSourceOut = true;
  return hold;
}

export function removeRepeatedFootage(
  clips: readonly TimelineVideoClip[],
  opts: {
    skip?: (c: TimelineVideoClip) => boolean;
    /**
     * After the five-second YouTube rule a shot may not grow: a repeat becomes a held frame of the
     * shot beside it (its own clip, `…_hold`) instead of that shot playing on over it.
     */
    holdInstead?: boolean;
  } = {}
): { clips: TimelineVideoClip[]; notes: string[]; adjustedIds: string[] } {
  const skip = opts.skip ?? (() => false);
  const holdInstead = opts.holdInstead === true;
  const seen = new Map<string, Array<{ window: [number, number]; id: string }>>();
  const out: TimelineVideoClip[] = [];
  const notes: string[] = [];
  /** Every clip removed or stretched here: an adjustment, so it is not reported as a lost planned shot. */
  const adjusted = new Set<string>();
  /** A repeat at the very start has no shot before it: the first kept shot then starts there. */
  let openStart: number | null = null;

  const remember = (c: TimelineVideoClip) => {
    const key = footageKey(c);
    if (!key) return;
    const list = seen.get(key) ?? [];
    list.push({ window: sourceWindow(c), id: c.id });
    seen.set(key, list);
  };

  for (const original of clips) {
    const clip = { ...original };
    if (!showsFootage(clip, skip)) {
      out.push(clip);
      continue;
    }
    const key = footageKey(clip)!;
    const window = sourceWindow(clip);
    const earlier = (seen.get(key) ?? []).find((s) => overlaps(s.window, window));
    if (!earlier || clip.editedByUser) {
      if (openStart != null && holdInstead) {
        out.push(holdOf(clip, "first", openStart, clip.timelineStart, `${clip.id}_hold`));
        adjusted.add(clip.id);
        notes.push(`${clip.id}: its first frame holds ${(clip.timelineStart - openStart).toFixed(2)}s before it, over a repeat it replaced`);
        openStart = null;
      } else if (openStart != null) {
        const end = clip.timelineEnd;
        stretchOver(clip, openStart, end);
        adjusted.add(clip.id);
        notes.push(`${clip.id}: starts ${(original.timelineStart - openStart).toFixed(2)}s earlier, over a repeat it replaced`);
        openStart = null;
      }
      remember(clip);
      out.push(clip);
      continue;
    }
    /** The shot before it on screen, ending where it starts. */
    const before = [...out].reverse().find((c) => showsFootage(c, skip) && Math.abs(c.timelineEnd - clip.timelineStart) <= 0.05);
    const what =
      clip.kind === "image"
        ? `the same still as ${earlier.id}`
        : `${window[0].toFixed(2)}–${window[1].toFixed(2)}s of the source ${earlier.id} already showed`;
    if (before && holdInstead) {
      out.push(holdOf(before, "last", clip.timelineStart, clip.timelineEnd, `${clip.id}_hold`));
      adjusted.add(before.id).add(clip.id);
      notes.push(
        `${clip.id}: REMOVED — ${what}; the last frame of ${before.id} holds for ` +
          `${(clip.timelineEnd - clip.timelineStart).toFixed(2)}s instead of a repeat`
      );
    } else if (before) {
      stretchOver(before, before.timelineStart, clip.timelineEnd);
      adjusted.add(before.id).add(clip.id);
      /** The stretched shot may now read further into its own source: those seconds are on screen too. */
      remember(before);
      notes.push(
        `${clip.id}: REMOVED — ${what}; ${before.id} plays on for ${(clip.timelineEnd - clip.timelineStart).toFixed(2)}s ` +
          `(at ${before.speed ?? 1}×, then its last frame) instead of a repeat`
      );
    } else {
      openStart = openStart ?? clip.timelineStart;
      adjusted.add(clip.id);
      notes.push(`${clip.id}: REMOVED — ${what}; the next shot starts earlier instead of a repeat`);
    }
  }
  if (openStart != null && out.length > 0) {
    /** Nothing after the repeat could take its time: the last kept shot runs to the end instead. */
    const last = [...out].reverse().find((c) => showsFootage(c, skip));
    const filmEnd = Math.max(...clips.map((c) => c.timelineEnd));
    if (last && holdInstead) {
      out.push(holdOf(last, "last", openStart, filmEnd, `${last.id}_hold_end`));
      adjusted.add(last.id);
    } else if (last) {
      stretchOver(last, last.timelineStart, Math.max(last.timelineEnd, filmEnd));
      adjusted.add(last.id);
    }
  }
  return { clips: out, notes, adjustedIds: [...adjusted] };
}
