/**
 * PHASE 1 — retrieval scope and compose eligibility are two different questions.
 *
 * ── The bug, in one line of the pipeline ─────────────────────────────────────────────────────
 *
 *     if (sceneFetchAborted()) return false;
 *
 * inside `montageClipPassesComposeGate`. A scene's fetch scope is a BUDGET FOR LOOKING: when it
 * expires, no new search, download, probe or rescue may start. The line above turned that into a
 * verdict on clips that had already been found — and in video 558 it threw away fourteen of them,
 * ten already-downloaded archive files, every one of which had passed the technical gate, been
 * judged by Vision and been adopted. Scene 1 ended with 2 unique clips for 13 beats.
 *
 * RONDE 138 improved this: on an abandoned scope a clip could still pass on a measurement the
 * render had already taken. That closed the common case and left the principle unstated, so the
 * answer still depended on whether a probe happened to be memoised under this exact path rather
 * than on whether the clip was known to be good.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────────────────────
 *
 *     RETRIEVAL SCOPE          controls whether NEW work may happen
 *     EXISTING ADOPTED ASSETS  remain eligible for compose
 *
 * An expired scope may never mean "this adopted clip is invalid". It means "no new work", and the
 * gate answers from what is already known:
 *
 *   1. the clip was ADOPTED       → pass. Every gate is already behind it.
 *   2. a usable prior measurement → pass. RONDE 138's rule, kept intact.
 *   3. neither                    → fail, WITHOUT probing. Not a judgement that the clip is bad;
 *                                   a refusal to spend work the scope has forbidden.
 *
 * ── What this must not become ────────────────────────────────────────────────────────────────
 *
 * A way for unexamined files to reach the montage. Case 1 asks the ledger about THIS EXACT PATH
 * (see `adoptedAtPath`), so `pad_combined_*.mp4` and the text-overlay output — written moments
 * before the gate and never examined — do not inherit their parent's clearance. Case 3 is what
 * they get, which is the same answer they got before this change.
 *
 * And when the scope is still alive, nothing here applies: the full gate runs exactly as it did.
 */

/** What the gate knows about a clip without doing any new work. */
export type ComposeScopeInput = {
  /** Has the scene's retrieval scope expired? */
  scopeAborted: boolean;
  /** Does the lineage ledger record an ADOPTED event for this exact path? */
  adopted: boolean;
  /**
   * A measurement this render already took for this exact file, or null.
   *
   * Null means "not measured", never "measured as bad" — the distinction the whole round is about.
   */
  priorMeasurementUsable: boolean | null;
};

export type ComposeScopeVerdict =
  /** The scope is alive: run the full gate, unchanged. */
  | { decision: "run_full_gate" }
  /** Answered from what was already known; no new work was done. */
  | { decision: "pass"; basis: "already_adopted" | "prior_measurement" }
  /** The scope forbids the work needed to answer, and nothing already known answers it. */
  | { decision: "fail"; basis: "scope_abandoned_unmeasured" };
