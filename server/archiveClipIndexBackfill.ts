/**
 * Background CLIP index backfill for archive assets missing frame embeddings.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { listActiveVideoArchiveAssetsBatch } from "./db";
import {
  clipEmbeddingIndexEnabled,
  indexArchiveClipEmbedding,
  loadStoredClipEmbedding,
} from "./archiveClipEmbedding";
import {
  claimAssetForClipIndexing,
  countAssetsMissingClipEmbedding,
  listAssetsMissingClipEmbedding,
  releaseClipIndexClaim,
  type ClipBackfillCandidate,
} from "./archiveClipEmbeddingStore";
import { LOCAL_UPLOADS_DIR, resolveLocalVideoPath } from "./storageLocal";
import { storageGetSignedUrl } from "./storage";

// Max asset size to download during backfill — skip larger files to avoid memory pressure.
const BACKFILL_MAX_BYTES = 80 * 1024 * 1024;

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

/**
 * Download a remote archive asset to a temp file for backfill indexing.
 * Handles /manus-storage/ (signed URL via S3) and direct https:// URLs.
 * Returns the temp path on success, or null if the asset should be skipped.
 */
async function downloadAssetForBackfill(asset: {
  id: number;
  storageUrl: string;
  storageKey: string | null;
}): Promise<string | null> {
  const { storageUrl, storageKey } = asset;
  let fetchUrl: string;

  if (storageUrl.startsWith("/manus-storage/")) {
    const key = storageKey ?? storageUrl.replace(/^\/manus-storage\//, "");
    try {
      fetchUrl = await storageGetSignedUrl(key);
    } catch (err) {
      console.warn(`[ClipEmbedding] Backfill: signed URL failed for asset ${asset.id}:`, (err as Error).message?.slice(0, 80));
      return null;
    }
  } else if (storageUrl.startsWith("https://") || storageUrl.startsWith("http://")) {
    fetchUrl = storageUrl;
  } else {
    // Unknown URL scheme — no download strategy
    return null;
  }

  const tempPath = path.join(os.tmpdir(), `fv_backfill_${asset.id}_${Date.now()}.mp4`);
  try {
    const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(90_000) });
    if (!resp.ok) {
      console.warn(`[ClipEmbedding] Backfill: HTTP ${resp.status} for asset ${asset.id}`);
      return null;
    }
    const contentLength = Number(resp.headers.get("content-length") ?? 0);
    if (contentLength > 0 && contentLength > BACKFILL_MAX_BYTES) {
      console.log(`[ClipEmbedding] Backfill: skipping asset ${asset.id} — too large (${Math.round(contentLength / 1024 / 1024)}MB)`);
      recentIndexFailures.set(asset.id, Date.now() + 30 * 24 * 60 * 60_000); // skip for 30 days
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 500) {
      console.warn(`[ClipEmbedding] Backfill: asset ${asset.id} download too small (${buf.length}b)`);
      return null;
    }
    if (buf.length > BACKFILL_MAX_BYTES) {
      console.log(`[ClipEmbedding] Backfill: skipping asset ${asset.id} — too large (${Math.round(buf.length / 1024 / 1024)}MB)`);
      recentIndexFailures.set(asset.id, Date.now() + 30 * 24 * 60 * 60_000); // skip for 30 days
      return null;
    }
    fs.writeFileSync(tempPath, buf);
    return tempPath;
  } catch (err) {
    console.warn(`[ClipEmbedding] Backfill: download failed for asset ${asset.id}:`, (err as Error).message?.slice(0, 80));
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    return null;
  }
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

/** Whether the current pause has already been logged — see backfillMissingClipEmbeddings. */
let backfillPauseAnnounced = false;

function markIndexFailure(assetId: number): void {
  recentIndexFailures.set(assetId, Date.now() + INDEX_FAIL_COOLDOWN_MS);
}

/**
 * Fetch (if needed) and index one asset. Shared by both work-list strategies below.
 * Returns "indexed" | "skipped" — a failure is recorded durably inside
 * indexArchiveClipEmbedding, so it is never retried in the next process.
 */
async function indexOneAsset(asset: ClipBackfillCandidate): Promise<"indexed" | "skipped"> {
  const local = resolveArchiveAssetLocalPath(asset);
  const videoPath = local ?? (await downloadAssetForBackfill(asset));
  if (!videoPath) return "skipped";
  const ok = await indexArchiveClipEmbedding(asset.id, videoPath, { quiet: true });
  if (ok) return "indexed";
  markIndexFailure(asset.id);
  return "skipped";
}

/**
 * Index CLIP embeddings for archive videos that lack a stored index (non-blocking batches).
 *
 * RONDE 99 — this used to walk every active video asset from a module-level id cursor and ask
 * the local filesystem, per asset, whether it already had an embedding. Both halves of that
 * were wrong once the process restarts: the cursor is a plain variable that resets to 0, and
 * the filesystem index lives on ephemeral container disk. The Railway logs showed the result —
 * `skipped 0` on every batch, the same 289 asset ids indexed in two separate runs, and an id
 * range that restarted *below* the previous run's high-water mark.
 *
 * With a database the work list now comes from the database: which assets have no indexed row.
 * There is no cursor to lose, no re-scan of finished work, and a claim per asset so two
 * replicas cannot index the same file at the same time. Without a database (local dev, tests)
 * the old cursor scan is still there, unchanged, as the fallback.
 */
export async function backfillMissingClipEmbeddings(
  maxAssets = backfillBatchSize(),
  options?: { ignoreActiveJobCap?: boolean }
): Promise<{ indexed: number; skipped: number; missing: number }> {
  if (!backfillEnabled()) {
    return { indexed: 0, skipped: 0, missing: 0 };
  }
  const { workerLocalActiveJobs } = await import("./videoQueue");
  const activeJobs = workerLocalActiveJobs();
  // Fully pause CLIP backfill while any render is active — CLIP is CPU-heavy and
  // competes directly with the render pipeline on the same worker process.
  if (!options?.ignoreActiveJobCap && activeJobs > 0) {
    // RONDE 26: this poll runs every two minutes, so a three-hour render used to bury the log
    // under 100 identical lines. Say it once per pause, then stay quiet until work resumes —
    // the fact that a render is running is already visible everywhere else in the log.
    if (!backfillPauseAnnounced) {
      console.log(`[ClipEmbedding] Backfill paused — ${activeJobs} active render job(s) in progress`);
      backfillPauseAnnounced = true;
    }
    return { indexed: 0, skipped: 0, missing: 0 };
  }
  backfillPauseAnnounced = false;
  const effectiveBatch = maxAssets;

  // Ask the database for work that is genuinely outstanding. A slightly larger fetch than the
  // batch leaves room for assets that turn out to be unfetchable (missing file, too large).
  const workList = await listAssetsMissingClipEmbedding(Math.min(300, effectiveBatch * 3));
  if (workList) {
    return runWorkListBackfill(workList, effectiveBatch, activeJobs, options);
  }

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
      // Re-check every iteration, not just once at the top — a render can start
      // mid-batch (worker just claimed a queued video), and continuing to burn
      // CPU on background indexing for the rest of a 50-asset batch competes with
      // it for the same small box's ffmpeg/CPU budget instead of yielding right away.
      if (!options?.ignoreActiveJobCap && workerLocalActiveJobs() > 0) {
        backfillAssetCursor = cursor;
        console.log("[ClipEmbedding] Backfill yielding mid-batch — render job became active");
        return { indexed, skipped, missing };
      }
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
      if ((await indexOneAsset(asset)) === "indexed") indexed++;
      else skipped++;
      if (indexed >= effectiveBatch) break;
    }
    backfillAssetCursor = cursor;
  }

  if (indexed > 0 || missing > 0) {
    console.log(
      `[ClipEmbedding] Backfill batch (no index DB): indexed ${indexed}, skipped ${skipped}, ` +
        `unindexed in this scan ${Math.max(0, missing - indexed)}` +
        (activeJobs > 0 ? ` (worker has ${activeJobs} active job(s), batch capped)` : "")
    );
  }
  return { indexed, skipped, missing };
}

/**
 * DB-driven backfill: every asset in `workList` is known to be missing an embedding, so there
 * is nothing to re-check and nothing to skip for being already done.
 *
 * The claim is what makes this safe with more than one replica. Two workers polling at the same
 * time get overlapping work lists — without a claim they would both download and CLIP-index the
 * same file. claimAssetForClipIndexing() is an INSERT on a primary key, so exactly one wins.
 */
async function runWorkListBackfill(
  workList: ClipBackfillCandidate[],
  effectiveBatch: number,
  activeJobs: number,
  options?: { ignoreActiveJobCap?: boolean }
): Promise<{ indexed: number; skipped: number; missing: number }> {
  const { workerLocalActiveJobs } = await import("./videoQueue");
  let indexed = 0;
  let skipped = 0;
  let claimedByOthers = 0;
  const missing = workList.length;

  for (const asset of workList) {
    if (indexed >= effectiveBatch) break;
    // Re-check every iteration, not just once at the top — a render can start mid-batch (worker
    // just claimed a queued video), and continuing to burn CPU on background indexing competes
    // with it for the same small box's ffmpeg/CPU budget instead of yielding right away.
    if (!options?.ignoreActiveJobCap && workerLocalActiveJobs() > 0) {
      console.log("[ClipEmbedding] Backfill yielding mid-batch — render job became active");
      break;
    }
    if (shouldSkipRecentIndexFailure(asset.id)) {
      skipped++;
      continue;
    }
    if (!(await claimAssetForClipIndexing(asset.id))) {
      claimedByOthers++;
      continue;
    }
    const outcome = await indexOneAsset(asset);
    if (outcome === "indexed") {
      indexed++;
    } else {
      skipped++;
      // indexArchiveClipEmbedding records real failures itself; this covers the cases it never
      // saw (no local file, download refused) so the claim does not sit there until it expires.
      await releaseClipIndexClaim(asset.id);
    }
  }

  if (indexed > 0 || skipped > 0 || claimedByOthers > 0) {
    const remaining = await countAssetsMissingClipEmbedding();
    console.log(
      `[ClipEmbedding] Backfill batch: indexed ${indexed}, skipped ${skipped}` +
        (claimedByOthers > 0 ? `, claimed elsewhere ${claimedByOthers}` : "") +
        // A real count from the database, not `missing - indexed`. The old arithmetic reported
        // "still missing ~0" whenever a batch finished its own scan, which read as "the archive
        // is fully indexed" while thousands of assets were still untouched.
        (remaining == null ? "" : `, archive still missing ${remaining}`) +
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
