/**
 * Bulk AI vision titles + tags for existing archive clips (improves search/filter).
 */
import {
  archiveAiTaggingEnabled,
  applySharedAiToClipFields,
  generateArchiveAssetAiMetadataFromPath,
} from "./archiveAssetTagging";
import { loadArchiveAssetFile } from "./archiveAssetLoad";
import {
  filterMediaArchiveAssets,
  getMediaArchiveAssetById,
  getMediaArchiveAssets,
  getMediaArchiveById,
  normalizeMediaTags,
  updateMediaArchiveAsset,
} from "./db";

export type AutoTitleArchiveResult = {
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  skipReasons: {
    missingAsset: number;
    fileMissing: number;
    downloadFailed: number;
    noVision: number;
  };
};

const BULK_AI_CONCURRENCY = 2;

type SingleResult = "updated" | "skipped_missing_asset" | "skipped_file_missing" | "skipped_download" | "skipped_no_vision" | "failed";

async function autoTitleSingleAsset(
  id: number,
  archiveId: number,
  nicheTags: string[]
): Promise<SingleResult> {
  try {
    const asset = await getMediaArchiveAssetById(id);
    if (!asset || asset.archiveId !== archiveId) {
      return "skipped_missing_asset";
    }

    const loaded = await loadArchiveAssetFile(asset);
    if (!loaded.ok) {
      if (loaded.reason === "download_failed") {
        console.warn(`[ArchiveAI] auto-title skip ${id}: remote download failed`);
        return "skipped_download";
      }
      console.warn(`[ArchiveAI] auto-title skip ${id}: media not found (${asset.storageUrl})`);
      return "skipped_file_missing";
    }

    try {
      const ai = await generateArchiveAssetAiMetadataFromPath(loaded.result.localPath, loaded.result.mimeType, {
        archiveNicheTags: nicheTags,
        userTags: normalizeMediaTags(asset.tags ?? []),
        clipLabel: `archive clip ${asset.id}`,
      });
      if (!ai) {
        console.warn(`[ArchiveAI] auto-title skip ${id}: vision returned no metadata`);
        return "skipped_no_vision";
      }

      const existingTags = normalizeMediaTags(asset.tags ?? []);
      const fields = applySharedAiToClipFields({
        baseTitle: ai.title,
        userTags: existingTags,
        sourceNote: null,
        ai,
        userProvidedTitle: false,
      });

      await updateMediaArchiveAsset(asset.id, {
        title: fields.title,
        tags: fields.tags,
        sourceNote: fields.sourceNote,
      });
      return "updated";
    } finally {
      loaded.result.cleanup?.();
    }
  } catch (err) {
    console.warn(`[ArchiveAI] auto-title asset ${id} failed:`, (err as Error).message?.slice(0, 120));
    return "failed";
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
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

export async function autoTitleArchiveAssets(opts: {
  archiveId: number;
  ids: number[];
}): Promise<AutoTitleArchiveResult> {
  if (!archiveAiTaggingEnabled()) {
    throw new Error("AI tagging disabled — set LLM_API_KEY (or BUILT_IN_FORGE_API_KEY) on the server");
  }

  const archive = await getMediaArchiveById(opts.archiveId);
  if (!archive) throw new Error("Archive not found");

  const nicheTags = normalizeMediaTags(archive.nicheTags ?? []);
  const uniqueIds = [...new Set(opts.ids)];

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const skipReasons = {
    missingAsset: 0,
    fileMissing: 0,
    downloadFailed: 0,
    noVision: 0,
  };

  await runWithConcurrency(uniqueIds, BULK_AI_CONCURRENCY, async (id) => {
    processed += 1;
    const result = await autoTitleSingleAsset(id, opts.archiveId, nicheTags);
    switch (result) {
      case "updated":
        updated += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "skipped_missing_asset":
        skipped += 1;
        skipReasons.missingAsset += 1;
        break;
      case "skipped_file_missing":
        skipped += 1;
        skipReasons.fileMissing += 1;
        break;
      case "skipped_download":
        skipped += 1;
        skipReasons.downloadFailed += 1;
        break;
      case "skipped_no_vision":
        skipped += 1;
        skipReasons.noVision += 1;
        break;
    }
  });

  return { processed, updated, skipped, failed, skipReasons };
}

/** Resolve asset ids for bulk retitle (all in archive or filtered subset). */
export async function resolveAutoTitleAssetIds(opts: {
  archiveId: number;
  ids?: number[];
  search?: string;
}): Promise<number[]> {
  let assets = await getMediaArchiveAssets(opts.archiveId);
  if (opts.search?.trim()) {
    assets = filterMediaArchiveAssets(assets, { search: opts.search });
  }
  if (opts.ids?.length) {
    const idSet = new Set(opts.ids);
    assets = assets.filter((a) => idSet.has(a.id));
  }
  return assets.map((a) => a.id);
}
