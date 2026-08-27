/**
 * RONDE 123 — a scene twice as long got exactly as long to find its pictures.
 *
 * From the worker log of video 544:
 *
 *     Scene 0   clips=4   dur=20.0s    visuals (all beats):  60.8s
 *     Scene 1   clips=1   dur=38.1s    visuals (all beats): 180.0s   ← the ceiling, to the tenth
 *     Scene 2   clips=4   dur=21.4s    visuals (all beats):  86.0s
 *
 * 180.0 is `sceneVisualTimeoutMs`, and it is flat: every scene in a render gets the same number
 * regardless of how much film it has to cover or how many beats it has to cover it with. Scene 1
 * was nearly twice the length of the other two, and it stopped searching not because it had run
 * out of material but because it had run out of clock. What reached compose was one 2.8-second
 * clip for 38.1 seconds of narration — and from there the coverage chain could only cap the
 * slow-motion at 2x, exactly as RONDE 111 requires, and hold a frame for the remaining 30.9s.
 *
 * The same log shows what the ceiling actually cut off:
 *
 *     12x  "Wikimedia search failed: Aborted — cancelled by the enclosing scene budget"
 *     54x  "cancelled by the enclosing scene budget before its own timeout —
 *           the request itself did not time out"
 *
 * Fifty-four requests that were still healthy when the scene's clock stopped them.
 *
 * ── Why lengthening this is safe ─────────────────────────────────────────────────────────────
 *
 * Scenes are searched in PARALLEL (`sceneParallelism`, 4 on Railway). In this render there were
 * three scenes, so all three ran at once and two of them were finished after 86 seconds while the
 * third was still being held to the same ceiling. Giving the long scene more time costs no wall
 * clock at all while the short ones are already done — the render's real limit is the slowest
 * scene, and starving the slowest scene is precisely how you make it the slowest.
 *
 * The whole-render ceiling is unchanged and still enforced above this. This only decides how the
 * per-scene share is cut.
 */

/** Never less than this, however short the scene — a scene still has to reach its providers. */
export const SCENE_SEARCH_MIN_MS = 60_000;

/**
 * Never more than 2.5x the flat ceiling.
 *
 * A bound rather than an unbounded formula: a script with one enormous scene must not be able to
 * spend the entire render on it, and the outer render budget assumes each scene eventually ends.
 */
export const SCENE_SEARCH_MAX_FACTOR = 2.5;

/**
 * The scene length the flat budget was implicitly written for.
 *
 * Not a guess: it is the average scene length across a short render, and it makes this function a
 * no-op for the scenes the old number already suited. A 20-second scene keeps its 180 seconds.
 */
export const SCENE_SEARCH_BASELINE_SEC = 22;

/** Additional time granted per beat beyond the baseline count, since each beat is its own search. */
export const SCENE_SEARCH_MS_PER_EXTRA_BEAT = 12_000;
export const SCENE_SEARCH_BASELINE_BEATS = 4;

/**
 * How long this particular scene may spend finding pictures.
 *
 * Two independent claims on the clock, because they are independent facts:
 *
 *  · DURATION — a 38-second scene needs roughly twice the footage of a 20-second one, so it needs
 *    roughly twice the searching. Scaled linearly against the baseline.
 *  · BEATS — each beat is a separate search with its own providers and downloads. A scene with
 *    nine beats does more than twice the work of one with four, whatever their durations.
 *
 * The larger of the two wins rather than their product: they overlap heavily (a long scene tends
 * to have more beats), and multiplying them would compound the same fact twice.
 *
 * @param flatMs the profile's `sceneVisualTimeoutMs` — this function scales that, it does not
 *   replace it, so every profile keeps its own character.
 */
export function sceneSearchBudgetMs(params: {
  flatMs: number;
  sceneDurationSec: number;
  beatCount?: number;
}): number {
  const { flatMs } = params;
  if (!(flatMs > 0)) return SCENE_SEARCH_MIN_MS;

  const durationSec = Number.isFinite(params.sceneDurationSec) ? params.sceneDurationSec : 0;
  const beats = Number.isFinite(params.beatCount ?? NaN) ? Math.max(0, params.beatCount!) : 0;

  const byDuration =
    durationSec > SCENE_SEARCH_BASELINE_SEC
      ? flatMs * (durationSec / SCENE_SEARCH_BASELINE_SEC)
      : flatMs;

  const extraBeats = Math.max(0, beats - SCENE_SEARCH_BASELINE_BEATS);
  const byBeats = flatMs + extraBeats * SCENE_SEARCH_MS_PER_EXTRA_BEAT;

  const wanted = Math.max(byDuration, byBeats);
  const ceiling = flatMs * SCENE_SEARCH_MAX_FACTOR;
  return Math.round(Math.max(SCENE_SEARCH_MIN_MS, Math.min(wanted, ceiling)));
}

/** One line, printed only when a scene actually gets more than the flat share. */
export function formatSceneSearchBudget(
  sceneIndex: number,
  flatMs: number,
  grantedMs: number,
  sceneDurationSec: number,
  beatCount?: number
): string {
  return (
    `[SceneBudget] scene ${sceneIndex}: ${(grantedMs / 1000).toFixed(0)}s to find visuals ` +
    `(flat share ${(flatMs / 1000).toFixed(0)}s) — ${sceneDurationSec.toFixed(1)}s of narration` +
    (beatCount ? `, ${beatCount} beat(s)` : "")
  );
}
