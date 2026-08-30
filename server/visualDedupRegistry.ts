/**
 * RONDE 132 §2/§11/§12 — one question, asked of every identity a picture has.
 *
 * ── What was already right ───────────────────────────────────────────────────────────────────
 *
 * FastVid does not lack dedup sets. RONDE 34 wrote the scopes down and they are still accurate:
 * `usedContentKeys` is the last line of defence at the adopt point, `usedCuratedAssetIds` holds
 * archive rows, `usedCuratedStorageUrls` holds the files behind them, `usedProviderKeys` holds
 * provider+id, `usedFunnelCandidateIds` holds funnel ids. Between them the same footage cannot
 * reach the timeline twice.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────────────────────
 *
 * They are consulted separately, by whichever route happens to be running, and one of them is not
 * written by the route that does most of the work:
 *
 *     dedup.usedCuratedAssetIds.add(...)   ← exactly ONE call site, the older archive scan
 *     dedup.usedFunnelCandidateIds.add(...) ← the funnel, four call sites
 *
 * The funnel is the primary path. So an archive asset adopted through the funnel was never
 * recorded as a used ARCHIVE ASSET — only as a used funnel candidate. Everything that asks the
 * archive-asset question therefore could not see it:
 *
 *   · the older archive scan (`usedCuratedAssetIds.has(...)`) would re-offer it,
 *   · and RONDE 131's persistent search memory, whose exclude set is exactly that Set, could hand
 *     it straight back to a later beat — the one thing §11 says memory must never do.
 *
 * `usedContentKeys` still caught it at the adopt point, so the same picture did not ship twice.
 * But it was caught AFTER the download and the vision call, having taken one of the six shortlist
 * slots a beat gets — paid for in budget, and in a slot that could have held a different picture.
 *
 * ── What this module is ──────────────────────────────────────────────────────────────────────
 *
 * A reader and a writer over the sets that already exist. It stores nothing, owns nothing, and
 * replaces nothing: `used()` asks all of them and says which one matched, `mark()` writes to all
 * of them so no route can record a picture under one identity and miss another.
 */

/** Every identity one picture can be known by. All optional — a route supplies what it has. */
export type AssetIdentity = {
  /** Curated archive row id. */
  archiveAssetId?: number | null;
  /** Provider name, e.g. "wikimedia". Meaningful only with providerAssetId. */
  provider?: string | null;
  providerAssetId?: string | null;
  /** `clipContentKey(path)` — the identity the adopt point already dedups on. */
  contentKey?: string | null;
  /** The stored file behind an archive row; two rows can share one. */
  storageUrl?: string | null;
  /** `archive:123` / a pool candidate id. */
  funnelCandidateId?: string | null;
};

/**
 * The render-wide sets, as the caller already holds them.
 *
 * Structural typing on purpose: `VisualDedupState` satisfies this without importing anything from
 * videoPipeline, which must not become a dependency of a module videoPipeline imports.
 */
export type UsedAssetSets = {
  usedContentKeys: Set<string>;
  usedCuratedAssetIds: Set<number>;
  usedCuratedStorageUrls: Set<string>;
  usedProviderKeys: Set<string>;
  usedFunnelCandidateIds: Set<string>;
};

/** Which identity matched, so a log line can say WHY rather than only that it was a duplicate. */
export type DedupMatch =
  | "archive_asset_id"
  | "provider_asset_id"
  | "content_key"
  | "storage_url"
  | "funnel_candidate_id";

export type DedupVerdict = { used: boolean; matchedOn: DedupMatch | null };

/** The same key shape `providerAssetKey` builds, kept here so this module needs no import. */
function providerKey(provider: string, id: string): string {
  return `${provider.trim().toLowerCase()}:${id.trim()}`;
}

/**
 * Has this picture already been used in this video, under ANY of its identities?
 *
 * Order is cheapest-and-most-specific first. `matchedOn` is the identity that answered, which is
 * what makes the rejection line diagnosable: "already used, matched on archive_asset_id" and
 * "already used, matched on storage_url" are two different stories about the archive.
 */
export function assetUsedInVideo(sets: UsedAssetSets, identity: AssetIdentity): DedupVerdict {
  const { archiveAssetId, provider, providerAssetId, contentKey, storageUrl, funnelCandidateId } =
    identity;

  if (archiveAssetId != null && sets.usedCuratedAssetIds.has(archiveAssetId)) {
    return { used: true, matchedOn: "archive_asset_id" };
  }
  if (provider?.trim() && providerAssetId?.trim()) {
    if (sets.usedProviderKeys.has(providerKey(provider, providerAssetId))) {
      return { used: true, matchedOn: "provider_asset_id" };
    }
  }
  if (contentKey?.trim() && sets.usedContentKeys.has(contentKey.trim())) {
    return { used: true, matchedOn: "content_key" };
  }
  if (storageUrl?.trim() && sets.usedCuratedStorageUrls.has(storageUrl.trim())) {
    return { used: true, matchedOn: "storage_url" };
  }
  if (funnelCandidateId?.trim() && sets.usedFunnelCandidateIds.has(funnelCandidateId.trim())) {
    return { used: true, matchedOn: "funnel_candidate_id" };
  }
  return { used: false, matchedOn: null };
}

/**
 * Record every identity this picture has, so no later route can miss one.
 *
 * Writing all of them from one place is the whole point: the leak this fixes was a route that
 * wrote one identity and left the other four empty.
 */
export function markAssetUsedInVideo(sets: UsedAssetSets, identity: AssetIdentity): void {
  const { archiveAssetId, provider, providerAssetId, contentKey, storageUrl, funnelCandidateId } =
    identity;
  if (archiveAssetId != null && Number.isInteger(archiveAssetId)) {
    sets.usedCuratedAssetIds.add(archiveAssetId);
  }
  if (provider?.trim() && providerAssetId?.trim()) {
    sets.usedProviderKeys.add(providerKey(provider, providerAssetId));
  }
  if (contentKey?.trim()) sets.usedContentKeys.add(contentKey.trim());
  if (storageUrl?.trim()) sets.usedCuratedStorageUrls.add(storageUrl.trim());
  if (funnelCandidateId?.trim()) sets.usedFunnelCandidateIds.add(funnelCandidateId.trim());
}

/* ═══════════════════════ counting, so the next render can be compared ═══════════════════════ */

export type VisualDedupStats = {
  /** Distinct pictures that reached the timeline. */
  uniqueAssets: number;
  /** Pictures used a second time because nothing else was available (controlled reuse). */
  reusedAssets: number;
  /** Candidates refused because the video already had them. */
  duplicateAttempts: number;
  /** Per matched identity, so a rise can be attributed rather than guessed at. */
  byMatch: Record<DedupMatch, number>;
};

export function createVisualDedupStats(): VisualDedupStats {
  return {
    uniqueAssets: 0,
    reusedAssets: 0,
    duplicateAttempts: 0,
    byMatch: {
      archive_asset_id: 0,
      provider_asset_id: 0,
      content_key: 0,
      storage_url: 0,
      funnel_candidate_id: 0,
    },
  };
}

export function noteDuplicateAttempt(stats: VisualDedupStats, matchedOn: DedupMatch): void {
  stats.duplicateAttempts++;
  stats.byMatch[matchedOn]++;
}

/** §2's per-rejection line. */
export function formatVisualDedupReject(input: {
  videoId: number | string | null | undefined;
  beat: string;
  asset: string;
  matchedOn: DedupMatch;
}): string {
  return (
    `[VisualDedup] video=${input.videoId ?? "-"} beat=${input.beat} asset=${input.asset} ` +
    `status=REJECTED reason=already_used_in_video matchedOn=${input.matchedOn}`
  );
}

/**
 * §2's controlled-reuse line.
 *
 * Reuse is allowed only when nothing else is left, and when it happens it must be loud: a silent
 * reuse is indistinguishable from the bug this round exists to fix.
 */
export function formatControlledReuse(input: {
  videoId: number | string | null | undefined;
  beat: string;
  asset: string;
  reason: string;
}): string {
  return (
    `[VisualDedup] video=${input.videoId ?? "-"} beat=${input.beat} asset=${input.asset} ` +
    `status=CONTROLLED_REUSE reason=${input.reason}`
  );
}

/** §2's summary line. */
export function formatVisualDedupSummary(
  videoId: number | string | null | undefined,
  stats: VisualDedupStats
): string {
  const matches = (Object.entries(stats.byMatch) as Array<[DedupMatch, number]>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  return (
    `[VisualDedup] video=${videoId ?? "-"} uniqueAssets=${stats.uniqueAssets} ` +
    `reusedAssets=${stats.reusedAssets} duplicateAttempts=${stats.duplicateAttempts}` +
    (matches ? ` (${matches})` : "")
  );
}
