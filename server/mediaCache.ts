/**
 * Persistent Media Asset Cache — P3 optimisation.
 *
 * Caches raw downloaded assets (Pexels clips, Wikimedia images, Archive.org
 * videos) in R2/S3 so the same file is never re-downloaded across videos.
 *
 * Two public helpers used at download sites:
 *   tryRestoreFromMediaCache(sourceUrl, destPath) → boolean (cache hit → file written)
 *   reportToMediaCache(sourceUrl, localPath, contentType) → void (best-effort, never throws)
 *
 * Active only when mediaCacheEnabled() returns true (ENABLE_MEDIA_CACHE=true + S3 configured).
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { eq, and } from "drizzle-orm";
import { getDb } from "./db";
import { mediaAssetCache } from "../drizzle/schema";
import { storagePut, storageGetSignedUrl, isS3StorageEnabled } from "./storage";
import { mediaCacheEnabled } from "./sourcingPolicy";

export const MEDIA_CACHE_VERSION = "1";

// ─── Internals ────────────────────────────────────────────────────────────────

function urlHash(sourceUrl: string): string {
  return createHash("sha256").update(sourceUrl).digest("hex");
}

function r2KeyForHash(hash: string, ext: string): string {
  return `media-cache/${hash.slice(0, 2)}/${hash}${ext}`;
}

function extFromContentType(contentType: string): string {
  if (contentType.startsWith("video/")) return ".mp4";
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  return ".bin";
}

async function downloadFromR2(r2Key: string, destPath: string): Promise<void> {
  const signedUrl = await storageGetSignedUrl(r2Key);
  const resp = await fetch(signedUrl);
  if (!resp.ok) throw new Error(`Cache R2 read failed (${resp.status}) for key ${r2Key}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Checks the cache for sourceUrl. If hit, writes the cached asset to destPath
 * and returns true. Returns false on miss or any error (caller falls through to
 * the normal download path).
 */
export async function tryRestoreFromMediaCache(
  sourceUrl: string,
  destPath: string
): Promise<boolean> {
  if (!mediaCacheEnabled() || !isS3StorageEnabled()) return false;
  try {
    const db = await getDb();
    if (!db) return false;
    const hash = urlHash(sourceUrl);
    const rows = await db
      .select()
      .from(mediaAssetCache)
      .where(
        and(
          eq(mediaAssetCache.urlHash, hash),
          eq(mediaAssetCache.cacheVersion, MEDIA_CACHE_VERSION)
        )
      )
      .limit(1);
    if (!rows.length) return false;
    const row = rows[0];
    await downloadFromR2(row.r2Key, destPath);
    // Best-effort hit counter update — don't await
    void db
      .update(mediaAssetCache)
      .set({ hitCount: row.hitCount + 1, lastHitAt: new Date() })
      .where(eq(mediaAssetCache.id, row.id))
      .catch(() => {});
    console.log(
      `[MediaCache] HIT: ${path.basename(destPath)} ← ${sourceUrl.slice(0, 80)} (hits: ${row.hitCount + 1})`
    );
    return true;
  } catch (err) {
    console.warn("[MediaCache] tryRestore error (miss):", (err as Error).message?.slice(0, 120));
    return false;
  }
}

/**
 * Uploads localPath to R2 and writes a cache entry for sourceUrl.
 * Best-effort: never throws to the caller. Call with void.
 */
export async function reportToMediaCache(
  sourceUrl: string,
  localPath: string,
  contentType: string
): Promise<void> {
  if (!mediaCacheEnabled() || !isS3StorageEnabled()) return;
  try {
    const db = await getDb();
    if (!db) return;
    if (!fs.existsSync(localPath)) return;

    const hash = urlHash(sourceUrl);

    // Idempotency check — another request may have inserted while we downloaded
    const existing = await db
      .select({ id: mediaAssetCache.id })
      .from(mediaAssetCache)
      .where(eq(mediaAssetCache.urlHash, hash))
      .limit(1);
    if (existing.length) return;

    const stat = fs.statSync(localPath);
    const ext = extFromContentType(contentType);
    const r2Key = r2KeyForHash(hash, ext);

    const buf = fs.readFileSync(localPath);
    await storagePut(r2Key, buf, contentType);

    await db
      .insert(mediaAssetCache)
      .values({
        urlHash: hash,
        sourceUrl: sourceUrl.slice(0, 2048),
        r2Key,
        contentType,
        fileSizeBytes: stat.size,
        cacheVersion: MEDIA_CACHE_VERSION,
      })
      .onDuplicateKeyUpdate({ set: { r2Key, fileSizeBytes: stat.size } });

    console.log(
      `[MediaCache] STORE: ${(stat.size / 1024).toFixed(0)}KB → ${r2Key}`
    );
  } catch (err) {
    console.warn("[MediaCache] reportToCache error:", (err as Error).message?.slice(0, 120));
  }
}
