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
    if (!isNaN(n) && n >= 1 && n <= 300) return n;
  }
  return 80;
}

function backfillIntervalMs(): number {
  const raw = process.env.CLIP_EMBEDDING_BACKFILL_INTERVAL_MIN?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.5 && n <= 30) return Math.round(n * 60_000);
  }
  return 2 * 60_000;
}

function backfillStartupRounds(): number {
  const raw = process.env.CLIP_EMBEDDING_BACKFILL_STARTUP_ROUNDS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 10) return n;
  }
  return 3;
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

/**
 * Pre-warm index before visual stage — indexes up to maxAssets but stops after maxWaitMs.
 */
export async function backfillClipEmbeddingsWithBudget(
  maxAssets: number,
  maxWaitMs: number
): Promise<{ indexed: number; timedOut: boolean }> {
  if (!backfillEnabled()) return { indexed: 0, timedOut: false };
  const started = Date.now();
  let indexed = 0;
  let timedOut = false;

  while (indexed < maxAssets && Date.now() - started < maxWaitMs) {
    const batch = Math.min(24, maxAssets - indexed);
    const result = await backfillMissingClipEmbeddings(batch);
    indexed += result.indexed;
    if (result.indexed === 0) break;
    if (Date.now() - started >= maxWaitMs) {
      timedOut = true;
      break;
    }
  }

  return { indexed, timedOut };
}

/** Fire-and-forget backfill loop — runs on worker startup and every few minutes. */
export function scheduleClipEmbeddingBackfill(): void {
  if (!backfillEnabled()) return;
  const run = async () => {
    try {
      await backfillMissingClipEmbeddings();
    } catch (err) {
      console.warn("[ClipEmbedding] Backfill failed:", (err as Error).message?.slice(0, 120));
    }
  };
  void (async () => {
    for (let round = 0; round < backfillStartupRounds(); round++) {
      try {
        const result = await backfillMissingClipEmbeddings();
        if (result.indexed === 0) break;
      } catch (err) {
        console.warn("[ClipEmbedding] Startup backfill failed:", (err as Error).message?.slice(0, 120));
        break;
      }
    }
  })();
  setInterval(() => void run(), backfillIntervalMs()).unref?.();
}
