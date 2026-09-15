/**
 * RONDE 251 — WHAT A BATCH OF PROVIDER QUERIES PROVED ABOUT THE PROVIDER.
 *
 * ── The failure this exists for ─────────────────────────────────────────────────────────────
 *
 * GDELT has had a breaker since RONDE 19: three consecutive search failures park it for three
 * minutes instead of re-paying 22 seconds a query on every beat. Render 584 spent roughly eighty
 * seconds on it in one eight-minute window and the breaker fired zero times.
 *
 * The reason was the accounting, not the breaker. The call recorded "reachable" whenever the fetch
 * returned WITHOUT THROWING — which includes a non-ok status, an unparseable body, and GDELT's own
 * "must contain at least one station" refusal of a query we had malformed. One of those, arriving
 * fast beside three queries sitting in their timeout, reset the streak for the whole batch.
 *
 * A breaker a malformed query can reset is a breaker that never closes. This pipeline has met that
 * shape before: `[ClipValidation] OK` on checks that could not fail, and `provider unavailable
 * (no capacity)` on an account that was blocked. Each time, the check existed and was fed
 * something that did not mean what it was read as meaning.
 *
 * ── Why three outcomes and not two ──────────────────────────────────────────────────────────
 *
 * "Did it answer" cannot separate the two ways a batch can come back empty, and they call for
 * opposite responses:
 *
 *   · SERVED  — parseable data arrived, an empty result set included. The provider works.
 *   · FAULT   — it timed out, answered non-ok, or sent a body that is not JSON. Its problem.
 *   · REFUSED — it answered that OUR query was unusable. Our problem, and evidence about nothing:
 *               it neither proves the endpoint healthy nor accuses it.
 *
 * Folding REFUSED into either of the others is what went wrong. Folded into SERVED it resets a
 * breaker that should be closing; folded into FAULT it would park a healthy provider because we
 * sent it a bad question.
 *
 * ── Why this is a module ────────────────────────────────────────────────────────────────────
 *
 * The rule lives in a pure function so "a refusal beside three timeouts does not reset the streak"
 * is a fact a test can prove, rather than a comment beside a network call no test can reach.
 */

/** What a single batch of queries to one provider actually produced. */
export type ProviderBatchOutcome = {
  /** At least one query came back with parseable data — zero results still counts. */
  served: boolean;
  /** At least one query timed out, answered non-ok, or returned an unusable body. */
  fault: boolean;
  /** At least one query was rejected by the provider as malformed — our fault, not theirs. */
  refused: boolean;
};

/** What the batch should do to the provider's failure streak. */
export type BreakerVerdict =
  /** The provider served us. Clear the streak. */
  | "reset"
  /** The provider cost us and gave nothing. Move it toward its cooldown. */
  | "advance"
  /** Nothing was learned — all refusals, or all cache hits. Leave the streak where it is. */
  | "untouched";

/**
 * SERVED beats FAULT beats REFUSED.
 *
 * Evidence that the provider works outranks evidence that it is broken, because a provider that
 * answered one real question is up whatever else happened in the same batch. Both outrank a
 * refusal, which is a statement about our query.
 */
export function breakerVerdictForBatch(outcome: ProviderBatchOutcome): BreakerVerdict {
  if (outcome.served) return "reset";
  if (outcome.fault) return "advance";
  return "untouched";
}
