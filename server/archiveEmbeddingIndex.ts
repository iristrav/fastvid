/**
 * Text embedding index for archive assets (one-time index, reuse at search — no per-beat
 * asset API calls).
 *
 * RONDE 4 — the index is now DB-backed (MySQL table `fastvid_archive_asset_embeddings`) with
 * an in-process read cache, instead of loose JSON files under LOCAL_UPLOADS_DIR.
 *
 * Why: the file-backed index lived on the container's ephemeral disk. The render worker runs
 * on Railway with 3 replicas and no volume (Railway does not allow volumes on multi-replica
 * services), so (a) every deploy wiped every embedding, and (b) even mid-deploy each replica
 * only ever saw the embeddings written by itself. Production proof, render 516: every beat
 * logged `archiveScore=n/a`, the per-beat gap strategy was therefore always "aggressive", and
 * computeArchiveCoverage() fell through to its keyword path. MySQL already sits on a volume
 * and is shared by all replicas, which is exactly the storage contract this index needs.
 *
 * Design constraints honoured:
 *  - loadStoredAssetEmbedding() must stay SYNCHRONOUS — retrievalFunnel.ts calls it inside
 *    mergeCandidates(), a sync function. So reads come from an in-memory cache that
 *    ensureArchiveEmbeddingCacheLoaded() fills from the DB once per process. Every async
 *    entry point that precedes a sync read (scoreBeatAgainstStoredEmbedding) awaits that
 *    load, so the sync reads are warm by the time they run.
 *  - The legacy file store keeps working as a fallback/local-dev path: reads fall through to
 *    it when the cache misses, and a file hit is self-migrated into the DB best-effort.
 *  - Missing rows self-heal: after the cache loads, a bounded background backfill computes
 *    embeddings for active archive assets that have none (one createTextEmbedding call per
 *    asset, once ever). It runs detached so it can never delay a render — assets it fills in
 *    become visible to later beats/renders.
 *  - No DB available (local dev/tests without DATABASE_URL): behaviour degrades to exactly
 *    the pre-RONDE-4 file-backed behaviour. Nothing throws.
 */
import fs from "fs";
import path from "path";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { LOCAL_UPLOADS_DIR } from "./storageLocal";
import { buildAssetSemanticDocument, createTextEmbedding, cosineSimilarityVectors } from "./semanticVisualMatching";

export type StoredAssetEmbedding = {
  assetId: number;
  model: string;
  embedding: number[];
  document: string;
  updatedAt: string;
};

/** Backfill bounds: converge without ever hogging a worker. At most this many missing assets
 *  are embedded per process start, within the time budget below. Anything left over is picked
 *  up by the next process (deploys and replica restarts are frequent enough in practice). */
const BACKFILL_MAX_ASSETS_PER_LOAD = 100;
const BACKFILL_TIME_BUDGET_MS = 60_000;

function indexDir(): string {
  const dir = path.join(LOCAL_UPLOADS_DIR, "archive-embeddings");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(assetId: number): string {
  return path.join(indexDir(), `${assetId}.json`);
}

export function archiveEmbeddingIndexEnabled(): boolean {
  return process.env.ENABLE_ARCHIVE_EMBEDDING_INDEX !== "false";
}

// ─── DB table ─────────────────────────────────────────────────────────────────

/** drizzle mysql2 `execute()` returns `[rows, fields]` for SELECT — not a bare row array.
 *  Same defensive shape-normaliser as workerHeartbeat.ts. */
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

let tableEnsured = false;
async function ensureEmbeddingTable(): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  if (tableEnsured) return true;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS fastvid_archive_asset_embeddings (
      asset_id INT PRIMARY KEY,
      model VARCHAR(64) NOT NULL,
      embedding LONGTEXT NOT NULL,
      document TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  tableEnsured = true;
  return true;
}

async function upsertEmbeddingRow(record: StoredAssetEmbedding): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await ensureEmbeddingTable();
  await db.execute(sql`
    INSERT INTO fastvid_archive_asset_embeddings (asset_id, model, embedding, document)
    VALUES (${record.assetId}, ${record.model}, ${JSON.stringify(record.embedding)}, ${record.document})
    ON DUPLICATE KEY UPDATE
      model = VALUES(model),
      embedding = VALUES(embedding),
      document = VALUES(document)
  `);
}

// ─── In-process cache ─────────────────────────────────────────────────────────

const embeddingCache = new Map<number, StoredAssetEmbedding>();
let cacheLoadPromise: Promise<void> | null = null;
let backfillStarted = false;

/** Test hook: resets module state so each test starts from a cold cache. */
export function __resetArchiveEmbeddingCacheForTests(): void {
  embeddingCache.clear();
  cacheLoadPromise = null;
  backfillStarted = false;
  tableEnsured = false;
}

/**
 * Loads every stored embedding from the DB into the in-process cache, once per process
 * (single-flight; later calls await the same promise and return immediately after).
 * Afterwards kicks the missing-asset backfill in the background — deliberately NOT awaited,
 * so a cold cache never delays the funnel that triggered the load.
 * Without a DB this resolves immediately and reads fall through to the legacy file store.
 */
export async function ensureArchiveEmbeddingCacheLoaded(): Promise<void> {
  if (!archiveEmbeddingIndexEnabled()) return;
  if (!cacheLoadPromise) {
    cacheLoadPromise = (async () => {
      try {
        const hasTable = await ensureEmbeddingTable();
        if (!hasTable) return; // no DB — legacy file fallback stays in charge
        const db = await getDb();
        if (!db) return;
        const raw = await db.execute(sql`
          SELECT asset_id AS assetId, model, embedding, document, updated_at AS updatedAt
          FROM fastvid_archive_asset_embeddings
        `);
        type Row = { assetId: number; model: string; embedding: string; document: string | null; updatedAt: unknown };
        let loaded = 0;
        for (const row of rowsFromExecuteResult<Row>(raw)) {
          try {
            const embedding = JSON.parse(row.embedding) as number[];
            if (!Array.isArray(embedding) || embedding.length === 0) continue;
            embeddingCache.set(Number(row.assetId), {
              assetId: Number(row.assetId),
              model: row.model,
              embedding,
              document: row.document ?? "",
              updatedAt: String(row.updatedAt ?? ""),
            });
            loaded++;
          } catch {
            /* skip unparseable row */
          }
        }
        console.log(`[ArchiveEmbeddingIndex] cache loaded: ${loaded} embedding(s) from DB`);
        if (!backfillStarted) {
          backfillStarted = true;
          void backfillMissingArchiveEmbeddings().catch((err) =>
            console.warn("[ArchiveEmbeddingIndex] backfill failed:", (err as Error).message?.slice(0, 120))
          );
        }
      } catch (err) {
        console.warn("[ArchiveEmbeddingIndex] cache load failed:", (err as Error).message?.slice(0, 120));
      }
    })();
  }
  await cacheLoadPromise;
}

/**
 * Self-healing backfill: embed active archive assets that have no stored embedding yet.
 * Bounded (BACKFILL_MAX_ASSETS_PER_LOAD assets / BACKFILL_TIME_BUDGET_MS) and sequential, so
 * it converges over process starts without competing with render traffic for the OpenAI
 * embedding endpoint. Exported for tests; production reaches it only via the cache load.
 */
export async function backfillMissingArchiveEmbeddings(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const raw = await db.execute(sql`
    SELECT a.id, a.title, a.tags, a.sourceNote
    FROM media_archive_assets a
    LEFT JOIN fastvid_archive_asset_embeddings e ON e.asset_id = a.id
    WHERE a.isActive = 1 AND e.asset_id IS NULL
    ORDER BY a.id
    LIMIT ${BACKFILL_MAX_ASSETS_PER_LOAD}
  `);
  type AssetRow = { id: number; title: string | null; tags: unknown; sourceNote: string | null };
  const missing = rowsFromExecuteResult<AssetRow>(raw);
  if (missing.length === 0) return 0;

  const t0 = Date.now();
  let done = 0;
  for (const row of missing) {
    if (Date.now() - t0 > BACKFILL_TIME_BUDGET_MS) break;
    const tags = Array.isArray(row.tags)
      ? (row.tags as string[])
      : typeof row.tags === "string"
        ? (() => { try { return JSON.parse(row.tags as string) as string[]; } catch { return null; } })()
        : null;
    const ok = await indexArchiveAssetEmbedding({
      id: Number(row.id),
      title: row.title,
      tags,
      sourceNote: row.sourceNote,
    }).catch(() => false);
    if (ok) done++;
  }
  console.log(
    `[ArchiveEmbeddingIndex] backfill: ${done}/${missing.length} missing embedding(s) indexed in ${Date.now() - t0}ms`
  );
  return done;
}

// ─── Public API (shape unchanged since the file-backed version) ───────────────

export function loadStoredAssetEmbedding(assetId: number): StoredAssetEmbedding | null {
  if (!archiveEmbeddingIndexEnabled()) return null;

  const cached = embeddingCache.get(assetId);
  if (cached) return cached;

  // Legacy file fallback (pre-RONDE-4 store, and the only store when no DB is configured).
  const p = indexPath(assetId);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as StoredAssetEmbedding;
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) return null;
    // Self-migrate the legacy file into cache + DB so the next replica/deploy has it too.
    embeddingCache.set(assetId, parsed);
    void upsertEmbeddingRow(parsed).catch(() => undefined);
    return parsed;
  } catch {
    return null;
  }
}

/** Index one asset after upload/ingest/retag — persists the embedding to the DB (and the
 *  legacy file store, best-effort, for no-DB environments) and makes it immediately readable
 *  through the cache. */
export async function indexArchiveAssetEmbedding(asset: {
  id: number;
  title?: string | null;
  tags?: string[] | null;
  sourceNote?: string | null;
}): Promise<boolean> {
  if (!archiveEmbeddingIndexEnabled()) return false;
  const document = buildAssetSemanticDocument(asset);
  const embedding = await createTextEmbedding(document);
  if (!embedding?.length) return false;

  const record: StoredAssetEmbedding = {
    assetId: asset.id,
    model: process.env.SEMANTIC_EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    embedding,
    document: document.slice(0, 500),
    updatedAt: new Date().toISOString(),
  };
  embeddingCache.set(asset.id, record);
  try {
    await upsertEmbeddingRow(record);
  } catch (err) {
    console.warn(`[ArchiveEmbeddingIndex] DB upsert failed for asset ${asset.id}:`, (err as Error).message?.slice(0, 120));
  }
  try {
    fs.writeFileSync(indexPath(asset.id), JSON.stringify(record));
  } catch {
    /* best-effort legacy store */
  }
  return true;
}

/** Score beat vs pre-indexed asset — only one embedding API call (beat side). */
export async function scoreBeatAgainstStoredEmbedding(
  beatDocument: string,
  assetId: number
): Promise<number | null> {
  await ensureArchiveEmbeddingCacheLoaded();
  const stored = loadStoredAssetEmbedding(assetId);
  if (!stored) return null;
  const beatEmb = await createTextEmbedding(beatDocument);
  if (!beatEmb?.length) return null;
  return Math.max(0, cosineSimilarityVectors(beatEmb, stored.embedding));
}
