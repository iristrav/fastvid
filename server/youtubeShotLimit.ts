/**
 * A YOUTUBE SHOT IS AT MOST FIVE SECONDS, AND IT IS ONE SHOT. RONDE 647.
 *
 * Video 604 held one YouTube fragment on screen for 40.16 s: the beats after it had no picture, and
 * `holdPictureUnderVoice` closes a hole by stretching the shot before it. The source was 30.6 s, so
 * the renderer looped it. The product rule that follows, in the operator's words:
 *
 *   - a clip from YouTube is on screen for at most 5 seconds;
 *   - the time it gives up goes to the neighbouring NON-YouTube shot in the same scene;
 *   - only when the scene has no such shot is the YouTube fragment cut into pieces of at most 5 s,
 *     each from a different moment, so nothing repeats while the fragment has material left;
 *   - and a piece may not contain a hard cut from the original video — every piece is taken from
 *     inside one continuous shot of the source.
 *
 * Everything here is pure. The shot boundaries of a source (`cutsSec`) are measured elsewhere
 * (`youtubeShotCuts.ts`) and handed in; an unmeasured source is one shot, and says so.
 */
import type { TimelineVideoClip } from "./projectTimeline";

export const YOUTUBE_MAX_SHOT_SEC = 5;
/** A piece shorter than this is a flash, not a shot. Shot segments below it are skipped. */
export const YOUTUBE_MIN_PIECE_SEC = 1;
const EPS = 0.001;

/** What the planner knows about one YouTube-derived source, in the rehydrated file's seconds. */
export type YoutubeSourceFacts = {
  /** Length of the file the rehydrator returns — the archive asset, not the render's trim. */
  sourceDurationSec: number;
  /** Where the original video cuts to another shot, ascending. Empty = measured, one shot. */
  cutsSec: readonly number[];
  /** False when the cuts were never measured; the source is then treated as one shot. */
  measured: boolean;
};

export type YoutubePiece = { inSec: number; durationSec: number };

/** The source as a list of continuous shots `[start, end)`. */
export function shotSegments(facts: YoutubeSourceFacts): Array<{ start: number; end: number }> {
  const dur = Math.max(0, facts.sourceDurationSec);
  const cuts = Array.from(new Set(facts.cutsSec))
    .filter((c) => Number.isFinite(c) && c > EPS && c < dur - EPS)
    .sort((a, b) => a - b);
  const bounds = [0, ...cuts, dur];
  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1]! - bounds[i]! > EPS) out.push({ start: bounds[i]!, end: bounds[i + 1]! });
  }
  return out;
}

const round = (n: number) => Number(n.toFixed(3));

/**
 * RONDE 654 — how far a piece stays from any cut or transition edge, so the first and last frames of
 * a piece are never the frames either side of a change.
 */
export const YOUTUBE_CUT_MARGIN_SEC = 0.25;
/** A piece shorter than this reads as a flash; below it the clip is not cut up at all. */
export const YOUTUBE_STRICT_MIN_PIECE_SEC = 1.5;

/**
 * Choose where in the source each piece comes from.
 *
 * RONDE 654 — STRICT: every piece lies inside ONE shot of the source, a quarter second clear of the
 * cut or transition on either side, and nothing is ever ignored to make that work. The slot is
 * covered by pieces of at most `maxSec`; when the source's shots are short, the pieces are short —
 * down to 1.5 s — rather than long pieces that cross a cut. The first piece starts at the planner's
 * own moment whenever that moment's shot allows it; the next follow through the source in order.
 *
 * Refused (no pieces, and the reason) when the source's length or cuts were never measured — a
 * piece cut blind may hold a change — or when no shot is 1.5 s long. The caller then gives the slot
 * to another shot rather than show a transition.
 */
export function planYoutubePieces(params: {
  inSec: number;
  durationSec: number;
  facts: YoutubeSourceFacts;
  maxSec?: number;
}): { pieces: YoutubePiece[]; notes: string[]; refused?: string } {
  const maxSec = params.maxSec ?? YOUTUBE_MAX_SHOT_SEC;
  const notes: string[] = [];
  const need = Math.max(0, params.durationSec);
  if (need <= EPS) return { pieces: [], notes };

  if (!params.facts.measured || !(params.facts.sourceDurationSec > 0)) {
    return { pieces: [], notes, refused: "shot boundaries not measured — a blind cut may hold a transition" };
  }

  /** The usable part of every shot: clear of the cut on each side, except at the file's own ends. */
  const dur = params.facts.sourceDurationSec;
  const usable = shotSegments(params.facts)
    .map((seg) => ({
      start: seg.start > EPS ? seg.start + YOUTUBE_CUT_MARGIN_SEC : seg.start,
      end: seg.end < dur - EPS ? seg.end - YOUTUBE_CUT_MARGIN_SEC : seg.end,
    }))
    .filter((seg) => seg.end - seg.start >= YOUTUBE_STRICT_MIN_PIECE_SEC - EPS);
  if (usable.length === 0) {
    return {
      pieces: [],
      notes,
      refused: `no shot in the source is ${YOUTUBE_STRICT_MIN_PIECE_SEC}s long once clear of its cuts`,
    };
  }

  /**
   * Equal pieces, as before: a 12 s slot is three 4 s shots, not 5 + 5 + 2. Only when no shot can
   * hold a piece that long are the pieces made shorter — as long as the longest shot allows — and
   * never shorter than a second.
   */
  let count = Math.max(1, Math.ceil(need / maxSec - EPS));
  let len = need / count;
  const longest = Math.max(...usable.map((seg) => seg.end - seg.start));
  if (longest < len - EPS) {
    count = Math.max(1, Math.ceil(need / longest - EPS));
    len = Math.max(YOUTUBE_MIN_PIECE_SEC, need / count);
    notes.push(
      `the longest shot clear of its cuts is ${longest.toFixed(2)}s — ${count} shorter piece(s) of ` +
        `${len.toFixed(2)}s instead of crossing a cut`
    );
  }

  /** All distinct windows, in source order, each inside one usable shot. */
  const windows: number[] = [];
  for (const seg of usable) {
    for (let at = seg.start; at + len <= seg.end + EPS; at += len) windows.push(at);
  }
  if (windows.length === 0) {
    return { pieces: [], notes, refused: `no shot in the source holds a ${len.toFixed(2)}s piece clear of its cuts` };
  }

  /** Start at the planner's moment: inside its own shot, moved just enough to fit. */
  const inSec = Math.max(0, params.inSec);
  const home = usable.find((seg) => inSec >= seg.start - EPS && inSec < seg.end - EPS);
  let first: number | null = null;
  if (home && home.end - home.start >= len - EPS) {
    first = Math.min(Math.max(inSec, home.start), home.end - len);
  }
  const overlapsFirst = (w: number) => first != null && w < first + len - EPS && w + len > first + EPS;
  const rest = windows.filter((w) => !overlapsFirst(w));
  const anchor = first ?? inSec;
  const order: number[] = [
    ...(first != null ? [first] : []),
    ...rest.filter((w) => w >= anchor - EPS),
    ...rest.filter((w) => w < anchor - EPS),
  ];

  const pieces: YoutubePiece[] = [];
  for (let i = 0; i < count; i++) pieces.push({ inSec: round(order[i % order.length]!), durationSec: round(len) });
  if (count > order.length) {
    notes.push(
      `the source holds ${order.length} distinct ${len.toFixed(2)}s window(s) for ${count} piece(s) — ` +
        `${count - order.length} repeat`
    );
  }

  if (Math.abs(pieces[0]!.inSec - params.inSec) > EPS) {
    notes.push(`in-point moved ${params.inSec.toFixed(2)}s → ${pieces[0]!.inSec.toFixed(2)}s so the piece holds no cut`);
  }
  return { pieces, notes };
}

/**
 * Apply the rule to a finished, gap-free clip list.
 *
 * `youtube` maps a clip id to its source facts; a clip absent from it is not YouTube. Clips keep
 * their order and the whole list covers exactly the same span of the timeline, so the narration,
 * the captions and the scene offsets are untouched.
 */
export function limitYoutubeShots(params: {
  clips: TimelineVideoClip[];
  youtube: ReadonlyMap<string, YoutubeSourceFacts>;
  maxSec?: number;
}): { clips: TimelineVideoClip[]; notes: string[]; adjustedIds: string[] } {
  const maxSec = params.maxSec ?? YOUTUBE_MAX_SHOT_SEC;
  const notes: string[] = [];
  /** Ids of YouTube clips whose in-point or piece count the rule changed (the id before `_pN`). */
  const adjustedIds: string[] = [];
  const clips = params.clips.map((c) => ({ ...c }));
  const isYoutube = (c: TimelineVideoClip) => params.youtube.has(c.id);
  const sameScene = (a: TimelineVideoClip, b: TimelineVideoClip) =>
    a.sceneIndex != null && a.sceneIndex === b.sceneIndex;
  const dur = (c: TimelineVideoClip) => c.timelineEnd - c.timelineStart;

  /* 1 — give the time over 5 s to the neighbouring non-YouTube shot in the same scene. */
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    if (!isYoutube(clip) || clip.disabled || dur(clip) <= maxSec + EPS) continue;
    const next = clips[i + 1];
    const prev = clips[i - 1];
    const excess = dur(clip) - maxSec;
    if (next && !isYoutube(next) && !next.disabled && sameScene(clip, next)) {
      const cut = round(clip.timelineStart + maxSec);
      notes.push(
        `${clip.id}: ${dur(clip).toFixed(2)}s of YouTube → ${maxSec}s; ${next.id} starts ` +
          `${excess.toFixed(2)}s earlier to fill it`
      );
      clip.timelineEnd = cut;
      next.timelineStart = cut;
    } else if (prev && !isYoutube(prev) && !prev.disabled && sameScene(clip, prev)) {
      const cut = round(clip.timelineEnd - maxSec);
      notes.push(
        `${clip.id}: ${dur(clip).toFixed(2)}s of YouTube → ${maxSec}s; ${prev.id} holds ` +
          `${excess.toFixed(2)}s longer to fill it`
      );
      prev.timelineEnd = cut;
      clip.timelineStart = cut;
      /** The shot now begins later on the timeline; its first frame is still the planned one. */
    }
  }

  /* 2 — every YouTube clip becomes pieces of at most 5 s, each inside one shot of the source. */
  const out: TimelineVideoClip[] = [];
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    const facts = params.youtube.get(clip.id);
    if (!facts || clip.disabled || clip.kind === "image") {
      out.push(clip);
      continue;
    }
    const plan = planYoutubePieces({
      inSec: clip.sourceIn ?? 0,
      durationSec: dur(clip),
      facts,
      maxSec,
    });
    for (const n of plan.notes) notes.push(`${clip.id}: ${n}`);
    if (plan.refused) {
      /**
       * RONDE 654 — a clip that cannot be cut without showing a transition gives its slot to the
       * shot beside it in the same scene, whichever side has one that is not YouTube. Only when
       * neither exists does it stay, and the plan says so in so many words.
       */
      const prevOut = out[out.length - 1];
      const next = clips[i + 1];
      if (prevOut && !params.youtube.has(prevOut.id.replace(/_p\d+$/, "")) && !prevOut.disabled && sameScene(clip, prevOut)) {
        prevOut.timelineEnd = clip.timelineEnd;
        adjustedIds.push(clip.id);
        notes.push(`${clip.id}: REFUSED (${plan.refused}) — ${prevOut.id} holds ${dur(clip).toFixed(2)}s longer instead`);
        continue;
      }
      if (next && !isYoutube(next) && !next.disabled && sameScene(clip, next)) {
        next.timelineStart = clip.timelineStart;
        adjustedIds.push(clip.id);
        notes.push(`${clip.id}: REFUSED (${plan.refused}) — ${next.id} starts ${dur(clip).toFixed(2)}s earlier instead`);
        continue;
      }
      notes.push(
        `${clip.id}: KEPT_UNCUT — ${plan.refused}, and no other shot in scene ${clip.sceneIndex ?? "?"} ` +
          `can take its ${dur(clip).toFixed(2)}s; it may show a transition`
      );
      out.push(clip);
      continue;
    }
    if (plan.pieces.length === 0) {
      out.push(clip);
      continue;
    }
    if (plan.pieces.length > 1 || Math.abs(plan.pieces[0]!.inSec - (clip.sourceIn ?? 0)) > EPS) {
      adjustedIds.push(clip.id);
    }
    if (plan.pieces.length > 1) {
      notes.push(
        `${clip.id}: no non-YouTube shot beside it in scene ${clip.sceneIndex ?? "?"} — ` +
          `${dur(clip).toFixed(2)}s cut into ${plan.pieces.length} pieces of ` +
          `${plan.pieces[0]!.durationSec.toFixed(2)}s`
      );
    }
    let at = clip.timelineStart;
    plan.pieces.forEach((p, k) => {
      const last = k === plan.pieces.length - 1;
      const end = last ? clip.timelineEnd : round(at + p.durationSec);
      const piece: TimelineVideoClip = {
        ...clip,
        id: plan.pieces.length === 1 ? clip.id : `${clip.id}_p${k + 1}`,
        sourceIn: p.inSec,
        sourceOut: round(p.inSec + (end - at)),
        timelineStart: round(at),
        timelineEnd: end,
      };
      /** Only the first piece carries the planned transition in, only the last the one out. */
      if (k > 0) {
        piece.transitionIn = "hard_cut";
        delete piece.transitionInSec;
      }
      if (!last) {
        piece.transitionOut = "hard_cut";
        delete piece.transitionOutSec;
      }
      out.push(piece);
      at = end;
    });
  }
  return { clips: out, notes, adjustedIds };
}
