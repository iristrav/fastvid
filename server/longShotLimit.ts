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
 *
 * VIDEO 624 — A PIECE NEVER RUNS PAST THE SOURCE IT WAS GIVEN. A 3.4 s archive shot was held for
 * 24 s and cut into five pieces of 4.8 s whose in-points ran 4.8, 9.6, 14.4 s into a file that
 * ended at 3.4 s: the renderer showed a frozen frame and jumped, and the cut check found picture
 * changes inside shots at exactly those moments. The planner's own window — `sourceIn` to
 * `sourceOut`, which it never sets past the file — is now the stretch the pieces come from: a
 * shot on screen longer than that window is cut into pieces no longer than it, and a piece that
 * would run past its end starts again at the window's beginning, with its own camera move.
 */
import type { ClipCamera, TimelineVideoClip } from "./projectTimeline";

export const MAX_SHOT_SEC = 6;
const EPS = 0.001;
const round = (n: number) => Number(n.toFixed(3));

/**
 * The move a piece makes, by its place in the shot: in, out, in, … around a slightly offset centre.
 *
 * VIDEO 626 — slow: 6% over the piece and a drift of 2% of the frame, so a move reads as the camera
 * breathing rather than as a zoom. It was 10% and 4%.
 */
export const PIECE_ZOOM = 1.06;
export function pieceCamera(k: number): ClipCamera {
  const inward = k % 2 === 1;
  const drift = k % 4 < 2 ? 0.48 : 0.52;
  return {
    type: inward ? "slow_push" : "slow_pull",
    startScale: inward ? 1.0 : PIECE_ZOOM,
    endScale: inward ? PIECE_ZOOM : 1.0,
    startX: 0.5,
    startY: 0.5,
    endX: drift,
    endY: 0.49,
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
    const inSec = clip.sourceIn ?? 0;
    /** The stretch of source the planner chose; null when it did not say where it ends. */
    const window =
      clip.kind === "video" && clip.sourceOut != null && clip.sourceOut - inSec > EPS ? clip.sourceOut - inSec : null;
    const pastItsSource = window != null && dur > window + EPS;
    /** A shot the user edited is theirs; a piece an earlier rule cut is already short. */
    if (clip.disabled || clip.editedByUser || (dur <= maxSec + EPS && !pastItsSource)) {
      out.push(clip);
      continue;
    }
    const count = Math.max(2, Math.ceil(dur / maxSec - EPS), window != null ? Math.ceil(dur / window - EPS) : 0);
    const len = dur / count;
    adjustedIds.push(clip.id);
    notes.push(
      `${clip.id}: ${dur.toFixed(2)}s on screen → ${count} pieces of ${len.toFixed(2)}s, each moving` +
        (pastItsSource ? ` — its source holds ${window!.toFixed(2)}s, and no piece runs past it` : "")
    );
    let at = clip.timelineStart;
    for (let k = 0; k < count; k++) {
      const last = k === count - 1;
      const end = last ? clip.timelineEnd : round(at + len);
      let offset = k * len;
      if (window != null) {
        offset %= window;
        if (offset + (end - at) > window + EPS) offset = 0;
      }
      const pieceIn = round(inSec + offset);
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
