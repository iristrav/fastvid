/**
 * Bulk AI vision titles + tags for existing archive clips (improves search/filter).
 */
import fs from "fs";
import os from "os";
import path from "path";
import fetch from "node-fetch";
import {
  archiveAiTaggingEnabled,
  applySharedAiToClipFields,
  generateArchiveAssetAiMetadataFromPath,
} from "./archiveAssetTagging";
import {
  filterMediaArchiveAssets,
  getMediaArchiveAssetById,
  getMediaArchiveAssets,
  getMediaArchiveById,
  normalizeMediaTags,
  updateMediaArchiveAsset,
  type MediaArchiveAsset,
} from "./db";
import { storageGetSignedUrl } from "./storage";
import { LOCAL_UPLOADS_DIR, resolveLocalVideoPath } from "./storageLocal";

export type AutoTitleArchiveResult = {
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
};

const BULK_AI_CONCURRENCY = 2;

function resolveArchiveAssetPath(asset: Pick<MediaArchiveAsset, "storageUrl" | "storageKey">): string | null {
  const fromUrl = resolveLocalVideoPath(asset.storageUrl);
  if (fromUrl) return fromUrl;

  if (asset.storageKey) {
    const fromKey = path.join(LOCAL_UPLOADS_DIR, asset.storageKey.replace(/\//g, "_"));
    if (fs.existsSync(fromKey)) return fromKey;
  }

  if (asset.storageUrl.startsWith("/local-storage/")) {
    const fileName = asset.storageUrl.replace(/^\/local-storage\//, "");
    const p = path.join(LOCAL_UPLOADS_DIR, fileName);
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function assetMimeType(asset: MediaArchiveAsset): string {
  if (asset.mimeType?.startsWith("video/") || asset.mimeType?.startsWith("image/")) {
    return asset.mimeType;
  }
  return asset.mediaType === "image" ? "image/jpeg" : "video/mp4";
}

async function downloadToTempFile(url: string, ext: string): Promise<string | null> {
  const tempPath = path.join(
    os.tmpdir(),
    `archive-ai-dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  );
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!resp.ok) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 64) return null;
    fs.writeFileSync(tempPath, buffer);
    return tempPath;
  } catch {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    return null;
  }
}

async function loadArchiveAssetForVision(
  asset: MediaArchiveAsset
): Promise<{ localPath: string; mimeType: string; cleanup?: () => void } | null> {
  const mimeType = assetMimeType(asset);
  const local = resolveArchiveAssetPath(asset);
  if (local && fs.existsSync(local)) {
    return { localPath: local, mimeType };
  }

  let fetchUrl = asset.storageUrl;
  if (asset.storageUrl.startsWith("/manus-storage/")) {
    const key = asset.storageKey ?? asset.storageUrl.replace(/^\/manus-storage\//, "");
    try {
      fetchUrl = await storageGetSignedUrl(key);
    } catch {
      return null;
    }
  } else if (asset.storageUrl.startsWith("/")) {
    fetchUrl = `http://127.0.0.1:${process.env.PORT || 3000}${asset.storageUrl}`;
  }

  const ext = mimeType.includes("webm")
    ? "webm"
    : mimeType.includes("png")
      ? "png"
      : mimeType.includes("jpeg") || mimeType.includes("jpg")
        ? "jpg"
        : "mp4";
  const tempPath = await downloadToTempFile(fetchUrl, ext);
  if (!tempPath) return null;
  return {
    localPath: tempPath,
    mimeType,
    cleanup: () => {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    },
  };
}

async function autoTitleSingleAsset(
  id: number,
  archiveId: number,
  nicheTags: string[]
): Promise<"updated" | "skipped" | "failed"> {
  try {
    const asset = await getMediaArchiveAssetById(id);
    if (!asset || asset.archiveId !== archiveId) {
      return "skipped";
    }

    const loaded = await loadArchiveAssetForVision(asset);
    if (!loaded) {
      console.warn(`[ArchiveAI] auto-title skip ${id}: media not loadable`);
      return "skipped";
    }

    try {
      const ai = await generateArchiveAssetAiMetadataFromPath(loaded.localPath, loaded.mimeType, {
        archiveNicheTags: nicheTags,
        userTags: normalizeMediaTags(asset.tags ?? []),
        clipLabel: `archive clip ${asset.id}`,
      });
      if (!ai) {
        console.warn(`[ArchiveAI] auto-title skip ${id}: vision returned no metadata`);
        return "skipped";
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
      loaded.cleanup?.();
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
    throw new Error("AI tagging disabled — LLM_API_KEY required");
  }

  const archive = await getMediaArchiveById(opts.archiveId);
  if (!archive) throw new Error("Archive not found");

  const nicheTags = normalizeMediaTags(archive.nicheTags ?? []);
  const uniqueIds = [...new Set(opts.ids)];

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  await runWithConcurrency(uniqueIds, BULK_AI_CONCURRENCY, async (id) => {
    processed += 1;
    const result = await autoTitleSingleAsset(id, opts.archiveId, nicheTags);
    if (result === "updated") updated += 1;
    else if (result === "skipped") skipped += 1;
    else failed += 1;
  });

  return { processed, updated, skipped, failed };
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
