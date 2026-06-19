/**
 * Background CLIP index backfill for archive assets missing frame embeddings.
 */
import fs from "fs";
import path from "path";
import { getAllMediaArchives, getMediaArchiveAssets } from "./db";
import { clipEmbeddingIndexEnabled, indexArchiveClipEmbedding, loadStoredClipEmbedding } from "./archiveClipEmbedding";
import { LOCAL_UPLOADS_DIR, resolveLocalVideoPath } from "./storageLocal";

function resolveArchiveAssetLocalPath(asset: {
  storageUrl: string;
  storageKey: string | null;
}): string | null {
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

function backfillEnabled(): boolean {
  if (!clipEmbeddingIndexEnabled()) return false;
  return process.env.AUTO_CLIP_EMBEDDING_BACKFILL !== "false";
}

function backfillBatchSize(): number {
  const raw = process.env.CLIP_EMBEDDING_BACKFILL_BATCH?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 200) return n;
  }
  return 25;
}

/** Index CLIP embeddings for archive videos that lack a stored index (non-blocking batches). */
export async function backfillMissingClipEmbeddings(
  maxAssets = backfillBatchSize()
): Promise<{ indexed: number; skipped: number; missing: number }> {
  if (!backfillEnabled()) {
    return { indexed: 0, skipped: 0, missing: 0 };
  }

  const archives = (await getAllMediaArchives()).filter((a) => a.isActive === 1);
  let indexed = 0;
  let skipped = 0;
  let missing = 0;

  for (const archive of archives) {
    if (indexed >= maxAssets) break;
    const assets = await getMediaArchiveAssets(archive.id);
    for (const asset of assets) {
      if (indexed >= maxAssets) break;
      if (asset.mediaType !== "video") {
        skipped++;
        continue;
      }
      if (loadStoredClipEmbedding(asset.id)) {
        skipped++;
        continue;
      }
      missing++;
      const local = resolveArchiveAssetLocalPath(asset);
      if (!local) {
        skipped++;
        continue;
      }
      const ok = await indexArchiveClipEmbedding(asset.id, local);
      if (ok) indexed++;
      else skipped++;
    }
  }

  if (indexed > 0 || missing > 0) {
    console.log(
      `[ClipEmbedding] Backfill batch: indexed ${indexed}, skipped ${skipped}, still missing ~${Math.max(0, missing - indexed)}`
    );
  }
  return { indexed, skipped, missing };
}

/** Fire-and-forget backfill loop — runs on worker startup. */
export function scheduleClipEmbeddingBackfill(): void {
  if (!backfillEnabled()) return;
  void (async () => {
    try {
      await backfillMissingClipEmbeddings();
    } catch (err) {
      console.warn("[ClipEmbedding] Backfill failed:", (err as Error).message?.slice(0, 120));
    }
  })();
}
