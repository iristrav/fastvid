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
 * Choose where in the source each piece comes from.
 *
 * `durationSec` is what the slot needs. It is split into `ceil(duration / max)` equal pieces, so a
 * 12 s slot becomes three 4 s shots rather than 5 + 5 + 2. Each piece must fit inside one shot
 * segment. Windows are taken in order starting from the planner's own in-point, so the first piece
 * is the moment the planner chose whenever that moment is long enough; the next pieces follow it
 * through the source. Only when every distinct window is used does it start again from the top,
 * and that repetition is reported.
 */
export function planYoutubePieces(params: {
  inSec: number;
  durationSec: number;
  facts: YoutubeSourceFacts;
  maxSec?: number;
}): { pieces: YoutubePiece[]; notes: string[] } {
  const maxSec = params.maxSec ?? YOUTUBE_MAX_SHOT_SEC;
  const notes: string[] = [];
  const need = Math.max(0, params.durationSec);
  if (need <= EPS) return { pieces: [], notes };

  const count = Math.max(1, Math.ceil(need / maxSec - EPS));
  const len = need / count;

  /**
   * A source whose length nobody measured (a YouTube clip that has no archive row): the pieces
   * simply follow each other from the planned moment, which is what playing it straight would show.
   */
  if (!(params.facts.sourceDurationSec > 0)) {
    notes.push("source length unknown — pieces follow each other from the planned moment");
    return {
      pieces: Array.from({ length: count }, (_, k) => ({
        inSec: round(Math.max(0, params.inSec) + k * len),
        durationSec: round(len),
      })),
      notes,
    };
  }

  let segments = shotSegments(params.facts);

  /** Every segment long enough for one piece; below that the whole source is one shot. */
  if (!segments.some((s) => s.end - s.start >= len - EPS)) {
    if (segments.length > 1) {
      notes.push(
        `no shot in the source is ${len.toFixed(2)}s long — its cuts are ignored for this clip`
      );
    }
    segments = [{ start: 0, end: Math.max(len, params.facts.sourceDurationSec) }];
  }

  /** All distinct windows, in source order, each inside one segment. */
  const windows: number[] = [];
  for (const s of segments) {
    if (s.end - s.start < Math.max(len, YOUTUBE_MIN_PIECE_SEC) - EPS) continue;
    for (let at = s.start; at + len <= s.end + EPS; at += len) windows.push(at);
  }
  if (windows.length === 0) windows.push(0);

  /** Start at the planner's moment: the window containing it, moved to fit its segment. */
  const home = segments.find((s) => params.inSec >= s.start - EPS && params.inSec < s.end - EPS);
  let first: number | null = null;
  if (home && home.end - home.start >= len - EPS) {
    first = Math.min(Math.max(params.inSec, home.start), home.end - len);
  }
  /** The grid windows that would show any frame of the first piece again are left out. */
  const overlapsFirst = (w: number) =>
    first != null && w < first + len - EPS && w + len > first + EPS;
  const rest = windows.filter((w) => !overlapsFirst(w));
  const anchor = first ?? params.inSec;
  const order: number[] = [
    ...(first != null ? [first] : []),
    ...rest.filter((w) => w >= anchor - EPS),
    ...rest.filter((w) => w < anchor - EPS),
  ];

  const pieces: YoutubePiece[] = [];
  for (let i = 0; i < count; i++) {
    const at = order[i % order.length]!;
    pieces.push({ inSec: round(at), durationSec: round(len) });
  }
  if (count > order.length) {
    notes.push(
      `the source holds ${order.length} distinct ${len.toFixed(2)}s window(s) for ${count} piece(s) — ` +
        `${count - order.length} repeat`
    );
  }
  if (first == null && params.inSec >= 0) {
    notes.push(
      `the planned in-point ${params.inSec.toFixed(2)}s sits in a shot shorter than ${len.toFixed(2)}s — ` +
        `moved to ${pieces[0]!.inSec.toFixed(2)}s so the piece holds no cut`
    );
  } else if (first != null && Math.abs(first - params.inSec) > EPS) {
    notes.push(
      `in-point moved ${params.inSec.toFixed(2)}s → ${first.toFixed(2)}s so the piece holds no cut`
    );
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
  for (const clip of clips) {
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
    if (!facts.measured) notes.push(`${clip.id}: shot boundaries not measured — treated as one shot`);
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
