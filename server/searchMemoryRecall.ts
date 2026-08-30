/**
 * RONDE 131 — turning the persistent search memory from a hint into a source of footage.
 *
 * ── The gap ──────────────────────────────────────────────────────────────────────────────────
 *
 * FastVid has had a persistent, cross-video search memory since F3-26: the `visual_search_memory`
 * table, keyed on the canonical entity, upserted with a usage count, and carrying an `assetId`
 * column that names the archive asset a proven query produced. Nothing was missing from the
 * storage. What was missing was any reader that used it.
 *
 *   · `primeQueriesWithSearchMemory` is the only reader on the retrieval path, and it maps proven
 *     rows to `m.query`. Everything else on the row — the asset, the source, the quality score —
 *     is dropped. A memory hit therefore reordered the QUESTIONS and never returned the ANSWER.
 *
 *   · `recordAdoptedClipSource`, the highest-volume writer, wrote no `assetId` at all, and for a
 *     `curated:asset:<id>` winner wrote nothing whatsoever: `providerFromContentKey` excludes
 *     "curated" because it is not a place you can search again. True for a query memory, backwards
 *     for an asset memory — a curated asset is precisely the hit that needs no search next time.
 *
 * So Video B went back to the providers for footage Video A had already found, validated, adopted
 * and stored in FastVid's own archive.
 *
 * ── What this module is, and what it deliberately is not ─────────────────────────────────────
 *
 * It is the recall half of the memory that already exists: entity → proven asset ids → the archive
 * rows for those ids, shaped as ordinary `CuratedCandidatePick`s. It stores nothing, caches
 * nothing and decides nothing.
 *
 * It is NOT a second cache. The layers stay distinct and each keeps its own job:
 *
 *     query cache       per render, in SourcingCache.queries — "did I already ask this?"
 *     PERSISTENT MEMORY across renders, visual_search_memory — "what did asking this ever find?"
 *     asset cache       per render, SourcingCache.assets     — "what do I know about this asset?"
 *     metadata/licence  per asset, existing caches           — "may I use it, and what is it?"
 *     vision cache      process-wide                         — "does it show what the beat needs?"
 *     entity cache      per topic                            — "who is this video about?"
 *
 * ── Why a recalled asset is a candidate and never a verdict ──────────────────────────────────
 *
 * The picks this returns are handed to the retrieval funnel in the same array as any other archive
 * candidate. That is the whole safety argument, and it is structural rather than a promise: a
 * remembered asset is merged, coverage-scored, ranked, shortlisted, downloaded, preview-validated,
 * licence-checked, VisionGate'd, beat-relevance-judged and duplicate-checked by exactly the code
 * that does it for a candidate found a second ago. Nothing here can skip a gate, because nothing
 * here is downstream of one.
 *
 * ── Semantic reuse comes for free, and this is why ───────────────────────────────────────────
 *
 * The memory is keyed on the canonical ENTITY, not on the query string. "Hermann Göring Berlin
 * archival footage" and "Hermann Göring Munich historical footage" are different queries about one
 * entity, so both resolve to `hermann göring` and read the same rows. The recalled assets are then
 * scored against THIS beat's embedding by the funnel's existing
 * `scoreBeatAgainstStoredEmbedding` / stored-embedding path, so the Munich beat is not handed the
 * Berlin footage because a name matched — it is handed a candidate, which then has to earn the
 * beat on the same evidence as everything else.
 */
import { getMediaArchiveAssetsByIds, getMediaArchiveById } from "./db";
import {
  getProvenAssetIdsForEntity,
  type ProvenAssetMemory,
} from "./visualSearchMemory";
import type { ArchiveAssetRow, CuratedCandidatePick } from "./curatedMediaSourcing";

/**
 * How many proven assets one beat may recall.
 *
 * Small on purpose. These enter the funnel alongside the archive's own keyword matches and the
 * providers' results, and the shortlist is six wide (MAX_FUNNEL_CANDIDATES_TO_SCORE). A memory
 * that supplied twenty would not make the beat better, it would make it a memory-only beat —
 * which is how a learning loop turns into a rut.
 */
export const MAX_RECALLED_ASSETS_PER_BEAT = 4;

/**
 * The keyword score a recalled asset enters the funnel with.
 *
 * The funnel normalises archive scores by KEYWORD_SCORE_MAX and adds an embedding boost, so this
 * is a starting position, not a ranking. It is deliberately mid-range: high enough that a proven
 * asset is looked at, low enough that a genuinely better keyword match still outranks it. Being
 * remembered is evidence; it is not a trump card.
 */
export const RECALLED_ASSET_BASE_SCORE = 6;

export type SearchMemoryRecallMetrics = {
  /** Beats that asked the memory and got at least one usable asset back. */
  memoryHits: number;
  /** Beats that asked and got nothing — a genuinely new subject, or an empty table. */
  memoryMisses: number;
  /** Distinct assets handed to the funnel from memory. */
  assetsReused: number;
  /** Recalled assets the funnel or the gates later refused. Counted, never hidden. */
  memoryRejectedAfterValidation: number;
  /** Beats where the recall produced candidates, so a provider round was not the only hope. */
  providerSearchesAvoided: number;
  /** Beats that went to the providers because memory had nothing. */
  newSearches: number;
};

export function createSearchMemoryRecallMetrics(): SearchMemoryRecallMetrics {
  return {
    memoryHits: 0,
    memoryMisses: 0,
    assetsReused: 0,
    memoryRejectedAfterValidation: 0,
    providerSearchesAvoided: 0,
    newSearches: 0,
  };
}

export function searchMemoryCacheHitRate(m: SearchMemoryRecallMetrics): number {
  const asked = m.memoryHits + m.memoryMisses;
  return asked === 0 ? 0 : m.memoryHits / asked;
}

/** The per-beat line the brief asks for. Query is truncated; nothing secret passes through here. */
export function formatSearchMemoryLine(input: {
  query: string;
  hit: boolean;
  provider?: string;
  assets?: number;
  networkAvoided?: boolean;
}): string {
  const parts = [
    `[SearchMemory] query="${input.query.slice(0, 80)}"`,
    `hit=${input.hit}`,
  ];
  if (input.hit) {
    parts.push(`provider=${input.provider ?? "curated_archive"}`);
    parts.push(`assets=${input.assets ?? 0}`);
    parts.push(`networkAvoided=${input.networkAvoided ?? false}`);
  } else {
    parts.push("providerSearch=true");
  }
  return parts.join(" ");
}

/** The end-of-render summary, in the shape the other audit blocks use. */
export function formatSearchMemorySummary(m: SearchMemoryRecallMetrics): string {
  return (
    `[SearchMemory] TOTAL memoryHits=${m.memoryHits} memoryMisses=${m.memoryMisses} ` +
    `assetsReused=${m.assetsReused} memoryRejectedAfterValidation=${m.memoryRejectedAfterValidation} ` +
    `providerSearchesAvoided=${m.providerSearchesAvoided} newSearches=${m.newSearches} ` +
    `cacheHitRate=${(searchMemoryCacheHitRate(m) * 100).toFixed(1)}%`
  );
}

export type RecalledAsset = {
  pick: CuratedCandidatePick;
  memory: ProvenAssetMemory;
};

/**
 * Assets this entity has proven before, as funnel candidates.
 *
 * Returns [] on every failure path — no memory, no database, no surviving assets — because a
 * recall that cannot answer must leave the render exactly as it was rather than fail it.
 */
export async function recallProvenAssetsForEntity(
  entity: string | undefined,
  opts: {
    /** Assets this render has already used, so recall cannot re-serve them. */
    excludeAssetIds?: Set<number>;
    limit?: number;
    /** Injected in tests; production uses the real readers. */
    readMemory?: typeof getProvenAssetIdsForEntity;
    loadAssets?: (ids: number[]) => Promise<ArchiveAssetRow[]>;
    resolveArchiveName?: (archiveId: number) => Promise<string>;
  } = {}
): Promise<RecalledAsset[]> {
  const trimmed = entity?.trim();
  if (!trimmed) return [];

  const limit = opts.limit ?? MAX_RECALLED_ASSETS_PER_BEAT;
  if (limit <= 0) return [];

  try {
    const readMemory = opts.readMemory ?? getProvenAssetIdsForEntity;
    // Read more rows than the beat may use: some of the remembered assets will have been deleted
    // from the archive since, and a beat that recalls four should still get four when it can.
    const remembered = await readMemory(trimmed, Math.max(limit * 3, 12));
    if (remembered.length === 0) return [];

    const wanted = remembered
      .filter((r) => !opts.excludeAssetIds?.has(r.assetId))
      .slice(0, Math.max(limit * 3, 12));
    if (wanted.length === 0) return [];

    const loadAssets = opts.loadAssets ?? getMediaArchiveAssetsByIds;
    const assets = await loadAssets(wanted.map((r) => r.assetId));
    const byId = new Map<number, ArchiveAssetRow>();
    for (const a of assets) byId.set(a.id, a as ArchiveAssetRow);

    const resolveArchiveName =
      opts.resolveArchiveName ??
      (async (archiveId: number) => {
        const archive = await getMediaArchiveById(archiveId);
        return (archive as { name?: string } | undefined)?.name?.trim() || "own_archive";
      });

    const nameCache = new Map<number, string>();
    const out: RecalledAsset[] = [];
    for (const memory of wanted) {
      if (out.length >= limit) break;
      const asset = byId.get(memory.assetId);
      // Deleted, deactivated, or belonging to an archive that is gone. RONDE 127's rule holds
      // without a second mechanism: the asset simply is not there, so it cannot be recalled.
      if (!asset) continue;

      const archiveId = (asset as { archiveId?: number }).archiveId;
      let archiveName = "own_archive";
      if (typeof archiveId === "number") {
        if (!nameCache.has(archiveId)) nameCache.set(archiveId, await resolveArchiveName(archiveId));
        archiveName = nameCache.get(archiveId) ?? "own_archive";
      }

      out.push({
        memory,
        pick: {
          asset,
          archiveName,
          score: RECALLED_ASSET_BASE_SCORE,
        },
      });
    }
    return out;
  } catch (err) {
    console.warn("[SearchMemory] recall failed:", (err as Error).message?.slice(0, 120));
    return [];
  }
}

/**
 * Merge recalled picks into the archive candidates the funnel already found.
 *
 * Recalled assets go AFTER the archive's own matches for this beat, never before: a keyword match
 * against THIS beat is more direct evidence than "it worked for this entity once". They are
 * additive — an asset the archive scan already produced is not duplicated, and nothing the scan
 * found is ever displaced.
 */
export function mergeRecalledIntoArchivePicks(
  archivePicks: CuratedCandidatePick[],
  recalled: RecalledAsset[]
): { picks: CuratedCandidatePick[]; added: number } {
  if (recalled.length === 0) return { picks: archivePicks, added: 0 };
  const have = new Set(archivePicks.map((p) => p.asset.id));
  const additions: CuratedCandidatePick[] = [];
  for (const r of recalled) {
    if (have.has(r.pick.asset.id)) continue;
    have.add(r.pick.asset.id);
    additions.push(r.pick);
  }
  if (additions.length === 0) return { picks: archivePicks, added: 0 };
  return { picks: [...archivePicks, ...additions], added: additions.length };
}
