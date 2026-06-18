/**
 * Bulk AI vision titles + tags for existing archive clips (improves search/filter).
 */
import {
  archiveAiTaggingEnabled,
  applySharedAiToClipFields,
  generateArchiveAssetAiMetadataFromPath,
} from "./archiveAssetTagging";
import { loadArchiveAssetFile } from "./archiveAssetLoad";
import { indexArchiveAssetEmbedding } from "./archiveEmbeddingIndex";
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
    noFrames: number;
    noVision: number;
    llmFailed: number;
  };
  sampleError?: string;
  /** First clip that was actually saved — proves DB write + tags for UI feedback. */
  sampleUpdate?: {
    assetId: number;
    title: string;
    tags: string[];
  };
};

const BULK_AI_CONCURRENCY = 2;

type SingleResult =
  | "updated"
  | "skipped_missing_asset"
  | "skipped_file_missing"
  | "skipped_download"
  | "skipped_no_frames"
  | "skipped_no_vision"
  | "skipped_llm_failed"
  | "failed";

async function autoTitleSingleAsset(
  id: number,
  archiveId: number,
  nicheTags: string[]
): Promise<{
  result: SingleResult;
  error?: string;
  saved?: { assetId: number; title: string; tags: string[] };
}> {
  try {
    const asset = await getMediaArchiveAssetById(id);
    if (!asset || asset.archiveId !== archiveId) {
      return { result: "skipped_missing_asset" };
    }

    const loaded = await loadArchiveAssetFile(asset);
    if (!loaded.ok) {
      if (loaded.reason === "download_failed") {
        console.warn(`[ArchiveAI] auto-title skip ${id}: remote download failed`);
        return { result: "skipped_download" };
      }
      console.warn(`[ArchiveAI] auto-title skip ${id}: media not found (${asset.storageUrl})`);
      return { result: "skipped_file_missing" };
    }

    try {
      const ai = await generateArchiveAssetAiMetadataFromPath(
        loaded.result.localPath,
        loaded.result.mimeType,
        {
          archiveNicheTags: nicheTags,
          userTags: normalizeMediaTags(asset.tags ?? []),
          clipLabel: `archive clip ${asset.id}`,
        },
        { bulk: true }
      );

      if (ai.frameCount === 0) {
        return { result: "skipped_no_frames", error: ai.error };
      }
      if (!ai.metadata) {
        const err = ai.error ?? "Vision returned no metadata";
        console.warn(`[ArchiveAI] auto-title skip ${id}: ${err}`);
        return {
          result: err.toLowerCase().includes("ffmpeg") ? "skipped_no_frames" : "skipped_llm_failed",
          error: err,
        };
      }

      const fields = applySharedAiToClipFields({
        baseTitle: ai.metadata.title,
        userTags: [],
        sourceNote: asset.sourceNote ?? null,
        ai: ai.metadata,
        userProvidedTitle: false,
        replaceTags: true,
      });

      await updateMediaArchiveAsset(asset.id, {
        title: fields.title,
        tags: fields.tags,
        sourceNote: fields.sourceNote,
      });

      const saved = await getMediaArchiveAssetById(asset.id);
      const savedTags = normalizeMediaTags(saved?.tags ?? []);
      if (!saved || savedTags.length === 0) {
        return {
          result: "skipped_llm_failed",
          error: "Tags were not saved to the database",
        };
      }
      void indexArchiveAssetEmbedding(saved).catch(() => undefined);

      console.log(
        `[ArchiveAI] auto-title asset ${id}: "${fields.title.slice(0, 60)}" tags=[${savedTags.join(", ")}]`
      );
      return {
        result: "updated",
        saved: {
          assetId: asset.id,
          title: saved.title ?? fields.title,
          tags: savedTags,
        },
      };
    } finally {
      loaded.result.cleanup?.();
    }
  } catch (err) {
    const message = (err as Error).message?.slice(0, 120);
    console.warn(`[ArchiveAI] auto-title asset ${id} failed:`, message);
    return { result: "failed", error: message };
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
    throw new Error("AI tagging disabled — set GROQ_API_KEY, LLM_API_KEY, or BUILT_IN_FORGE_API_KEY on the server");
  }

  const archive = await getMediaArchiveById(opts.archiveId);
  if (!archive) throw new Error("Archive not found");

  const nicheTags = normalizeMediaTags(archive.nicheTags ?? []);
  const uniqueIds = [...new Set(opts.ids)];

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let sampleError: string | undefined;
  let sampleUpdate: AutoTitleArchiveResult["sampleUpdate"];
  const skipReasons = {
    missingAsset: 0,
    fileMissing: 0,
    downloadFailed: 0,
    noFrames: 0,
    noVision: 0,
    llmFailed: 0,
  };

  await runWithConcurrency(uniqueIds, BULK_AI_CONCURRENCY, async (id) => {
    processed += 1;
    const outcome = await autoTitleSingleAsset(id, opts.archiveId, nicheTags);
    if (outcome.error && !sampleError) sampleError = outcome.error;

    switch (outcome.result) {
      case "updated":
        updated += 1;
        if (!sampleUpdate && outcome.saved) sampleUpdate = outcome.saved;
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
      case "skipped_no_frames":
        skipped += 1;
        skipReasons.noFrames += 1;
        break;
      case "skipped_no_vision":
        skipped += 1;
        skipReasons.noVision += 1;
        break;
      case "skipped_llm_failed":
        skipped += 1;
        skipReasons.llmFailed += 1;
        break;
    }
  });

  return { processed, updated, skipped, failed, skipReasons, sampleError, sampleUpdate };
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

/** Run one asset through the AI pipeline and return diagnostics (admin troubleshooting). */
export async function probeArchiveAssetAiTag(assetId: number, archiveId: number) {
  const asset = await getMediaArchiveAssetById(assetId);
  if (!asset || asset.archiveId !== archiveId) {
    return { ok: false, stage: "asset", error: "Asset not found in archive" };
  }

  const loaded = await loadArchiveAssetFile(asset);
  if (!loaded.ok) {
    return { ok: false, stage: "load", error: loaded.reason, storageUrl: asset.storageUrl, storageKey: asset.storageKey };
  }

  try {
    const ai = await generateArchiveAssetAiMetadataFromPath(
      loaded.result.localPath,
      loaded.result.mimeType,
      { clipLabel: `archive clip ${asset.id}` },
      { bulk: true }
    );
    return {
      ok: !!ai.metadata,
      stage: ai.metadata ? "done" : ai.frameCount === 0 ? "frames" : "vision",
      frameCount: ai.frameCount,
      error: ai.error,
      title: ai.metadata?.title,
      tagCount: ai.metadata?.tags.length ?? 0,
      storageUrl: asset.storageUrl,
    };
  } finally {
    loaded.result.cleanup?.();
  }
}
