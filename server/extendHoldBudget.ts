/**
 * RONDE 142 — the same picture, extended beat after beat, until it was on screen for 41 seconds.
 *
 * ── The production evidence ──────────────────────────────────────────────────────────────────
 *
 * Video 548, measured off the exported MP4 by the RONDE 133/136 audit:
 *
 *     duration            95.84s
 *     longest still       41.38s at 28.13s
 *     imagesOver5Sec      1
 *     limit               5.00s
 *     passed              NO
 *
 * Forty-three percent of the film was one unchanging picture. The chain, every step of it visible
 * in the worker log:
 *
 *     13 of 15 beats     status=rejected origin=none offered=0
 *          ↓             nothing was found for them at all
 *     extendLastClip     called once per empty beat, on dedup.lastRealClip
 *          ↓             13 unique extend_sXbY clips, route=rescue then route=backfill
 *     the montage        the same source footage, back to back, for 41.38s
 *
 * ── Why the existing protections did not catch it ────────────────────────────────────────────
 *
 * `extendLastClip` is not naive. It loops the source rather than freezing it, and lays a slow
 * zoom over the top precisely so a long hold does not read as a frozen frame — RONDE 111's
 * reasoning, and it is sound for ONE beat.
 *
 * What nothing accounted for is REPETITION ACROSS BEATS. Each call is short and legitimate on its
 * own; `dedup.lastRealClip` does not change while beats keep failing, so beat after beat extends
 * the same footage. Every individual clip passes every individual check, and the viewer sees one
 * picture for most of a minute.
 *
 * The zoom makes it worse rather than better at that length: the step is
 * `(1.12 - 1) / totalFrames`, so the longer the hold the slower the movement — well under what
 * `mpdecimate` counts as a changed frame, which is why the audit measured it as *unchanging*
 * rather than merely repetitive.
 *
 * ── What this module is ──────────────────────────────────────────────────────────────────────
 *
 * A budget, in seconds, for how long one source clip may be carried by extension. It answers one
 * question — "may this beat extend that clip again?" — from the render's own running total.
 *
 * It introduces NO new limit. `stillImageMaxSec()` is RONDE 128's existing five seconds, the same
 * number the still-image policy and the stillness audit already enforce; this applies it to a
 * route that was outside both. It is pure, it has no I/O, and it decides nothing except whether
 * one rescue attempt is allowed to run.
 */

import { stillImageMaxSec } from "./stillImagePolicy";

/**
 * How long one source clip has been carried by extension so far, this render.
 *
 * Render-scoped, held by the caller. Two concurrent renders on one worker must not share a
 * budget — the same reasoning that put the gate state and the mismatch tally on RenderCtx.
 */
export type ExtendHoldState = {
  /** The clip the current run of extensions is built on, or null when no run is open. */
  sourceClipPath: string | null;
  /** Seconds of screen time this source has been given by extension. */
  extendedSec: number;
};

export function createExtendHoldState(): ExtendHoldState {
  return { sourceClipPath: null, extendedSec: 0 };
}

export type ExtendDecision =
  | { allowed: true; wouldTotalSec: number }
  | {
      allowed: false;
      reason: "HOLD_BUDGET_SPENT";
      alreadySec: number;
      requestedSec: number;
      limitSec: number;
    };

/**
 * May this beat extend that clip for another `holdSec`?
 *
 * A new source resets the budget: extending a DIFFERENT clip is a different picture, and the rule
 * is about how long one picture stays on screen, not about how often the rescue route runs.
 *
 * The first extension of a source is always allowed when it fits the limit on its own. What the
 * budget stops is the run — the second, third and thirteenth extension of the same footage.
 */
export function mayExtendAgain(params: {
  state: ExtendHoldState;
  sourceClipPath: string;
  holdSec: number;
  limitSec?: number;
}): ExtendDecision {
  const limitSec = params.limitSec ?? stillImageMaxSec();
  const holdSec = Math.max(0, params.holdSec);
  const already =
    params.state.sourceClipPath === params.sourceClipPath ? params.state.extendedSec : 0;
  const wouldTotalSec = already + holdSec;

  /**
   * A tolerance of one frame at 25fps. The beat's hold is computed from narration timing and
   * lands on awkward fractions; failing a run at 5.001s would be reporting arithmetic as a defect,
   * which is the trap RONDE 130's stillness tolerance was written to avoid.
   */
  if (wouldTotalSec > limitSec + 0.04) {
    return {
      allowed: false,
      reason: "HOLD_BUDGET_SPENT",
      alreadySec: already,
      requestedSec: holdSec,
      limitSec,
    };
  }
  return { allowed: true, wouldTotalSec };
}

/**
 * Record an extension that actually happened.
 *
 * Called only after the clip is adopted, never on the attempt: an extension that failed to build
 * or that the caller rejected put nothing on screen, and charging the budget for it would block a
 * later legitimate one.
 */
export function recordExtension(
  state: ExtendHoldState,
  sourceClipPath: string,
  holdSec: number
): void {
  if (state.sourceClipPath !== sourceClipPath) {
    state.sourceClipPath = sourceClipPath;
    state.extendedSec = 0;
  }
  state.extendedSec += Math.max(0, holdSec);
}

/**
 * A real clip was adopted, so the run is over.
 *
 * The next extension starts from zero even if it happens to land on the same source again, because
 * something else has been on screen in between and the picture did change.
 */
export function resetExtendHold(state: ExtendHoldState): void {
  state.sourceClipPath = null;
  state.extendedSec = 0;
}

/** The line the pipeline logs when it refuses to extend again. */
export function formatExtendRefusal(
  sceneIndex: number,
  beatIndex: number,
  decision: Extract<ExtendDecision, { allowed: false }>
): string {
  return (
    `[Retrieval] s${sceneIndex}b${beatIndex} extendLastClip REFUSED — the same picture has ` +
    `already been held ${decision.alreadySec.toFixed(1)}s and this would add ` +
    `${decision.requestedSec.toFixed(1)}s, past the ${decision.limitSec.toFixed(1)}s limit`
  );
}
