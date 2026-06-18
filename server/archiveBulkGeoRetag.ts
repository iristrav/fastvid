/**
 * Bulk geo-retag existing archive assets from title/tags/sourceNote (no LLM required).
 */
import {
  getMediaArchiveAssetById,
  getMediaArchiveAssets,
  updateMediaArchiveAsset,
  filterMediaArchiveAssets,
} from "./db";
import { indexArchiveAssetEmbedding } from "./archiveEmbeddingIndex";
import {
  appendMapLabelsToSourceNote,
  extractGeoSlugsFromVisionPayload,
  mergeGeoSlugsIntoArchiveTags,
} from "./archiveGeoTagging";
import { ARCHIVE_MAX_TAGS } from "./archiveAssetTagging";

export type BulkGeoRetagResult = {
  processed: number;
  updated: number;
  skipped: number;
  sampleUpdate?: { id: number; tags: string[] };
};

function parseMapLabelsFromSourceNote(sourceNote?: string | null): string[] {
  if (!sourceNote?.trim()) return [];
  const m = sourceNote.match(/Map labels:\s*([^|]+)/i);
  if (!m?.[1]) return [];
  return m[1]
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/** Re-extract geo slugs from stored metadata and merge into tags. */
export async function retagArchiveAssetGeoFromMetadata(assetId: number): Promise<boolean> {
  const asset = await getMediaArchiveAssetById(assetId);
  if (!asset) return false;

  const mapLabels = parseMapLabelsFromSourceNote(asset.sourceNote);
  const geoSlugs = extractGeoSlugsFromVisionPayload({
    title: [asset.title ?? "", ...(asset.tags ?? [])].join(" "),
    description: asset.sourceNote ?? "",
    mapLabels,
    visibleTextOnScreen: mapLabels,
  });

  if (geoSlugs.length === 0) return false;

  const mergedTags = mergeGeoSlugsIntoArchiveTags(asset.tags ?? [], geoSlugs, ARCHIVE_MAX_TAGS);
  const sourceNote = appendMapLabelsToSourceNote(asset.sourceNote, mapLabels, geoSlugs);

  const changed =
    JSON.stringify(mergedTags) !== JSON.stringify(asset.tags ?? []) ||
    (sourceNote ?? "") !== (asset.sourceNote ?? "");

  if (!changed) return false;

  await updateMediaArchiveAsset(asset.id, {
    tags: mergedTags,
    sourceNote: sourceNote ?? asset.sourceNote,
  });

  const saved = await getMediaArchiveAssetById(asset.id);
  if (saved) void indexArchiveAssetEmbedding(saved).catch(() => undefined);
  return true;
}

export async function bulkRetagArchiveGeo(opts: {
  archiveId: number;
  ids?: number[];
  search?: string;
}): Promise<BulkGeoRetagResult> {
  let assets = await getMediaArchiveAssets(opts.archiveId);
  if (opts.search?.trim()) {
    assets = filterMediaArchiveAssets(assets, { search: opts.search });
  }
  if (opts.ids?.length) {
    const idSet = new Set(opts.ids);
    assets = assets.filter((a) => idSet.has(a.id));
  }

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let sampleUpdate: BulkGeoRetagResult["sampleUpdate"];

  for (const asset of assets) {
    processed += 1;
    try {
      const ok = await retagArchiveAssetGeoFromMetadata(asset.id);
      if (ok) {
        updated += 1;
        if (!sampleUpdate) {
          const saved = await getMediaArchiveAssetById(asset.id);
          if (saved) sampleUpdate = { id: saved.id, tags: saved.tags ?? [] };
        }
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  return { processed, updated, skipped, sampleUpdate };
}
