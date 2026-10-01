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
 * ONE ROUTE — the one owner of "has this video already used this picture?". The asset identities
 * (path, content key, archive row, stored file, provider id) and the segment identity (which
 * seconds of a source) are written only by `markAssetUsedInVideo` and asked only through
 * `assetUsedInVideo`, so no route can record a picture under one identity and miss another.
 * Usage DIVERSITY — preferring what was used less — is a different question, owned by
 * `usageDiversity.ts`.
 */

/** Every identity one picture can be known by. All optional — a route supplies what it has. */
export type AssetIdentity = {
  /** The local file. The cheapest identity, and the weakest: a copy has another path. */
  path?: string | null;
  /** `clipContentKey(path)` — the identity the adopt point already dedups on. */
  contentKey?: string | null;
  /** Curated archive row id. */
  archiveAssetId?: number | null;
  /** The stored file behind an archive row; two rows can share one. */
  storageUrl?: string | null;
  /** Provider name, e.g. "wikimedia". Meaningful only with providerAssetId. */
  provider?: string | null;
  providerAssetId?: string | null;
};

/**
 * ONE ROUTE — the render-wide sets, as the caller already holds them. This module is their one
 * writer (`markAssetUsedInVideo`) and their one reader (`assetUsedInVideo`).
 *
 * A provider identity is stored in `usedContentKeys`, in the `provider:hash` form clipContentKey
 * recovers from a downloaded file's name — the one set the suppliers' own pre-download check
 * (`providerAssetAlreadyUsed`) reads. The separate provider/funnel/fingerprint sets that used to
 * sit beside it had no writer left and are gone.
 *
 * Structural typing on purpose: `VisualDedupState` satisfies this without importing anything from
 * videoPipeline, which must not become a dependency of a module videoPipeline imports.
 */
export type UsedAssetSets = {
  usedPaths: Set<string>;
  usedContentKeys: Set<string>;
  usedCuratedAssetIds: Set<number>;
  usedCuratedStorageUrls: Set<string>;
};

/** Which identity matched, so a log line can say WHY rather than only that it was a duplicate. */
export type DedupMatch =
  | "path"
  | "archive_asset_id"
  | "provider_asset_id"
  | "content_key"
  | "segment_overlap"
  | "storage_url";

import { createHash } from "crypto";

/**
 * RONDE 135 — the one key format `usedProviderKeys` is written and read with.
 *
 * ── The bug this replaces ────────────────────────────────────────────────────────────────────
 *
 * `usedProviderKeys` had exactly one writer and exactly one reader, and they did not agree:
 *
 *     WRITE (here, RONDE 132)          `${provider.toLowerCase()}:${id}`          raw
 *     READ  (providerAssetAlreadyUsed) `${provider}:${sha256(id).slice(0,16)}`    hashed
 *
 * So the Set was filled with `wikimedia:File:Bundesarchiv_Bild_183.webm` while every reader asked
 * for `wikimedia:a1b2c3d4e5f6a7b8`. The lookup could never succeed — not once, for any asset, in
 * any render.
 *
 * The consequence is precisely the thing the early-exclusion mechanism exists to prevent. Nine
 * provider routes call providerAssetAlreadyUsed BEFORE downloading, which is the cheap place to
 * drop a picture the video already has. That check silently answered "no" every time, so an asset
 * the funnel had already adopted was searched again, downloaded again, and judged by Vision again
 * — and was only stopped at the very end by `usedContentKeys` at the adopt point. Nothing shipped
 * twice, so the fault was invisible in the output; what it cost was a download, a vision call and
 * one of the beat's six shortlist slots, every time.
 *
 * ── Why the hashed form wins ─────────────────────────────────────────────────────────────────
 *
 * providerAssetKey is not just a dedup key. The same string is the sourcing cache's asset key, and
 * it is embedded into downloaded filenames (tagPathWithProviderAsset) so clipContentKey can
 * recover the provider identity from a path alone. A raw provider id cannot do that: ids contain
 * colons, slashes and spaces. So the reader's format is the one that has to survive, and this
 * writer adopts it.
 *
 * It lives here because this module is the dedup identity and videoPipeline already imports from
 * it — the other direction would be a cycle.
 */
export function providerAssetIdentityKey(provider: string, id: string): string {
  const hash = createHash("sha256").update(id.trim()).digest("hex").slice(0, 16);
  /**
   * The provider is lower-cased, which the pipeline's own copy did not do.
   *
   * That is not a tidy-up: RONDE 132 guards it with a test that marks an asset as "wikimedia" and
   * asks about it as "WIKIMEDIA", because two routes really do spell a provider differently and a
   * dedup set that answers "no" to the same picture under a different capitalisation is a dedup
   * set that does not work. Unifying the two key functions had to keep the stricter of the two
   * behaviours, not the more convenient one. In practice every call site passes a lower-case
   * literal, so no existing key changes shape.
   */
  return `${provider.trim().toLowerCase()}:${hash}`;
}

function providerKey(provider: string, id: string): string {
  return providerAssetIdentityKey(provider, id);
}

/**
 * Record every identity this picture has, so no later route can miss one.
 *
 * Writing all of them from one place is the whole point: the leak this fixes was a route that
 * wrote one identity and left the others empty.
 */
export function markAssetUsedInVideo(sets: UsedAssetSets, identity: AssetIdentity): void {
  const { path, contentKey, archiveAssetId, storageUrl, provider, providerAssetId } = identity;
  const key = contentKey?.trim();
  if (path?.trim()) sets.usedPaths.add(path);
  if (key) sets.usedContentKeys.add(key);
  if (archiveAssetId != null && Number.isInteger(archiveAssetId)) {
    sets.usedCuratedAssetIds.add(archiveAssetId);
  }
  if (storageUrl?.trim()) sets.usedCuratedStorageUrls.add(storageUrl.trim());
  if (provider?.trim() && providerAssetId?.trim()) {
    sets.usedContentKeys.add(providerKey(provider, providerAssetId));
  }
}

/**
 * Has this video already used this picture — under ANY identity it has? null when not; otherwise
 * which identity matched. Asking counts nothing: the caller counts a duplicate it actually refuses
 * (`noteDuplicateAttempt`), because a beat may still claim the mark its own adoption just wrote.
 *
 * The segment rule is part of the question: a YouTube fragment whose seconds overlap a fragment
 * this video already used is the same picture, whatever its file is called.
 */
export function assetUsedInVideo(sets: UsedAssetSets, identity: AssetIdentity): DedupMatch | null {
  const { path, contentKey, archiveAssetId, storageUrl, provider, providerAssetId } = identity;
  if (path && sets.usedPaths.has(path)) return "path";
  const key = contentKey?.trim();
  if (key && sets.usedContentKeys.has(key)) return "content_key";
  if (archiveAssetId != null && sets.usedCuratedAssetIds.has(archiveAssetId)) return "archive_asset_id";
  if (storageUrl?.trim() && sets.usedCuratedStorageUrls.has(storageUrl.trim())) return "storage_url";
  if (provider?.trim() && providerAssetId?.trim() && sets.usedContentKeys.has(providerKey(provider, providerAssetId))) {
    return "provider_asset_id";
  }
  if (key && youtubeFragmentSecondsUsed(sets.usedContentKeys, key)) return "segment_overlap";
  return null;
}

/* ═══════════════════════ segment identity: the seconds of a source ═══════════════════════ */

/** Two fragments of one YouTube source that overlap by more than this are the same picture. */
export const YOUTUBE_SECONDS_OVERLAP_TOLERANCE_SEC = 0.25;

const FRAGMENT_KEY_RE = /^(youtube_cc:[0-9a-f]{16})@t(\d+)d(\d+)$/;

/** Would seconds [start, start+duration) of this YouTube video repeat seconds already used? */
export function youtubeSecondsAlreadyUsed(
  usedKeys: ReadonlySet<string> | undefined,
  videoId: string,
  startSec: number,
  durationSec: number
): boolean {
  if (!videoId) return false;
  return secondsOverlapUsed(usedKeys, providerKey("youtube_cc", videoId), startSec, startSec + durationSec);
}

/** The same question for a fragment key (`youtube_cc:<hash>@t<start>d<dur>`), excluding itself. */
export function youtubeFragmentSecondsUsed(usedKeys: ReadonlySet<string> | undefined, fragmentKey: string): boolean {
  const m = FRAGMENT_KEY_RE.exec(fragmentKey);
  if (!m) return false;
  const startSec = Number(m[2]) / 10;
  return secondsOverlapUsed(usedKeys, m[1]!, startSec, startSec + Number(m[3]) / 10, fragmentKey);
}

function secondsOverlapUsed(
  usedKeys: ReadonlySet<string> | undefined,
  videoKey: string,
  startSec: number,
  endSec: number,
  exceptKey?: string
): boolean {
  if (!usedKeys?.size) return false;
  if (usedKeys.has(videoKey)) return true;
  for (const k of usedKeys) {
    if (k === exceptKey || !k.startsWith(`${videoKey}@t`)) continue;
    const m = /@t(\d+)d(\d+)$/.exec(k);
    if (!m) continue;
    const s = Number(m[1]) / 10;
    const e = s + Number(m[2]) / 10;
    if (Math.min(endSec, e) - Math.max(startSec, s) > YOUTUBE_SECONDS_OVERLAP_TOLERANCE_SEC) return true;
  }
  return false;
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
      path: 0,
      archive_asset_id: 0,
      provider_asset_id: 0,
      content_key: 0,
      segment_overlap: 0,
      storage_url: 0,
    },
  };
}

export function noteDuplicateAttempt(stats: VisualDedupStats, matchedOn: DedupMatch): void {
  stats.duplicateAttempts++;
  stats.byMatch[matchedOn]++;
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
