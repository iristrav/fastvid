/**
 * Background CLIP index backfill for archive assets missing frame embeddings.
 */
import fs from "fs";
import path from "path";
import { listActiveVideoArchiveAssetsBatch } from "./db";
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
  return 50;
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
    if (!isNaN(n) && n >= 1 && n <= 20) return n;
  }
  return 5;
}

/** Skip assets that failed indexing recently — avoids log spam on deploy. */
const recentIndexFailures = new Map<number, number>();
const INDEX_FAIL_COOLDOWN_MS = 6 * 60 * 60_000;
let backfillAssetCursor = 0;

function shouldSkipRecentIndexFailure(assetId: number): boolean {
  const until = recentIndexFailures.get(assetId);
  if (!until) return false;
  if (Date.now() > until) {
    recentIndexFailures.delete(assetId);
    return false;
  }
  return true;
}

function markIndexFailure(assetId: number): void {
  recentIndexFailures.set(assetId, Date.now() + INDEX_FAIL_COOLDOWN_MS);
}

/** Index CLIP embeddings for archive videos that lack a stored index (non-blocking batches). */
export async function backfillMissingClipEmbeddings(
  maxAssets = backfillBatchSize(),
  options?: { ignoreActiveJobCap?: boolean }
): Promise<{ indexed: number; skipped: number; missing: number }> {
  if (!backfillEnabled()) {
    return { indexed: 0, skipped: 0, missing: 0 };
  }
  const { workerLocalActiveJobs } = await import("./videoQueue");
  const activeJobs = workerLocalActiveJobs();
  const effectiveBatch =
    options?.ignoreActiveJobCap || activeJobs === 0
      ? maxAssets
      : Math.min(maxAssets, 10);

  let indexed = 0;
  let skipped = 0;
  let missing = 0;
  let cursor = backfillAssetCursor;
  const maxScan = Math.max(effectiveBatch * 12, 120);
  let scanned = 0;

  while (indexed < effectiveBatch && scanned < maxScan) {
    const page = await listActiveVideoArchiveAssetsBatch(cursor, 50);
    if (page.length === 0) {
      backfillAssetCursor = 0;
      break;
    }
    for (const asset of page) {
      cursor = asset.id;
      scanned++;
      if (loadStoredClipEmbedding(asset.id)) {
        skipped++;
        continue;
      }
      if (shouldSkipRecentIndexFailure(asset.id)) {
        skipped++;
        continue;
      }
      missing++;
      const local = resolveArchiveAssetLocalPath(asset);
      if (!local) {
        skipped++;
        continue;
      }
      const ok = await indexArchiveClipEmbedding(asset.id, local, { quiet: true });
      if (ok) indexed++;
      else {
        markIndexFailure(asset.id);
        skipped++;
      }
      if (indexed >= effectiveBatch) break;
    }
    backfillAssetCursor = cursor;
  }

  if (indexed > 0 || missing > 0) {
    console.log(
      `[ClipEmbedding] Backfill batch: indexed ${indexed}, skipped ${skipped}, still missing ~${Math.max(0, missing - indexed)}` +
        (activeJobs > 0 ? ` (worker has ${activeJobs} active job(s), batch capped)` : "")
    );
  }
  return { indexed, skipped, missing };
}

/**
 * Pre-warm index before visual stage — indexes up to maxAssets but stops after maxWaitMs.
 */
export async function backfillClipEmbeddingsWithBudget(
  maxAssets: number,
  maxWaitMs: number,
  options?: { ignoreActiveJobCap?: boolean }
): Promise<{ indexed: number; timedOut: boolean }> {
  if (!backfillEnabled()) return { indexed: 0, timedOut: false };
  const started = Date.now();
  let indexed = 0;
  let timedOut = false;

  while (indexed < maxAssets && Date.now() - started < maxWaitMs) {
    const batch = Math.min(24, maxAssets - indexed);
    const result = await backfillMissingClipEmbeddings(batch, options);
    indexed += result.indexed;
    if (result.indexed === 0) break;
    if (Date.now() - started >= maxWaitMs) {
      timedOut = true;
      break;
    }
  }

  return { indexed, timedOut };
}

async function runStartupClipIndexBurst(): Promise<void> {
  const deadline = Date.now() + 3 * 60_000;
  let totalIndexed = 0;
  while (Date.now() < deadline) {
    const { workerLocalActiveJobs } = await import("./videoQueue");
    if (workerLocalActiveJobs() > 0) break;
    const result = await backfillMissingClipEmbeddings(50);
    totalIndexed += result.indexed;
    if (result.indexed === 0) break;
  }
  if (totalIndexed > 0) {
    console.log(`[ClipEmbedding] Startup burst: indexed ${totalIndexed} archive clip(s)`);
  }
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
    await runStartupClipIndexBurst().catch((err) => {
      console.warn("[ClipEmbedding] Startup burst failed:", (err as Error).message?.slice(0, 120));
    });
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
