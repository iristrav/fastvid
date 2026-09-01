/**
 * RONDE 99 — the CLIP index has to survive a restart.
 *
 * archiveClipEmbedding.ts wrote every embedding to
 * `LOCAL_UPLOADS_DIR/archive-clip-embeddings/<assetId>.json`. storageLocal.resolveUploadsDir
 * falls back to `/app/uploads` or the working directory when no Railway Volume is attached, and
 * a volume cannot be attached to a multi-replica service, so that directory is ephemeral
 * container disk. Every deploy wiped the index, and between deploys each replica only saw its
 * own writes.
 *
 * The production evidence is in two Railway logs a day apart: 289 asset ids indexed in BOTH,
 * `skipped 0` on every single batch, and an id range that restarted below the previous run's
 * high-water mark. The archive was being re-indexed from scratch, forever.
 *
 * These tests run the real modules against a mocked DB and a mocked CLIP provider, and pin the
 * contracts the fix depends on:
 *   1. loadStoredClipEmbedding stays SYNCHRONOUS — clipInClipOffset.pickInClipStartSec reads it
 *      from sync code.
 *   2. An indexed asset is still indexed after the process and the local disk are both gone.
 *   3. Without a DB, behaviour is exactly the pre-RONDE-99 file-backed behaviour.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  return {
    TMP_DIR: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ronde99-clip-")),
    dbExecute: vi.fn(),
    state: { dbAvailable: true },
    frames: vi.fn(async () => [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as number[][]),
  };
});
const { TMP_DIR, dbExecute } = hoisted;

vi.mock("./db", () => ({
  getDb: async () => (hoisted.state.dbAvailable ? { execute: hoisted.dbExecute } : null),
}));
vi.mock("./storageLocal", () => ({
  LOCAL_UPLOADS_DIR: hoisted.TMP_DIR,
}));
vi.mock("./localClipVision", () => ({
  clipEmbeddingIndexEnabled: () => true,
  indexVideoFrameEmbeddings: (...args: unknown[]) => hoisted.frames(...(args as [])),
  meanEmbedding: (vectors: number[][]) => {
    if (!vectors.length) return null;
    const dim = vectors[0]!.length;
    const out = new Array(dim).fill(0);
    for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i]!;
    return out.map((x) => x / vectors.length);
  },
  embedTextQuery: async () => [1, 0, 0],
  scoreEmbeddingSimilarity: (a: number[], b: number[]) => {
    let dot = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i]! * b[i]!;
    return dot;
  },
  clipSimToScore: (sim: number) => Math.round(sim * 10),
  minLocalClipSimilarity: () => 0.2,
  resolveBeatVisionQueryEmbedding: async () => [1, 0, 0],
  beatVisionContextFromProfile: (beat: unknown) => beat,
}));
vi.mock("./clipBackgroundAuditor", () => ({
  scheduleAuditForAsset: () => undefined,
}));

import {
  __resetClipEmbeddingStoreForTests,
  cachedClipEmbedding,
  claimAssetForClipIndexing,
  clipEmbeddingKnownAbsent,
  countAssetsMissingClipEmbedding,
  listAssetsMissingClipEmbedding,
  persistClipEmbedding,
  prefetchClipEmbeddings,
  recordClipIndexFailure,
  releaseClipIndexClaim,
  __clipEmbeddingStoreInternals,
} from "./archiveClipEmbeddingStore";
import {
  indexArchiveClipEmbedding,
  loadStoredClipEmbedding,
  loadStoredFrameEmbeddings,
  prefetchArchiveClipEmbeddings,
  preRankCuratedCandidatesByClipEmbedding,
  type StoredClipEmbedding,
} from "./archiveClipEmbedding";

/** The drizzle sql`` object keeps its raw text in nested chunks — stringify to match on it. */
function sqlText(q: unknown): string {
  return JSON.stringify(q);
}

function calls(fragment: string): unknown[] {
  return dbExecute.mock.calls.filter(([q]) => sqlText(q).includes(fragment));
}

function dbRow(assetId: number, embedding: number[] = [1, 0, 0], frames?: number[][]) {
  return {
    assetId,
    model: "Xenova/clip-vit-base-patch32",
    embedding: JSON.stringify(embedding),
    frameEmbeddings: frames ? JSON.stringify(frames) : null,
    updatedAt: "2026-08-27",
  };
}

/** Default DB: DDL ok, SELECT returns `rows`, everything else an empty OkPacket. */
function installDb(rows: Record<string, unknown>[] = [], okPacket: { affectedRows: number } = { affectedRows: 1 }) {
  dbExecute.mockImplementation(async (q: unknown) => {
    const text = sqlText(q);
    if (text.includes("CREATE TABLE")) return [];
    if (text.includes("SELECT asset_id")) return rows;
    if (text.includes("SELECT a.id")) return rows;
    if (text.includes("COUNT(*)")) return rows;
    return [okPacket];
  });
}

const EMB_DIR = () => path.join(TMP_DIR, "archive-clip-embeddings");

function writeLegacyFile(record: StoredClipEmbedding): void {
  fs.mkdirSync(EMB_DIR(), { recursive: true });
  fs.writeFileSync(path.join(EMB_DIR(), `${record.assetId}.json`), JSON.stringify(record));
}

/** What a redeploy does: the process is new and the container's disk is empty again. */
function simulateRedeploy(): void {
  __resetClipEmbeddingStoreForTests();
  fs.rmSync(EMB_DIR(), { recursive: true, force: true });
}

const prevStoreFlag = process.env.CLIP_EMBEDDING_DB_STORE;

beforeEach(() => {
  __resetClipEmbeddingStoreForTests();
  dbExecute.mockReset();
  hoisted.state.dbAvailable = true;
  hoisted.frames.mockImplementation(async () => [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  installDb([]);
  fs.rmSync(EMB_DIR(), { recursive: true, force: true });
  delete process.env.CLIP_EMBEDDING_DB_STORE;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevStoreFlag === undefined) delete process.env.CLIP_EMBEDDING_DB_STORE;
  else process.env.CLIP_EMBEDDING_DB_STORE = prevStoreFlag;
});

/* ═══════════ §9 — persistence ═══════════ */

describe("RONDE 99 §9 — the embedding is stored somewhere that survives the container", () => {
  it("TEST 1 — indexing writes the embedding to the database, not only to disk", async () => {
    const ok = await indexArchiveClipEmbedding(1001, __filename);
    expect(ok).toBe(true);
    const inserts = calls("INSERT INTO fastvid_archive_clip_embeddings");
    expect(inserts.length).toBe(1);
    expect(sqlText(inserts[0])).toContain("'indexed'");
  });

  it("TEST 2 — the local file is still written, so the near-duplicate scan keeps working", async () => {
    // archiveIntelligencePipeline.detectNearDuplicate reads the whole directory. Moving the
    // store of record to MySQL must not empty that directory for the current process.
    await indexArchiveClipEmbedding(1002, __filename);
    expect(fs.existsSync(path.join(EMB_DIR(), "1002.json"))).toBe(true);
  });

  it("TEST 3 — a prefetched row is readable through the SYNCHRONOUS API", async () => {
    installDb([dbRow(7, [1, 0, 0], [[1, 0, 0], [0, 1, 0]])]);
    await prefetchClipEmbeddings([7]);

    const stored = loadStoredClipEmbedding(7); // no await — this is the sync contract
    expect(stored?.assetId).toBe(7);
    expect(stored?.embedding).toEqual([1, 0, 0]);
    expect(loadStoredFrameEmbeddings(7)).toHaveLength(2);
  });

  it("TEST 4 — an asset indexed before the deploy is still indexed after it", async () => {
    // The exact scenario the Railway logs showed: index, redeploy, look again.
    await indexArchiveClipEmbedding(4242, __filename);
    const persisted = cachedClipEmbedding(4242);
    expect(persisted).not.toBeNull();

    simulateRedeploy();
    expect(loadStoredClipEmbedding(4242)).toBeNull(); // nothing local survived — as in production

    installDb([dbRow(4242, persisted!.embedding, persisted!.frameEmbeddings)]);
    await prefetchClipEmbeddings([4242]);
    expect(loadStoredClipEmbedding(4242)?.assetId).toBe(4242);
  });

  it("TEST 5 — a legacy file is migrated into the database on first read", async () => {
    // The deploy that introduces the table must not throw away an index a container already has.
    writeLegacyFile({
      assetId: 55,
      model: "Xenova/clip-vit-base-patch32",
      embedding: [0, 1, 0],
      frameEmbeddings: [[0, 1, 0]],
      updatedAt: "2026-01-01",
    });
    expect(loadStoredClipEmbedding(55)?.embedding).toEqual([0, 1, 0]);
    await vi.waitFor(() => expect(calls("INSERT INTO fastvid_archive_clip_embeddings").length).toBe(1));
  });

  it("TEST 6 — only rows that finished indexing are read back", async () => {
    await prefetchClipEmbeddings([1, 2]);
    const select = calls("SELECT asset_id")[0];
    expect(sqlText(select)).toContain("status = 'indexed'");
  });

  it("TEST 7 — an unparseable row is skipped, it does not poison the batch", async () => {
    installDb([{ ...dbRow(1), embedding: "not-json" }, { ...dbRow(2), embedding: "[]" }, dbRow(3, [0.5, 0.5])]);
    await prefetchClipEmbeddings([1, 2, 3]);
    expect(cachedClipEmbedding(1)).toBeNull();
    expect(cachedClipEmbedding(2)).toBeNull();
    expect(cachedClipEmbedding(3)?.embedding).toEqual([0.5, 0.5]);
  });

  it("TEST 8 — without a database nothing throws and the file store is still the store", async () => {
    hoisted.state.dbAvailable = false;
    expect(await indexArchiveClipEmbedding(900, __filename)).toBe(true);
    expect(fs.existsSync(path.join(EMB_DIR(), "900.json"))).toBe(true);
    expect(await prefetchClipEmbeddings([900])).toBe(0);
    expect(loadStoredClipEmbedding(900)?.assetId).toBe(900);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it("TEST 9 — the cache is bounded, so a large archive cannot exhaust the worker heap", async () => {
    const max = __clipEmbeddingStoreInternals.CACHE_MAX_ENTRIES;
    for (let i = 1; i <= max + 25; i++) {
      await persistClipEmbedding({
        assetId: i,
        model: "m",
        embedding: [1],
        updatedAt: "",
      });
    }
    expect(cachedClipEmbedding(1)).toBeNull(); // evicted
    expect(cachedClipEmbedding(max + 25)?.assetId).toBe(max + 25);
  });
});

/* ═══════════ §10 — idempotency ═══════════ */

describe("RONDE 99 §10 — an asset with a valid embedding is never indexed again", () => {
  it("TEST 10 — a cached embedding short-circuits the read before it touches the disk", async () => {
    installDb([dbRow(12, [9, 9, 9])]);
    await prefetchClipEmbeddings([12]);
    writeLegacyFile({ assetId: 12, model: "m", embedding: [0, 0, 0], updatedAt: "" });
    expect(loadStoredClipEmbedding(12)?.embedding).toEqual([9, 9, 9]);
  });

  it("TEST 11 — a prefetch remembers which assets have no row, so it asks the DB once", async () => {
    await prefetchClipEmbeddings([31]);
    expect(clipEmbeddingKnownAbsent(31)).toBe(true);
    await prefetchClipEmbeddings([31]);
    expect(calls("SELECT asset_id")).toHaveLength(1);
  });

  it("TEST 12 — an asset with no extractable frames is recorded as failed, durably", async () => {
    hoisted.frames.mockImplementation(async () => []);
    expect(await indexArchiveClipEmbedding(77, __filename)).toBe(false);
    const inserts = calls("INSERT INTO fastvid_archive_clip_embeddings");
    expect(inserts).toHaveLength(1);
    expect(sqlText(inserts[0])).toContain("'failed'");
    expect(sqlText(inserts[0])).toContain("no_frame_embeddings");
  });

  it("TEST 13 — a failed asset is not retried forever", () => {
    // A permanently unreadable file used to come back on every boot: recentIndexFailures is an
    // in-memory Map with a 6h cooldown that dies with the process.
    expect(__clipEmbeddingStoreInternals.MAX_INDEX_ATTEMPTS).toBeGreaterThan(0);
    expect(__clipEmbeddingStoreInternals.FAILURE_RETRY_MS).toBeGreaterThanOrEqual(24 * 60 * 60_000);
  });

  it("TEST 14 — recording a failure counts the attempt instead of overwriting it", async () => {
    await recordClipIndexFailure(5, "boom");
    const stmt = sqlText(calls("INSERT INTO fastvid_archive_clip_embeddings")[0]);
    expect(stmt).toContain("attempts = attempts + 1");
    // A finished index must never be downgraded to failed by a later transient error.
    expect(stmt).toContain("IF(status = 'indexed', 'indexed', 'failed')");
  });

  it("TEST 15 — the beat pre-rank warms every candidate it is about to score, in one query", async () => {
    installDb([dbRow(101, [1, 0, 0], [[1, 0, 0]]), dbRow(102, [0, 1, 0], [[0, 1, 0]])]);
    const candidates = [101, 102, 103].map((id) => ({ asset: { id }, score: 50 }));
    await preRankCuratedCandidatesByClipEmbedding(candidates, { beatText: "x" } as never);
    expect(calls("SELECT asset_id")).toHaveLength(1);
    expect(cachedClipEmbedding(101)).not.toBeNull();
    expect(cachedClipEmbedding(102)).not.toBeNull();
  });

  it("TEST 16 — prefetchArchiveClipEmbeddings ignores ids that are already known", async () => {
    installDb([dbRow(201)]);
    await prefetchArchiveClipEmbeddings([201]);
    await prefetchArchiveClipEmbeddings([201]);
    expect(calls("SELECT asset_id")).toHaveLength(1);
  });
});

/* ═══════════ §11 — concurrency ═══════════ */

describe("RONDE 99 §11 — two replicas cannot index the same asset", () => {
  it("TEST 17 — a claim is an INSERT on the primary key, so only one worker can win", async () => {
    installDb([], { affectedRows: 1 });
    expect(await claimAssetForClipIndexing(9)).toBe(true);
    expect(sqlText(calls("INSERT INTO fastvid_archive_clip_embeddings")[0])).toContain("'claimed'");
  });

  it("TEST 18 — a row another worker owns leaves the claim untouched and is refused", async () => {
    // MySQL reports affectedRows 0 when ON DUPLICATE KEY UPDATE changes nothing.
    installDb([], { affectedRows: 0 });
    expect(await claimAssetForClipIndexing(9)).toBe(false);
  });

  it("TEST 19 — taking over a stale or retryable row counts as winning it", async () => {
    installDb([], { affectedRows: 2 });
    expect(await claimAssetForClipIndexing(9)).toBe(true);
  });

  it("TEST 20 — a claim that never became a result is released, not left to expire", async () => {
    await releaseClipIndexClaim(9);
    const del = calls("DELETE FROM fastvid_archive_clip_embeddings");
    expect(del).toHaveLength(1);
    // Only this worker's own claim — never somebody else's, and never a finished row.
    expect(sqlText(del[0])).toContain("status = 'claimed'");
    expect(sqlText(del[0])).toContain("claimed_by");
  });

  it("TEST 21 — a stale claim is reclaimable, so a worker that died does not block an asset", async () => {
    installDb([], { affectedRows: 2 });
    await claimAssetForClipIndexing(9);
    const stmt = sqlText(calls("INSERT INTO fastvid_archive_clip_embeddings")[0]);
    expect(stmt).toContain("claimed_at");
    expect(__clipEmbeddingStoreInternals.CLAIM_TTL_MS).toBeGreaterThan(0);
  });

  it("TEST 22 — without a database claiming is a no-op that grants the work", async () => {
    hoisted.state.dbAvailable = false;
    expect(await claimAssetForClipIndexing(9)).toBe(true);
  });
});

/* ═══════════ §12 — cursor / resume ═══════════ */

describe("RONDE 99 §12 — the work list comes from the database, not from a cursor", () => {
  it("TEST 23 — the query asks for assets with no indexed row, not for a page after an id", async () => {
    installDb([]);
    await listAssetsMissingClipEmbedding(50);
    const stmt = sqlText(calls("SELECT a.id")[0]);
    expect(stmt).toContain("LEFT JOIN fastvid_archive_clip_embeddings");
    expect(stmt).toContain("e.asset_id IS NULL");
    expect(stmt).toContain("a.isActive = 1");
    expect(stmt).toContain("'video'");
  });

  it("TEST 24 — stale claims and retryable failures come back into the work list", async () => {
    await listAssetsMissingClipEmbedding(50);
    const stmt = sqlText(calls("SELECT a.id")[0]);
    expect(stmt).toContain("'claimed'");
    expect(stmt).toContain("'failed'");
  });

  it("TEST 25 — 'still missing' is a real count from the database, not batch arithmetic", async () => {
    installDb([{ remaining: 1234 }]);
    expect(await countAssetsMissingClipEmbedding()).toBe(1234);
    expect(sqlText(calls("COUNT(*)")[0])).toContain("e.status <> 'indexed'");
  });

  it("TEST 26 — without a database there is no work list and the caller falls back", async () => {
    hoisted.state.dbAvailable = false;
    expect(await listAssetsMissingClipEmbedding(50)).toBeNull();
    expect(await countAssetsMissingClipEmbedding()).toBeNull();
  });

  it("TEST 27 — a broken table is not retried on every asset", async () => {
    dbExecute.mockImplementation(async () => {
      throw new Error("no such database");
    });
    expect(await listAssetsMissingClipEmbedding(50)).toBeNull();
    await prefetchClipEmbeddings([1]);
    await claimAssetForClipIndexing(1);
    // One failed CREATE TABLE, then the store stands down.
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });
});
