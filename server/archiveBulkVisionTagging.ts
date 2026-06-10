/**
 * Bulk AI vision titles + tags for existing archive clips (improves search/filter).
 */
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import {
  archiveAiTaggingEnabled,
  generateArchiveAssetAiMetadata,
  mergeArchiveTags,
  truncateArchiveSourceNote,
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

async function loadArchiveAssetBuffer(
  asset: MediaArchiveAsset
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const mimeType =
    asset.mimeType?.startsWith("video/") || asset.mimeType?.startsWith("image/")
      ? asset.mimeType
      : asset.mediaType === "image"
        ? "image/jpeg"
        : "video/mp4";

  const local = resolveArchiveAssetPath(asset);
  if (local && fs.existsSync(local)) {
    const buffer = fs.readFileSync(local);
    if (buffer.length < 500) return null;
    return { buffer, mimeType };
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

  try {
    const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(90_000) });
    if (!resp.ok) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 500) return null;
    return { buffer, mimeType };
  } catch {
    return null;
  }
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

  for (const id of uniqueIds) {
    processed += 1;
    try {
      const asset = await getMediaArchiveAssetById(id);
      if (!asset || asset.archiveId !== opts.archiveId) {
        skipped += 1;
        continue;
      }

      const loaded = await loadArchiveAssetBuffer(asset);
      if (!loaded) {
        skipped += 1;
        continue;
      }

      const ai = await generateArchiveAssetAiMetadata(loaded.buffer, loaded.mimeType, {
        archiveNicheTags: nicheTags,
        userTags: normalizeMediaTags(asset.tags ?? []),
        clipLabel: `archief clip ${asset.id}`,
      });
      if (!ai) {
        skipped += 1;
        continue;
      }

      const existingTags = normalizeMediaTags(asset.tags ?? []);
      const title = ai.title.slice(0, 512);
      const tags = mergeArchiveTags(existingTags, ai.tags);
      const desc = ai.description.trim();
      const sourceNote = desc
        ? asset.sourceNote?.trim()
          ? `${asset.sourceNote.trim()} — ${desc}`
          : desc
        : asset.sourceNote;

      await updateMediaArchiveAsset(asset.id, {
        title,
        tags,
        sourceNote: truncateArchiveSourceNote(sourceNote),
      });
      updated += 1;
    } catch (err) {
      console.warn(`[ArchiveAI] auto-title asset ${id} failed:`, (err as Error).message?.slice(0, 120));
      failed += 1;
    }
  }

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
