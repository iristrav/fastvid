/**
 * AWS Rekognition celebrity recognition, wired to archive assets: resolves the
 * clip to a local file, runs recognizeCelebritiesInFile, and saves recognized
 * names as tags on the asset.
 */
import { isRekognitionEnabled, recognizeCelebritiesInFile, type RekognitionResult } from "./rekognitionCelebrity";
import { loadArchiveAssetFile } from "./archiveAssetLoad";
import { getMediaArchiveAssetById, getMediaArchiveAssets, normalizeMediaTags, updateMediaArchiveAsset } from "./db";

const BULK_REKOGNITION_CONCURRENCY = 3;

/** Recognize celebrities in one asset and persist the names as tags. */
export async function recognizeCelebritiesForAsset(assetId: number): Promise<RekognitionResult> {
  if (!isRekognitionEnabled()) {
    throw new Error("AWS Rekognition disabled — set AWS_REKOGNITION_ACCESS_KEY_ID and AWS_REKOGNITION_SECRET_ACCESS_KEY on the server");
  }

  const asset = await getMediaArchiveAssetById(assetId);
  if (!asset) throw new Error("Asset not found");

  const loaded = await loadArchiveAssetFile(asset);
  if (!loaded.ok) {
    throw new Error(loaded.reason === "download_failed" ? "Could not download clip from storage" : "Clip file not found");
  }

  try {
    const result = await recognizeCelebritiesInFile(loaded.result.localPath, asset.mediaType, asset.durationSec);
    if (result.persons.length > 0) {
      const existingTags = normalizeMediaTags(asset.tags ?? []);
      const names = result.persons.map((p) => p.name);
      const mergedTags = normalizeMediaTags([...existingTags, ...names]);
      await updateMediaArchiveAsset(asset.id, { tags: mergedTags });
    }
    return result;
  } finally {
    loaded.result.cleanup?.();
  }
}

export type RecognizeCelebritiesBulkResult = {
  scanned: number;
  identified: number;
  hasMore: boolean;
  nextOffset: number;
  total: number;
};

async function runWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      await fn(items[i]!);
    }
  }
  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/** Paginated bulk celebrity recognition — skips already-tagged clips when onlyUntagged is set. */
export async function recognizeCelebritiesBulk(opts: {
  archiveId: number;
  limit: number;
  offset: number;
  onlyUntagged?: boolean;
  ids?: number[];
}): Promise<RecognizeCelebritiesBulkResult> {
  if (!isRekognitionEnabled()) {
    throw new Error("AWS Rekognition disabled — set AWS_REKOGNITION_ACCESS_KEY_ID and AWS_REKOGNITION_SECRET_ACCESS_KEY on the server");
  }

  let assets = await getMediaArchiveAssets(opts.archiveId);
  if (opts.ids?.length) {
    const idSet = new Set(opts.ids);
    assets = assets.filter((a) => idSet.has(a.id));
  }
  if (opts.onlyUntagged) {
    assets = assets.filter((a) => normalizeMediaTags(a.tags ?? []).length === 0);
  }

  const total = assets.length;
  const page = assets.slice(opts.offset, opts.offset + opts.limit);

  let identified = 0;
  await runWithConcurrency(page, BULK_REKOGNITION_CONCURRENCY, async (asset) => {
    try {
      const result = await recognizeCelebritiesForAsset(asset.id);
      if (result.persons.length > 0) identified += 1;
    } catch (err) {
      console.warn(`[Rekognition] bulk asset ${asset.id} failed:`, (err as Error).message?.slice(0, 120));
    }
  });

  const nextOffset = opts.offset + opts.limit;
  return {
    scanned: page.length,
    identified,
    hasMore: nextOffset < total,
    nextOffset,
    total,
  };
}
