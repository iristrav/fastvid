

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
