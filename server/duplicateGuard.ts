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

export function recordUse(
  ledger: UsageLedger,
  identity: AssetIdentityLike,
  at: UsageRecord
): UsageLedger {
  const key = assetKey(identity);
  const provider = identity.provider?.trim().toLowerCase();
  if (provider) ledger.providers.set(provider, (ledger.providers.get(provider) ?? 0) + 1);
  if (key) ledger.assets.set(key, [...(ledger.assets.get(key) ?? []), at]);
  return ledger;
}

export type DuplicateScope = "same_beat" | "same_scene" | "same_video";

export type DuplicateVerdict =
  | { duplicate: false }
  | {
      duplicate: true;
      key: string;
      /** Where it was used before — so a log can say "again", not just "duplicate". */
      usedAt: UsageRecord[];
      scope: DuplicateScope;
    };

/**
 * Has this asset been used before in this video, and how close by?
 *
 * The scope matters for how bad it is: the same clip twice inside one beat is a bug, twice in one
 * scene is jarring, twice across a ten-minute video is often fine. The caller decides what to do;
 * this only reports.
 */
export function checkDuplicate(
  ledger: UsageLedger,
  identity: AssetIdentityLike,
  at: UsageRecord
): DuplicateVerdict {
  const key = assetKey(identity);
  if (!key) return { duplicate: false };
  const usedAt = ledger.assets.get(key);
  if (!usedAt || usedAt.length === 0) return { duplicate: false };

  const scope = usedAt.some((u) => u.sceneIndex === at.sceneIndex && u.beatIndex === at.beatIndex)
    ? "same_beat"
    : usedAt.some((u) => u.sceneIndex === at.sceneIndex)
      ? "same_scene"
      : "same_video";
  return { duplicate: true, key, usedAt, scope };
}

/**
 * How much to subtract from a candidate's score for repeating.
 *
 * ── Why these numbers, and why they are small ────────────────────────────────────────────────
 *
 * The ranking engine's scores are 0..1 and its two relevance signals together carry more than half
 * the weight, so a 0.12 penalty settles a near-tie and cannot overturn a real difference in
 * relevance. That is RULE 7 expressed as arithmetic rather than as an intention: a candidate that
 * is 0.3 better on relevance still wins after the penalty, and a candidate that is 0.02 better
 * does not.
 *
 * Same beat is heaviest because it is the one case with no defensible reading — the identical
 * asset twice in the same moment is never an editorial choice.
 */
export const DUPLICATE_PENALTY: Readonly<Record<DuplicateScope, number>> = {
  same_beat: 0.35,
  same_scene: 0.18,
  same_video: 0.12,
};

/** The same provider over and over is a milder problem than the same asset — a nudge, not a penalty. */
export const SAME_PROVIDER_PENALTY = 0.03;

/**
 * Rank a beat's candidates with repetition taken into account.
 *
 * Takes the ORDER the ranking engine produced and adjusts it; it does not re-rank. The engine owns
 * relevance and this owns repetition, which is the only way both RULE 6 and RULE 7 can hold — a
 * second scorer would have opinions about relevance and immediately start disagreeing with the
 * first one.
 */
export function penaliseDuplicates<T>(params: {
  ranked: readonly T[];
  identityOf: (candidate: T) => AssetIdentityLike;
  scoreOf: (candidate: T) => number;
  ledger: UsageLedger;
  at: UsageRecord;
}): Array<{ candidate: T; score: number; penalty: number; verdict: DuplicateVerdict }> {
  const scored = params.ranked.map((candidate) => {
    const identity = params.identityOf(candidate);
    const verdict = checkDuplicate(params.ledger, identity, params.at);
    const provider = identity.provider?.trim().toLowerCase();
    const providerUses = provider ? (params.ledger.providers.get(provider) ?? 0) : 0;

    const penalty =
      (verdict.duplicate ? DUPLICATE_PENALTY[verdict.scope] : 0) +
      (providerUses > 0 ? SAME_PROVIDER_PENALTY : 0);

    return { candidate, score: params.scoreOf(candidate) - penalty, penalty, verdict };
  });

  /**
   * A STABLE sort. Two candidates with equal adjusted scores keep the order the ranking engine
   * gave them, so the same pool always produces the same pick — §32's determinism, and the reason
   * there is no randomisation anywhere in this file.
   */
  return scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (b.s.score - a.s.score) || (a.i - b.i))
    .map(({ s }) => s);
}

/**
 * The line a production log needs to answer "why did this beat repeat a shot".
 *
 * §8's rule: when a duplicate is adopted because there was no alternative, the log says so with
 * the reason. Ids only — never a URL, never a key.
 */
export function formatDuplicateDecision(params: {
  sceneIndex: number;
  beatIndex: number;
  verdict: DuplicateVerdict;
  alternatives: number;
  adopted: boolean;
}): string {
  const where = `s${params.sceneIndex}b${params.beatIndex}`;
  if (!params.verdict.duplicate) {
    return `[Retrieval] ${where} duplicate=false alternatives=${params.alternatives}`;
  }
  const seen = params.verdict.usedAt
    .map((u) => `s${u.sceneIndex}b${u.beatIndex}`)
    .join(",");
  return (
    `[Retrieval] ${where} duplicate=true scope=${params.verdict.scope} asset=${params.verdict.key} ` +
    `firstUsed=${seen} alternatives=${params.alternatives} adopted=${params.adopted} ` +
    `reason=${params.adopted ? (params.alternatives === 0 ? "no_alternative_existed" : "outranked_alternatives") : "rejected_as_duplicate"}`
  );
}
