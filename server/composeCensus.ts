/**
 * R194 — THE COMPOSE LIFECYCLE, COUNTED RATHER THAN DESCRIBED.
 *
 * ── What already existed, and what did not ──────────────────────────────────────────────────
 *
 * The three events are real and have been for several rounds. `returnComposed` — documented in
 * `videoPipeline.ts` as "the one place every compose route leaves through" — writes COMPOSE_INPUT
 * for every clip compose was handed, COMPOSE_SELECTED for every clip it kept, and COMPOSE_DROPPED
 * for the rest, and `lifecyclesOf` folds them onto one row per asset.
 *
 * What did not exist is the ARITHMETIC. A per-scene line printed three numbers and nobody added
 * them up across the render, so the one statement that matters —
 *
 *     composeInputs = composeSelected + composeDropped,  and  unresolved = 0
 *
 * — was never made, never checked, and could not fail. A clip that entered compose and left with
 * neither outcome recorded produced a per-scene line whose numbers still looked plausible.
 *
 * ── Why the census reads lifecycles and not the events ──────────────────────────────────────
 *
 * Because a lifecycle is one row per PHYSICAL ASSET, folded across its derivation chain. Compose
 * is handed `_transformed` and `_padded` children constantly, and counting raw events would count
 * one picture two or three times — an invariant that can be broken by a rename is not an
 * invariant. `lifecyclesOf` already answers this exact question and every other audit in this
 * codebase reads it, so there is no second registry here and nothing to keep in step.
 *
 * ── What `unresolved` is, precisely ─────────────────────────────────────────────────────────
 *
 * An asset compose SAW (COMPOSE_INPUT) and about which it said nothing either way. Not "dropped
 * with an unknown reason" — that is a recorded ending and it is counted under `dropped` with
 * reason UNKNOWN, which is the honest answer to a question the pipeline genuinely cannot answer
 * from a diff. `unresolved` is the gap: no ending at all. It is the number the round asks to be
 * zero, and it is zero by construction at today's single exit — which is exactly why it is worth
 * asserting, because the next compose route added is what would break it.
 */
import type { AssetLifecycle } from "./visualSourceLineage";

export type ComposeCensus = {
  /** Assets compose was handed. */
  inputs: number;
  /** Assets compose kept. */
  selected: number;
  /** Assets compose dropped, with an ending recorded. */
  dropped: number;
  /** Assets compose saw and gave no ending at all. The number that must be zero. */
  unresolved: number;
  /** Why the dropped ones went, newest reason per asset, highest count first. */
  byReason: Array<{ reason: string; count: number }>;
  /** The unresolved ones by name, so a non-zero count is actionable rather than alarming. */
  unresolvedAssets: string[];
};

/**
 * Count what compose was handed and what it did with it.
 *
 * Every asset with a COMPOSE_INPUT event lands in exactly one of the three buckets, so the
 * invariant below is a real statement about the render rather than a restatement of the sum.
 */
export function composeCensusOf(lifecycles: readonly AssetLifecycle[]): ComposeCensus {
  const reasons = new Map<string, number>();
  const unresolvedAssets: string[] = [];
  let inputs = 0;
  let selected = 0;
  let dropped = 0;
  let unresolved = 0;

  for (const a of lifecycles) {
    if (!a.composeInput) continue;
    inputs++;
    /**
     * SELECTED is read first, and that ordering is deliberate.
     *
     * A clip kept by one scene's compose and dropped by a later rescue attempt carries both
     * events. Being in the output is the stronger fact — it is what the delivered file is made of
     * — and reading the drop first would report a picture that shipped as a picture that went.
     */
    if (a.composeSelected) {
      selected++;
      continue;
    }
    if (a.composeDropped) {
      dropped++;
      const reason = a.terminalReason || "UNKNOWN";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      continue;
    }
    unresolved++;
    unresolvedAssets.push(`${a.provider}:${a.providerAssetId}`);
  }

  return {
    inputs,
    selected,
    dropped,
    unresolved,
    byReason: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((x, y) => y.count - x.count || x.reason.localeCompare(y.reason)),
    unresolvedAssets,
  };
}

/**
 * The invariant, stated so it can fail.
 *
 * `composeCompleted` comes from the render, because an abandoned compose legitimately leaves its
 * inputs unaccounted for: the scene timed out, the process was killed, no exit ran. Reporting that
 * as a lifecycle defect would fire the alarm on every timeout and teach a reader to ignore it.
 * §11's rule, in one line: no fake DROPPED for a compose crash.
 */
export function composeCensusViolations(
  census: ComposeCensus,
  opts: { composeCompleted: boolean }
): string[] {
  const out: string[] = [];
  if (census.inputs !== census.selected + census.dropped + census.unresolved) {
    /** Cannot happen while the three buckets are exclusive — asserted so a fourth bucket cannot. */
    out.push(
      `[COMPOSE_INVARIANT] BUCKETS_DO_NOT_SUM inputs=${census.inputs} ` +
        `selected=${census.selected} dropped=${census.dropped} unresolved=${census.unresolved}`
    );
  }
  if (opts.composeCompleted && census.unresolved > 0) {
    out.push(
      `[COMPOSE_INVARIANT] COMPOSE_UNRESOLVED_INPUTS unresolved=${census.unresolved} ` +
        `inputs=${census.inputs} assets=${census.unresolvedAssets.slice(0, 8).join(",")} — ` +
        `compose was handed these and recorded neither COMPOSE_SELECTED nor COMPOSE_DROPPED`
    );
  }
  return out;
}

/** The render-level line. Printed even when everything is fine — a zero here is information. */
export function formatComposeCensus(census: ComposeCensus): string[] {
  const lines = [
    `[ComposeLifecycle] composeInputs=${census.inputs} composeSelected=${census.selected} ` +
      `composeDropped=${census.dropped} composeUnresolved=${census.unresolved} ` +
      `outcomeInvariant=${census.inputs === census.selected + census.dropped ? "PASS" : "FAIL"}`,
  ];
  if (census.byReason.length > 0) {
    lines.push(
      `[ComposeLifecycle] droppedReasons=${census.byReason
        .map((r) => `${r.reason}×${r.count}`)
        .join(",")}`
    );
  }
  return lines;
}
