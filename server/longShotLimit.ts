/**
 * RONDE 651 — NO SHOT STANDS ON SCREEN LONGER THAN SIX SECONDS.
 *
 * Render 607, frame by frame: the same globe for about eleven seconds, a man at a railing for eleven,
 * a photograph of officers in a wood for ten, a near-black bunker corridor for six. The render itself
 * reported seven frozen stretches. Every one of them was a beat without a picture of its own, covered
 * by `holdPictureUnderVoice` stretching the shot before it — and a short source stretched that far is
 * looped by the renderer, so the viewer watches the same seconds again.
 *
 * RONDE 647 already cut YouTube shots at five seconds. This is the same rule for every other shot, at
 * six: a longer shot becomes pieces of equal length, each from the next stretch of its source, and
 * every piece after the first moves — alternately a slow push in and a slow pull out — so a piece that
 * does come round to material already seen is still a different framing, the way an editor punches in
 * on archive that has to hold.
 *
 * Pure. The span the clips cover is unchanged, so the narration, the captions and the scene offsets
 * are untouched. Piece ids follow RONDE 647's `_pN`, so `lostEditorialIntent` reads a split shot as
 * one decision.
 */
import type { ClipCamera, TimelineVideoClip } from "./projectTimeline";

export const MAX_SHOT_SEC = 6;
const EPS = 0.001;
const round = (n: number) => Number(n.toFixed(3));

/** The move a piece makes, by its place in the shot: in, out, in, … around a slightly offset centre. */
export function pieceCamera(k: number): ClipCamera {
  const inward = k % 2 === 1;
  const drift = k % 4 < 2 ? 0.46 : 0.54;
  return {
    type: inward ? "slow_push" : "slow_pull",
    startScale: inward ? 1.0 : 1.1,
    endScale: inward ? 1.1 : 1.0,
    startX: 0.5,
    startY: 0.5,
    endX: drift,
    endY: 0.48,
  };
}

export function limitLongShots(params: {
  clips: readonly TimelineVideoClip[];
  maxSec?: number;
}): { clips: TimelineVideoClip[]; notes: string[]; adjustedIds: string[] } {
  const maxSec = params.maxSec ?? MAX_SHOT_SEC;
  const notes: string[] = [];
  const adjustedIds: string[] = [];
  const out: TimelineVideoClip[] = [];
  for (const clip of params.clips) {
    const dur = clip.timelineEnd - clip.timelineStart;
    /** A shot the user edited is theirs; a piece an earlier rule cut is already short. */
    if (clip.disabled || clip.editedByUser || dur <= maxSec + EPS) {
      out.push(clip);
      continue;
    }
    const count = Math.max(2, Math.ceil(dur / maxSec - EPS));
    const len = dur / count;
    adjustedIds.push(clip.id);
    notes.push(`${clip.id}: ${dur.toFixed(2)}s on screen → ${count} pieces of ${len.toFixed(2)}s, each moving`);
    const inSec = clip.sourceIn ?? 0;
    let at = clip.timelineStart;
    for (let k = 0; k < count; k++) {
      const last = k === count - 1;
      const end = last ? clip.timelineEnd : round(at + len);
      const pieceIn = round(inSec + k * len);
      const piece: TimelineVideoClip = {
        ...clip,
        id: `${clip.id}_p${k + 1}`,
        sourceIn: pieceIn,
        sourceOut: round(pieceIn + (end - at)),
        timelineStart: round(at),
        timelineEnd: end,
      };
      /** The first piece keeps the planner's move; every later one gets its own. */
      if (clip.camera) {
        if (k > 0) piece.camera = pieceCamera(k);
      } else {
        piece.camera = pieceCamera(k + 1);
      }
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
    }
  }
  return { clips: out, notes, adjustedIds };
}
