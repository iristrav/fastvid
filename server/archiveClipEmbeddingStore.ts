/**
 * Durable store for archive CLIP frame embeddings.
 *
 * RONDE 99 — the CLIP index is now DB-backed (MySQL table `fastvid_archive_clip_embeddings`)
 * with a bounded in-process read cache, instead of only loose JSON files under
 * LOCAL_UPLOADS_DIR.
 *
 * Why: archiveClipEmbedding.ts wrote every embedding to
 * `LOCAL_UPLOADS_DIR/archive-clip-embeddings/<assetId>.json`, and LOCAL_UPLOADS_DIR falls back
 * to `/app/uploads` or the working directory when no Railway Volume is attached
 * (storageLocal.ts resolveUploadsDir). That directory is ephemeral container disk, and the
 * render worker runs with multiple replicas — Railway does not allow volumes on multi-replica
 * services. So every deploy wiped the index, and even between deploys each replica only saw
 * what it had written itself.
 *
 * Production proof (Railway logs dea374c0 and a045a135): 289 asset ids were indexed in both
 * logs, every batch reported `skipped 0`, and the id range restarted *lower* than the previous
 * run's high-water mark. The backfill was not converging — it was re-indexing the same archive
 * over and over, burning CLIP CPU on work it had already done.
 *
 * This is the same fix, and the same storage contract, that RONDE 4 applied to the *text*
 * embedding index (archiveEmbeddingIndex.ts): MySQL already sits on a volume and is shared by
 * every replica.
 *
 * Design constraints honoured:
 *  - loadStoredClipEmbedding() must stay SYNCHRONOUS — clipInClipOffset.pickInClipStartSec and
 *    visualQualityGate read it from sync code. So reads come from an in-process cache that an
 *    async prefetch fills. Unlike RONDE 4 this store does NOT load the whole table at startup:
 *    a CLIP record carries three 512-dim frame vectors plus the mean, which is ~40KB of JSON
 *    per asset, and the worker runs with --max-old-space-size=1024. Callers that know their
 *    candidate set (preRankCuratedCandidatesByClipEmbedding, the backfill batch) prefetch it in
 *    one query; the cache is an LRU so it can never grow without bound.
 *  - The legacy file store keeps working: writes still go to disk, reads fall through to it on
 *    a cache miss, and a file hit is migrated into the DB best-effort. Without a DB
 *    (local dev, tests) behaviour degrades to exactly the pre-RONDE-99 file-backed behaviour.
 *  - Failures are recorded, not just remembered. `recentIndexFailures` in the backfill is an
 *    in-memory Map with a 6h cooldown — it dies with the process, so an asset that can never be
 *    indexed (corrupt file, 0 extractable frames) was retried on every single boot. A failed
 *    row survives the restart.
 *  - Two replicas can run the backfill at the same time. claimAssetForClipIndexing() is an
 *    INSERT that fails on the primary key when another worker already holds the asset, so only
 *    one of them does the work. Stale claims are reclaimed after CLAIM_TTL_MS.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";

export type StoredClipEmbeddingRecord = {
  assetId: number;
  model: string;
  embedding: number[];
  frameEmbeddings?: number[][];
  updatedAt: string;
};

/** A row is one of these. `claimed` is a worker's in-flight marker, not a result. */
export type ClipEmbeddingRowStatus = "indexed" | "failed" | "claimed";

/** Cap on cached records. ~40KB of vectors each, so this is ~80MB worst case — well inside the
 *  worker's 1GB heap, and far more than the 48-candidate pool any single beat pre-ranks. */
const CACHE_MAX_ENTRIES = 2000;

/** A claim older than this is assumed to belong to a worker that died mid-index. */
const CLAIM_TTL_MS = 30 * 60_000;

/** How long a `failed` row is left alone before the backfill may try the asset again. */
const FAILURE_RETRY_MS = 7 * 24 * 60 * 60_000;

/** Beyond this many failed attempts the asset is never retried — it is not indexable. */
const MAX_INDEX_ATTEMPTS = 3;

export function clipEmbeddingStoreDisabled(): boolean {
  return process.env.CLIP_EMBEDDING_DB_STORE === "false";
}

// ─── In-process LRU cache ─────────────────────────────────────────────────────

/** Insertion-ordered Map used as an LRU: a hit re-inserts, so the oldest key is always first. */
const cache = new Map<number, StoredClipEmbeddingRecord>();
/** Asset ids known to have no usable embedding — prevents a per-beat DB round trip for each. */
const knownAbsent = new Set<number>();

function cacheSet(record: StoredClipEmbeddingRecord): void {
  cache.delete(record.assetId);
  cache.set(record.assetId, record);
  knownAbsent.delete(record.assetId);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Synchronous read — cache only. Returns null when the asset was never prefetched. */
export function cachedClipEmbedding(assetId: number): StoredClipEmbeddingRecord | null {
  const hit = cache.get(assetId);
  if (!hit) return null;
  // Refresh recency.
  cache.delete(assetId);
  cache.set(assetId, hit);
  return hit;
}

/** True when a prefetch has already established that this asset has no stored embedding. */
export function clipEmbeddingKnownAbsent(assetId: number): boolean {
  return knownAbsent.has(assetId);
}

/** Test hook: resets module state so each test starts from a cold store. */
export function __resetClipEmbeddingStoreForTests(): void {
  cache.clear();
  knownAbsent.clear();
  tableEnsured = false;
  tableUnavailable = false;
}

// ─── Table ────────────────────────────────────────────────────────────────────

let tableEnsured = false;
/** Set once a DDL/DML call fails, so a broken/absent DB does not get hammered per asset. */
let tableUnavailable = false;

async function ensureTable(): Promise<boolean> {
  if (clipEmbeddingStoreDisabled() || tableUnavailable) return false;
  const db = await getDb();
  if (!db) return false;
  if (tableEnsured) return true;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS fastvid_archive_clip_embeddings (
        asset_id INT PRIMARY KEY,
        model VARCHAR(64) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'indexed',
        embedding LONGTEXT,
        frame_embeddings LONGTEXT,
        frame_count INT NOT NULL DEFAULT 0,
        attempts INT NOT NULL DEFAULT 0,
        last_error VARCHAR(255),
        claimed_by VARCHAR(64),
        claimed_at TIMESTAMP NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    tableEnsured = true;
    return true;
  } catch (err) {
    tableUnavailable = true;
    console.warn("[ClipEmbeddingStore] table unavailable:", (err as Error).message?.slice(0, 120));
    return false;
  }
}

/** drizzle mysql2 `execute()` returns `[rows, fields]` for SELECT — not a bare row array.
 *  Same defensive shape-normaliser as archiveEmbeddingIndex.ts / workerHeartbeat.ts. */
function rowsFromExecuteResult<T extends Record<string, unknown>>(raw: unknown): T[] {
  if (!raw) return [];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const first = raw[0];
  if (Array.isArray(first)) return first as T[];
  if (typeof first === "object" && first !== null && !("affectedRows" in first)) {
    return raw as T[];
  }
  return [];
}

function parseVector(raw: unknown): number[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as number[];
  } catch {
    return null;
  }
}

function parseFrames(raw: unknown): number[][] | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const frames = parsed.filter((f): f is number[] => Array.isArray(f) && f.length > 0);
    return frames.length > 0 ? frames : undefined;
  } catch {
    return undefined;
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Load the given assets' embeddings into the in-process cache in one query.
 *
 * Ids already cached (or already known absent) are not re-queried, so calling this per beat
 * over an overlapping candidate pool costs nothing after the first beat. Every id passed in
 * ends up either cached or marked absent, which is what makes the synchronous
 * cachedClipEmbedding() read trustworthy afterwards.
 */
export async function prefetchClipEmbeddings(assetIds: number[]): Promise<number> {
  const wanted = Array.from(
    new Set(
      assetIds.filter(
        (id) => Number.isFinite(id) && id > 0 && !cache.has(id) && !knownAbsent.has(id)
      )
    )
  );
  if (wanted.length === 0) return 0;
  if (!(await ensureTable())) return 0;
  const db = await getDb();
  if (!db) return 0;

  try {
    const raw = await db.execute(sql`
      SELECT asset_id AS assetId, model, embedding, frame_embeddings AS frameEmbeddings,
             updated_at AS updatedAt
      FROM fastvid_archive_clip_embeddings
      WHERE status = 'indexed' AND asset_id IN (${sql.join(
        wanted.map((id) => sql`${id}`),
        sql`, `
      )})
    `);
    type Row = {
      assetId: number;
      model: string;
      embedding: string | null;
      frameEmbeddings: string | null;
      updatedAt: unknown;
    };
    let loaded = 0;
    for (const row of rowsFromExecuteResult<Row>(raw)) {
      const embedding = parseVector(row.embedding);
      if (!embedding) continue;
      cacheSet({
        assetId: Number(row.assetId),
        model: row.model,
        embedding,
        frameEmbeddings: parseFrames(row.frameEmbeddings),
        updatedAt: String(row.updatedAt ?? ""),
      });
      loaded++;
    }
    // Anything the query did not return has no usable row — remember that so the next beat
    // does not ask again.
    for (const id of wanted) {
      if (!cache.has(id)) knownAbsent.add(id);
    }
    return loaded;
  } catch (err) {
    console.warn("[ClipEmbeddingStore] prefetch failed:", (err as Error).message?.slice(0, 120));
    return 0;
  }
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/** Persist a successful index. Also caches it, so the write is immediately readable. */
export async function persistClipEmbedding(record: StoredClipEmbeddingRecord): Promise<boolean> {
  cacheSet(record);
  if (!(await ensureTable())) return false;
  const db = await getDb();
  if (!db) return false;
  try {
    await db.execute(sql`
      INSERT INTO fastvid_archive_clip_embeddings
        (asset_id, model, status, embedding, frame_embeddings, frame_count, attempts, last_error,
         claimed_by, claimed_at)
      VALUES (${record.assetId}, ${record.model}, 'indexed', ${JSON.stringify(record.embedding)},
              ${record.frameEmbeddings ? JSON.stringify(record.frameEmbeddings) : null},
              ${record.frameEmbeddings?.length ?? 0}, 0, NULL, NULL, NULL)
      ON DUPLICATE KEY UPDATE
        model = VALUES(model),
        status = 'indexed',
        embedding = VALUES(embedding),
        frame_embeddings = VALUES(frame_embeddings),
        frame_count = VALUES(frame_count),
        attempts = 0,
        last_error = NULL,
        claimed_by = NULL,
        claimed_at = NULL
    `);
    return true;
  } catch (err) {
    console.warn(
      `[ClipEmbeddingStore] persist failed for asset ${record.assetId}:`,
      (err as Error).message?.slice(0, 120)
    );
    return false;
  }
}

/**
 * Record that indexing this asset failed.
 *
 * The row survives the process, which is the whole point: the in-memory `recentIndexFailures`
 * map in the backfill forgets everything on restart, so an asset that can never be indexed came
 * back on every boot. After MAX_INDEX_ATTEMPTS the asset is skipped for good.
 */
export async function recordClipIndexFailure(assetId: number, reason: string): Promise<void> {
  knownAbsent.add(assetId);
  if (!(await ensureTable())) return;
  const db = await getDb();
  if (!db) return;
  try {
    await db.execute(sql`
      INSERT INTO fastvid_archive_clip_embeddings
        (asset_id, model, status, attempts, last_error, claimed_by, claimed_at)
      VALUES (${assetId}, '', 'failed', 1, ${reason.slice(0, 250)}, NULL, NULL)
      ON DUPLICATE KEY UPDATE
        status = IF(status = 'indexed', 'indexed', 'failed'),
        attempts = attempts + 1,
        last_error = VALUES(last_error),
        claimed_by = NULL,
        claimed_at = NULL
    `);
  } catch (err) {
    console.warn(
      `[ClipEmbeddingStore] failure record rejected for asset ${assetId}:`,
      (err as Error).message?.slice(0, 120)
    );
  }
}

// ─── Claiming (multi-replica safety) ──────────────────────────────────────────

/** Identifies this process in a claim row. Replica id when the platform provides one. */
export function clipIndexWorkerId(): string {
  const railway = process.env.RAILWAY_REPLICA_ID?.trim();
  if (railway) return railway.slice(0, 60);
  return `${process.env.HOSTNAME?.trim() || "worker"}-${process.pid}`.slice(0, 60);
}

/**
 * Try to take ownership of indexing one asset.
 *
 * Returns false when another worker already holds a fresh claim, or when the asset is already
 * indexed / permanently failed. The INSERT is what makes this safe across replicas: asset_id is
 * the primary key, so exactly one of two concurrent workers wins and the other gets a duplicate
 * key error, which the UPDATE's WHERE clause then refuses to convert into a claim.
 */
export async function claimAssetForClipIndexing(assetId: number): Promise<boolean> {
  if (!(await ensureTable())) return true; // no DB — single-process behaviour, nothing to claim
  const db = await getDb();
  if (!db) return true;
  const worker = clipIndexWorkerId();
  const staleBefore = new Date(Date.now() - CLAIM_TTL_MS);
  const retryFailedBefore = new Date(Date.now() - FAILURE_RETRY_MS);
  try {
    const raw = await db.execute(sql`
      INSERT INTO fastvid_archive_clip_embeddings
        (asset_id, model, status, attempts, claimed_by, claimed_at)
      VALUES (${assetId}, '', 'claimed', 0, ${worker}, NOW())
      ON DUPLICATE KEY UPDATE
        claimed_by = IF(
          (status = 'claimed' AND (claimed_at IS NULL OR claimed_at < ${staleBefore}))
            OR (status = 'failed' AND attempts < ${MAX_INDEX_ATTEMPTS} AND updated_at < ${retryFailedBefore}),
          ${worker}, claimed_by
        ),
        status = IF(claimed_by = ${worker}, 'claimed', status),
        claimed_at = IF(claimed_by = ${worker}, NOW(), claimed_at)
    `);
    // affectedRows: 1 = inserted (we own it), 2 = updated (we took over a stale/retryable row),
    // 0 = the row was left exactly as it was, so somebody else owns it or it is finished.
    const affected = affectedRowsOf(raw);
    return affected === 1 || affected === 2;
  } catch {
    // Duplicate key with no matching update path — another worker owns it.
    return false;
  }
}

/** Release a claim this worker took but did not convert into a result. */
export async function releaseClipIndexClaim(assetId: number): Promise<void> {
  if (!(await ensureTable())) return;
  const db = await getDb();
  if (!db) return;
  try {
    await db.execute(sql`
      DELETE FROM fastvid_archive_clip_embeddings
      WHERE asset_id = ${assetId} AND status = 'claimed' AND claimed_by = ${clipIndexWorkerId()}
    `);
  } catch {
    /* best effort — a stale claim expires by CLAIM_TTL_MS anyway */
  }
}

function affectedRowsOf(raw: unknown): number {
  if (!raw) return 0;
  const head = Array.isArray(raw) ? raw[0] : raw;
  if (head && typeof head === "object" && "affectedRows" in head) {
    return Number((head as { affectedRows: unknown }).affectedRows ?? 0);
  }
  return 0;
}

// ─── Backfill work list ───────────────────────────────────────────────────────

export type ClipBackfillCandidate = {
  id: number;
  storageUrl: string;
  storageKey: string | null;
};

/**
 * Active video assets that have no usable CLIP row yet.
 *
 * This replaces the id cursor the backfill used to walk. The cursor was a module-level number
 * that reset to 0 on every process start, which is why the Railway logs showed the id range
 * restarting *below* the previous run's high-water mark: the backfill was not resuming, it was
 * starting over. Asking the database which assets are missing needs no cursor at all, cannot
 * drift, and skips indexed assets in the query instead of loading and rejecting them one by one.
 */
export async function listAssetsMissingClipEmbedding(
  limit: number
): Promise<ClipBackfillCandidate[] | null> {
  if (!(await ensureTable())) return null;
  const db = await getDb();
  if (!db) return null;
  const staleBefore = new Date(Date.now() - CLAIM_TTL_MS);
  const retryFailedBefore = new Date(Date.now() - FAILURE_RETRY_MS);
  try {
    const raw = await db.execute(sql`
      SELECT a.id, a.storageUrl, a.storageKey
      FROM media_archive_assets a
      LEFT JOIN fastvid_archive_clip_embeddings e ON e.asset_id = a.id
      WHERE a.isActive = 1
        AND a.mediaType = 'video'
        AND (
          e.asset_id IS NULL
          OR (e.status = 'claimed' AND (e.claimed_at IS NULL OR e.claimed_at < ${staleBefore}))
          OR (e.status = 'failed' AND e.attempts < ${MAX_INDEX_ATTEMPTS}
              AND e.updated_at < ${retryFailedBefore})
        )
      ORDER BY a.id
      LIMIT ${limit}
    `);
    type Row = { id: number; storageUrl: string; storageKey: string | null };
    return rowsFromExecuteResult<Row>(raw).map((r) => ({
      id: Number(r.id),
      storageUrl: String(r.storageUrl),
      storageKey: r.storageKey ?? null,
    }));
  } catch (err) {
    console.warn(
      "[ClipEmbeddingStore] missing-asset query failed:",
      (err as Error).message?.slice(0, 120)
    );
    return null;
  }
}

/** How many active video assets still have no indexed embedding. Null when there is no DB. */
export async function countAssetsMissingClipEmbedding(): Promise<number | null> {
  if (!(await ensureTable())) return null;
  const db = await getDb();
  if (!db) return null;
  try {
    const raw = await db.execute(sql`
      SELECT COUNT(*) AS remaining
      FROM media_archive_assets a
      LEFT JOIN fastvid_archive_clip_embeddings e ON e.asset_id = a.id
      WHERE a.isActive = 1 AND a.mediaType = 'video'
        AND (e.asset_id IS NULL OR e.status <> 'indexed')
    `);
    const rows = rowsFromExecuteResult<{ remaining: number }>(raw);
    if (rows.length === 0) return null;
    return Number(rows[0]!.remaining ?? 0);
  } catch {
    return null;
  }
}

export const __clipEmbeddingStoreInternals = {
  CACHE_MAX_ENTRIES,
  CLAIM_TTL_MS,
  FAILURE_RETRY_MS,
  MAX_INDEX_ATTEMPTS,
};
