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
import { MIN_PIECE_SPEED } from "./longShotLimit";

export const YOUTUBE_MAX_SHOT_SEC = 5;
/** A piece shorter than this is a flash, not a shot. Shot segments below it are skipped. */
export const YOUTUBE_MIN_PIECE_SEC = 1;
const EPS = 0.001;

/**
 * VIDEO 634 — the invisible ground under a sentence's card (`…_graphicN`, see `isGraphicBackdrop`
 * in edlToTimeline.ts) is never a shot that may take a YouTube clip's time. It is drawn at
 * opacity 0 and only its card covers it, so time handed to it is black on screen — the time of
 * the clip's OWN, approved sentence. `_pN` is a piece of the same clip.
 */
const GRAPHIC_BACKDROP_RE = /_graphic\d+(_p\d+)?$/;
function isCardBackdrop(c: { id: string }): boolean {
  return GRAPHIC_BACKDROP_RE.test(c.id);
}

/** What the planner knows about one YouTube-derived source, in the rehydrated file's seconds. */
export type YoutubeSourceFacts = {
  /** Length of the file the rehydrator returns — the archive asset, not the render's trim. */
  sourceDurationSec: number;
  /** Where the original video cuts to another shot, ascending. Empty = measured, one shot. */
  cutsSec: readonly number[];
  /** False when the cuts were never measured; the source is then treated as one shot. */
  measured: boolean;
};

/**
 * `speed` (below 1) when the piece is played slower so it need not repeat a window — VIDEO 636.
 * `hold` when the source has no different footage left: the piece is the last frame before it, held
 * (`holdAtSourceOut`) — VIDEO 656.
 */
export type YoutubePiece = { inSec: number; durationSec: number; speed?: number; hold?: boolean };

/** VIDEO 656 — how much source a held piece reads: one frame and a little, then that frame holds. */
export const YOUTUBE_HOLD_READ_SEC = 0.05;

/** The slowest a piece is played rather than repeat a window: the renderer's `MIN_FIT_SPEED`. */
export const YOUTUBE_MIN_PIECE_SPEED = 0.5;

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
  /** VIDEO 636 — play the pieces slower rather than repeat a window (when no neighbour can take the time). */
  slowRatherThanRepeat?: boolean;
}): { pieces: YoutubePiece[]; notes: string[]; refused?: string; distinct?: number } {
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

  /** All distinct windows of a length, in source order, each inside one usable shot. */
  const windowsOf = (l: number): number[] => {
    const out: number[] = [];
    for (const seg of usable) {
      for (let at = seg.start; at + l <= seg.end + EPS; at += l) out.push(at);
    }
    return out;
  };
  let windows = windowsOf(len);
  /**
   * RONDE 657 — the dress rehearsal played the same 4 s of a YouTube source twice in a row: one shot
   * held a 4 s window, two shorter shots held none. Rather than repeat a picture, the pieces get
   * shorter — still equal, never under `YOUTUBE_STRICT_MIN_PIECE_SEC` — until every piece can show
   * different footage. Only when even that fails does a piece hold the last frame (VIDEO 656), and
   * the note says so.
   */
  if (windows.length < count) {
    for (let more = count + 1; need / more >= YOUTUBE_STRICT_MIN_PIECE_SEC - EPS; more++) {
      const w = windowsOf(need / more);
      if (w.length >= more) {
        notes.push(
          `${count} piece(s) of ${len.toFixed(2)}s would repeat a picture — ${more} different pieces of ` +
            `${(need / more).toFixed(2)}s instead`
        );
        count = more;
        len = need / more;
        windows = w;
        break;
      }
    }
  }
  /**
   * VIDEO 636 — and before a window repeats, the pieces are played slower: 7.06 s asked of a 4.00 s
   * source showed the same 3.53 s twice. Two pieces of 3.53 s that each read 1.94 s, at 0.55×,
   * show different footage, once, in order — down to the renderer's own floor (`MIN_FIT_SPEED`,
   * 0.5). Each piece is still inside one shot and still at most `maxSec` on screen.
   */
  let speed = 1;
  if (params.slowRatherThanRepeat && windows.length < count) {
    for (let s = 0.95; s >= YOUTUBE_MIN_PIECE_SPEED - EPS; s = Number((s - 0.05).toFixed(2))) {
      const w = windowsOf(len * s);
      if (w.length >= count) {
        notes.push(
          `${count} piece(s) of ${len.toFixed(2)}s would repeat a picture — played at ${s}× instead, ` +
            `each from different footage`
        );
        speed = s;
        windows = w;
        break;
      }
    }
    /**
     * VIDEO 656 — not even the floor gives every piece its own footage: at the floor, as many pieces
     * as the source has footage for move, and the rest hold the last frame (below).
     */
    if (speed === 1) {
      const atFloor = windowsOf(len * YOUTUBE_MIN_PIECE_SPEED);
      if (atFloor.length > windows.length) {
        speed = YOUTUBE_MIN_PIECE_SPEED;
        windows = atFloor;
        notes.push(
          `${count} piece(s) of ${len.toFixed(2)}s would repeat a picture — ${atFloor.length} played at ` +
            `${YOUTUBE_MIN_PIECE_SPEED}× from different footage`
        );
      }
    }
  }
  if (windows.length === 0) {
    return { pieces: [], notes, refused: `no shot in the source holds a ${len.toFixed(2)}s piece clear of its cuts` };
  }
  const reads = len * speed;

  /** Start at the planner's moment: inside its own shot, moved just enough to fit. */
  const inSec = Math.max(0, params.inSec);
  const home = usable.find((seg) => inSec >= seg.start - EPS && inSec < seg.end - EPS);
  let first: number | null = null;
  if (home && home.end - home.start >= reads - EPS) {
    first = Math.min(Math.max(inSec, home.start), home.end - reads);
  }
  const overlapsFirst = (w: number) => first != null && w < first + reads - EPS && w + reads > first + EPS;
  const rest = windows.filter((w) => !overlapsFirst(w));
  const anchor = first ?? inSec;
  const order: number[] = [
    ...(first != null ? [first] : []),
    ...rest.filter((w) => w >= anchor - EPS),
    ...rest.filter((w) => w < anchor - EPS),
  ];

  /**
   * VIDEO 656 — never a window twice. Render 656 played the same 2.87 s three times in a row here
   * (`order[i % order.length]`). A piece the source has no different footage for is the frame the
   * piece before it ended on, held: the picture stops instead of starting over.
   */
  const pieces: YoutubePiece[] = [];
  for (let i = 0; i < count; i++) {
    if (i < order.length) {
      pieces.push({ inSec: round(order[i]!), durationSec: round(len), ...(speed < 1 ? { speed } : {}) });
      continue;
    }
    const lastFrame = Math.max(0, order[order.length - 1]! + reads - YOUTUBE_HOLD_READ_SEC);
    pieces.push({ inSec: round(lastFrame), durationSec: round(len), hold: true });
  }
  if (count > order.length) {
    notes.push(
      `the source holds ${order.length} distinct ${len.toFixed(2)}s window(s) for ${count} piece(s) — ` +
        `${count - order.length} hold the last frame instead of a repeat`
    );
  }

  if (Math.abs(pieces[0]!.inSec - params.inSec) > EPS) {
    notes.push(`in-point moved ${params.inSec.toFixed(2)}s → ${pieces[0]!.inSec.toFixed(2)}s so the piece holds no cut`);
  }
  return { pieces, notes, distinct: Math.min(count, order.length) };
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
  /** A shot beside a YouTube clip that may take its time: not YouTube, not off, not a card's invisible ground. */
  const mayTakeTime = (c: TimelineVideoClip, id = c.id) => !params.youtube.has(id) && !c.disabled && !isCardBackdrop(c);
  const sameScene = (a: TimelineVideoClip, b: TimelineVideoClip) =>
    a.sceneIndex != null && a.sceneIndex === b.sceneIndex;
  const dur = (c: TimelineVideoClip) => c.timelineEnd - c.timelineStart;
  /**
   * VIDEO 651 — the neighbour's picture may only run on under ITS OWN sentence. Render 651: s1b1's
   * 5.51 s YouTube clip was cut to 5 s and s1b0's clip held 0.51 s longer into s1b1, so s1b1
   * showed another sentence's picture and the delivery gate refused the film. A neighbour of a
   * different sentence does not take the time; the clip is cut into pieces (step 2) instead.
   */
  const sameSentence = (a: TimelineVideoClip, b: TimelineVideoClip) =>
    !(typeof a.beatIndex === "number" && typeof b.beatIndex === "number" && a.beatIndex !== b.beatIndex);
  /**
   * VIDEO 651 (job 56) — and only time its OWN source can fill. Render-job 56: s1b4's clip, 4.00 s
   * of source, was handed 2.07 s by s1b3's YouTube clip; at 8.40 s on screen even the long-shot
   * rule's slowest speed (`MIN_PIECE_SPEED`) ran out and its last 0.40 s held a still frame. A
   * neighbour takes the time only when its source window, played no slower than that, covers its
   * new length. A still has no source end; a clip whose window was never set keeps the old rule.
   */
  const canAbsorb = (c: TimelineVideoClip, extraSec: number) => {
    if (c.kind === "image" || c.sourceOut == null) return true;
    const window = c.sourceOut - (c.sourceIn ?? 0);
    const slowest = c.speed != null && Math.abs(c.speed - 1) > EPS ? c.speed : MIN_PIECE_SPEED;
    return dur(c) + extraSec <= window / slowest + EPS;
  };
  /** May this neighbour take `extraSec` of `clip`'s slot: not YouTube, same scene, same sentence, and its own source fills it. */
  const mayTake = (clip: TimelineVideoClip, n: TimelineVideoClip | undefined, extraSec: number, id?: string): n is TimelineVideoClip =>
    !!n && mayTakeTime(n, id ?? n.id) && sameScene(clip, n) && sameSentence(clip, n) && canAbsorb(n, extraSec);

  /* 1 — give the time over 5 s to the neighbouring non-YouTube shot in the same scene and sentence. */
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    if (!isYoutube(clip) || clip.disabled || dur(clip) <= maxSec + EPS) continue;
    const next = clips[i + 1];
    const prev = clips[i - 1];
    const excess = dur(clip) - maxSec;
    if (mayTake(clip, next, excess)) {
      const cut = round(clip.timelineStart + maxSec);
      notes.push(
        `${clip.id}: ${dur(clip).toFixed(2)}s of YouTube → ${maxSec}s; ${next.id} starts ` +
          `${excess.toFixed(2)}s earlier to fill it`
      );
      clip.timelineEnd = cut;
      next.timelineStart = cut;
    } else if (mayTake(clip, prev, excess)) {
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
      if (mayTake(clip, prevOut, dur(clip), prevOut?.id.replace(/_p\d+$/, ""))) {
        prevOut.timelineEnd = clip.timelineEnd;
        adjustedIds.push(clip.id);
        notes.push(`${clip.id}: REFUSED (${plan.refused}) — ${prevOut.id} holds ${dur(clip).toFixed(2)}s longer instead`);
        continue;
      }
      if (mayTake(clip, next, dur(clip))) {
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
    /**
     * VIDEO 622 — the same 4 s of a YouTube video played four times in a row: the source held one
     * window and the slot asked for four. The same seconds are never shown twice; the time the
     * source cannot fill with different footage goes to the shot beside it in the same scene. Only
     * when there is none do the pieces play slower, and past that hold their last frame (VIDEO 656).
     */
    const distinct = plan.distinct ?? plan.pieces.length;
    if (distinct < plan.pieces.length) {
      const give = round(plan.pieces.slice(distinct).reduce((sum, p) => sum + p.durationSec, 0));
      const prevOut = out[out.length - 1];
      const next = clips[i + 1];
      /** VIDEO 651 (job 56) — only a neighbour of the same sentence whose own source fills the time. */
      const takesTime = (c: TimelineVideoClip | undefined, id?: string) => mayTake(clip, c, give, id);
      if (takesTime(prevOut, prevOut?.id.replace(/_p\d+$/, ""))) {
        clip.timelineStart = round(clip.timelineStart + give);
        prevOut!.timelineEnd = clip.timelineStart;
        notes.push(`${clip.id}: no repeat — ${prevOut!.id} holds ${give.toFixed(2)}s longer instead`);
        plan.pieces = plan.pieces.slice(0, distinct);
      } else if (takesTime(next)) {
        clip.timelineEnd = round(clip.timelineEnd - give);
        next!.timelineStart = clip.timelineEnd;
        notes.push(`${clip.id}: no repeat — ${next!.id} starts ${give.toFixed(2)}s earlier instead`);
        plan.pieces = plan.pieces.slice(0, distinct);
      } else {
        /**
         * VIDEO 636 — no shot beside it may take the time (in 636 both neighbours were the invisible
         * ground under a card), so the pieces are played slower instead of repeating a window.
         */
        const slowed = planYoutubePieces({
          inSec: clip.sourceIn ?? 0,
          durationSec: dur(clip),
          facts,
          maxSec,
          slowRatherThanRepeat: true,
        });
        const moving = slowed.distinct ?? 0;
        if (!slowed.refused && slowed.pieces.length > 0 && moving > distinct) {
          notes.push(
            `${clip.id}: no repeat — no shot beside it can take the time; ${moving} piece(s) played at ` +
              `${slowed.pieces[0]!.speed ?? 1}× from different footage` +
              (moving < slowed.pieces.length ? `, ${slowed.pieces.length - moving} hold the last frame` : "")
          );
          plan.pieces = slowed.pieces;
        }
      }
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
        sourceOut: round(p.inSec + (p.hold ? YOUTUBE_HOLD_READ_SEC : (end - at) * (p.speed ?? 1))),
        timelineStart: round(at),
        timelineEnd: end,
        ...(p.speed != null ? { speed: p.speed } : {}),
      };
      /** VIDEO 656 — a held piece reads one frame and holds it; every other piece reads its own window. */
      if (p.hold) {
        piece.holdAtSourceOut = true;
        delete piece.speed;
      } else {
        delete piece.holdAtSourceOut;
      }
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
