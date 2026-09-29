/**
 * RONDE 170 — the same asset must not turn up twice in one video without a reason.
 *
 * ── The complaint this exists for ────────────────────────────────────────────────────────────
 *
 * "Ik zie in de logs van de render dezelfde beelden." Two very different things produce that, and
 * a duplicate guard is only useful if it can tell them apart:
 *
 *   A. THE SAME ASSET, chosen twice. `wikimedia:File_X` at beat 3 and again at beat 9. A real
 *      defect: the viewer sees the identical shot come back.
 *   B. DIFFERENT ASSETS THAT LOOK ALIKE. Two archive clips of the same building from the same
 *      afternoon, with near-identical titles. Not a defect of this layer at all — the assets
 *      really are different, and a guard keyed on identity must not pretend otherwise.
 *
 * This answers A, exactly and only. `sameAsset` is `provider:providerAssetId`, which is what the
 * lineage ledger, the timeline and the rehydrator all already use to mean "this one asset".
 *
 * ── RULE 7: relevance beats diversity ────────────────────────────────────────────────────────
 *
 * The penalty is a PENALTY, not a veto. A clip that is genuinely about the beat and happens to
 * repeat still beats a clip about something else entirely — the brief is explicit that a perfect
 * relevant clip must not lose to an irrelevant new one. What the penalty does is settle the case
 * the ranking would otherwise decide by a hair: two comparably good candidates, one already used.
 *
 * And when there is genuinely nothing else, the duplicate is ALLOWED and the reason is recorded.
 * §8: "Als geen alternatief bestaat → duplicate toegestaan → expliciet loggen waarom." Searching
 * forever for an alternative that does not exist is worse than repeating a shot and saying so.
 */

/** What has already been used in this video, at the granularity the guard reasons about. */
export type UsageLedger = {
  /** `provider:providerAssetId` for every asset already adopted in this video. */
  assets: Map<string, UsageRecord[]>;
  /** How many clips each provider has supplied, for the same-source tiebreak. */
  providers: Map<string, number>;
};

export type UsageRecord = { sceneIndex: number; beatIndex: number };

export type AssetIdentityLike = {
  provider?: string | null;
  providerAssetId?: string | null;
  archiveAssetId?: number | null;
};

export function newLedger(): UsageLedger {
  return { assets: new Map(), providers: new Map() };
}

/**
 * The key that means "this one asset".
 *
 * Returns null when the identity proves nothing — and a null key is NEVER treated as a duplicate
 * of another null key. Two assets nobody could identify are not thereby the same asset, and
 * collapsing them would suppress a perfectly good second clip on no evidence.
 */
export function assetKey(identity: AssetIdentityLike | null | undefined): string | null {
  if (!identity) return null;
  const provider = identity.provider?.trim().toLowerCase();
  if (!provider) return null;
  if (identity.providerAssetId?.trim()) return `${provider}:${identity.providerAssetId.trim()}`;
  /** Our own archive row id is as strong an identity as a provider id, and is used the same way. */
  if (identity.archiveAssetId != null) return `${provider}:archive#${identity.archiveAssetId}`;
  return null;
}
