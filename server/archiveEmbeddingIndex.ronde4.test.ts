import { readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// RONDE 4 — the archive text-embedding index moves from loose JSON files on the container's
// ephemeral disk to a MySQL table with an in-process read cache.
//
// Why: the render worker runs with 3 replicas and no volume (Railway does not allow volumes
// on multi-replica services), so every deploy wiped the whole index and each replica only
// ever saw its own writes. Render 516: every beat logged archiveScore=n/a, the gap strategy
// was therefore always "aggressive" (FIX 4 inert), and computeArchiveCoverage fell through
// to its keyword path.
//
// These tests run the REAL module against a mocked DB + mocked embedding provider, and pin
// the two contracts everything downstream depends on:
//   1. loadStoredAssetEmbedding stays SYNCHRONOUS (mergeCandidates calls it in sync code).
//   2. Behaviour without a DB is byte-for-byte the pre-RONDE-4 file-backed behaviour.

// ── Mocks (vi.mock is hoisted, so shared state must be hoisted too) ───────────

const hoisted = vi.hoisted(() => {
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  return {
    TMP_DIR: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ronde4-emb-")),
    dbExecute: vi.fn(),
    state: { dbAvailable: true },
    createTextEmbeddingMock: vi.fn(async (_doc: string) => [0.1, 0.2, 0.3]),
  };
});
const { TMP_DIR, dbExecute, createTextEmbeddingMock } = hoisted;

vi.mock("./db", () => ({
  getDb: async () => (hoisted.state.dbAvailable ? { execute: hoisted.dbExecute } : null),
}));

vi.mock("./storageLocal", () => ({
  LOCAL_UPLOADS_DIR: hoisted.TMP_DIR,
}));
vi.mock("./semanticVisualMatching", () => ({
  buildAssetSemanticDocument: (asset: { title?: string | null }) => `doc:${asset.title ?? ""}`,
  createTextEmbedding: (doc: string) => hoisted.createTextEmbeddingMock(doc),
  cosineSimilarityVectors: (a: number[], b: number[]) => {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  },
}));

import {
  __resetArchiveEmbeddingCacheForTests,
  backfillMissingArchiveEmbeddings,
  ensureArchiveEmbeddingCacheLoaded,
  indexArchiveAssetEmbedding,
  loadStoredAssetEmbedding,
  scoreBeatAgainstStoredEmbedding,
  type StoredAssetEmbedding,
} from "./archiveEmbeddingIndex";

/** The drizzle sql`` object keeps its raw text in nested chunks — stringify to match on it. */
function sqlText(q: unknown): string {
  return JSON.stringify(q);
}

function dbRow(assetId: number, embedding: number[] = [1, 0, 0]): Record<string, unknown> {
  return { assetId, model: "text-embedding-3-small", embedding: JSON.stringify(embedding), document: "d", updatedAt: "2026-08-19" };
}

/** Default DB behaviour: CREATE TABLE ok, SELECT cache rows, INSERT ok, backfill SELECT empty. */
function installDb(cacheRows: Record<string, unknown>[], missingAssets: Record<string, unknown>[] = []) {
  dbExecute.mockImplementation(async (q: unknown) => {
    const text = sqlText(q);
    if (text.includes("CREATE TABLE")) return [];
    if (text.includes("FROM fastvid_archive_asset_embeddings")) return cacheRows;
    if (text.includes("LEFT JOIN fastvid_archive_asset_embeddings")) return missingAssets;
    if (text.includes("INSERT INTO fastvid_archive_asset_embeddings")) return [];
    return [];
  });
}

function fileRecord(assetId: number, embedding: number[] = [0, 1, 0]): StoredAssetEmbedding {
  return { assetId, model: "text-embedding-3-small", embedding, document: "file", updatedAt: "2026-01-01" };
}

function writeLegacyFile(record: StoredAssetEmbedding): void {
  const dir = path.join(TMP_DIR, "archive-embeddings");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${record.assetId}.json`), JSON.stringify(record));
}

const prevFlag = process.env.ENABLE_ARCHIVE_EMBEDDING_INDEX;

beforeEach(() => {
  __resetArchiveEmbeddingCacheForTests();
  dbExecute.mockReset();
  createTextEmbeddingMock.mockClear();
  createTextEmbeddingMock.mockImplementation(async () => [0.1, 0.2, 0.3]);
  hoisted.state.dbAvailable = true;
  installDb([]);
  fs.rmSync(path.join(TMP_DIR, "archive-embeddings"), { recursive: true, force: true });
  delete process.env.ENABLE_ARCHIVE_EMBEDDING_INDEX;
});

afterEach(() => {
  if (prevFlag === undefined) delete process.env.ENABLE_ARCHIVE_EMBEDDING_INDEX;
  else process.env.ENABLE_ARCHIVE_EMBEDDING_INDEX = prevFlag;
});

// ── Cache load ────────────────────────────────────────────────────────────────

describe("ensureArchiveEmbeddingCacheLoaded", () => {
  it("loads DB rows into the cache; loadStoredAssetEmbedding then reads them SYNCHRONOUSLY", async () => {
    installDb([dbRow(7, [1, 0, 0]), dbRow(9, [0, 0, 1])]);
    await ensureArchiveEmbeddingCacheLoaded();

    const seven = loadStoredAssetEmbedding(7); // no await — this is the sync contract
    expect(seven?.assetId).toBe(7);
    expect(seven?.embedding).toEqual([1, 0, 0]);
    expect(loadStoredAssetEmbedding(9)?.embedding).toEqual([0, 0, 1]);
    expect(loadStoredAssetEmbedding(8)).toBeNull();
  });

  it("is single-flight: two concurrent + one later call issue exactly one SELECT", async () => {
    installDb([dbRow(7)]);
    await Promise.all([ensureArchiveEmbeddingCacheLoaded(), ensureArchiveEmbeddingCacheLoaded()]);
    await ensureArchiveEmbeddingCacheLoaded();
    const selects = dbExecute.mock.calls.filter(([q]) => sqlText(q).includes("FROM fastvid_archive_asset_embeddings"));
    expect(selects).toHaveLength(1);
  });

  it("skips unparseable/empty rows instead of failing the whole load", async () => {
    installDb([
      { ...dbRow(1), embedding: "not-json" },
      { ...dbRow(2), embedding: "[]" },
      dbRow(3, [0.5, 0.5]),
    ]);
    await ensureArchiveEmbeddingCacheLoaded();
    expect(loadStoredAssetEmbedding(1)).toBeNull();
    expect(loadStoredAssetEmbedding(2)).toBeNull();
    expect(loadStoredAssetEmbedding(3)?.embedding).toEqual([0.5, 0.5]);
  });

  it("a DB error during load resolves (never throws) and leaves the file fallback working", async () => {
    dbExecute.mockRejectedValue(new Error("connection refused"));
    writeLegacyFile(fileRecord(42));
    await expect(ensureArchiveEmbeddingCacheLoaded()).resolves.toBeUndefined();
    expect(loadStoredAssetEmbedding(42)?.assetId).toBe(42);
  });

  it("kicks the backfill in the BACKGROUND — the load resolves before the backfill finishes", async () => {
    let backfillSelectStarted = false;
    let releaseBackfill: () => void = () => undefined;
    const gate = new Promise<void>((r) => { releaseBackfill = r; });
    dbExecute.mockImplementation(async (q: unknown) => {
      const text = sqlText(q);
      if (text.includes("CREATE TABLE")) return [];
      if (text.includes("FROM fastvid_archive_asset_embeddings")) return [];
      if (text.includes("LEFT JOIN fastvid_archive_asset_embeddings")) {
        backfillSelectStarted = true;
        await gate; // the backfill hangs here...
        return [];
      }
      return [];
    });
    await ensureArchiveEmbeddingCacheLoaded(); // ...but the load must not wait for it
    releaseBackfill();
    await new Promise((r) => setTimeout(r, 10));
    expect(backfillSelectStarted).toBe(true);
  });

  it("does nothing at all when the index is disabled", async () => {
    process.env.ENABLE_ARCHIVE_EMBEDDING_INDEX = "false";
    await ensureArchiveEmbeddingCacheLoaded();
    expect(dbExecute).not.toHaveBeenCalled();
    expect(loadStoredAssetEmbedding(7)).toBeNull();
  });
});

// ── No-DB degradation (the pre-RONDE-4 contract) ─────────────────────────────

describe("without a DB the pre-RONDE-4 file behaviour is preserved exactly", () => {
  beforeEach(() => { hoisted.state.dbAvailable = false; });

  it("ensure resolves as a no-op and reads come from the legacy files", async () => {
    writeLegacyFile(fileRecord(11, [0.3, 0.7]));
    await ensureArchiveEmbeddingCacheLoaded();
    expect(loadStoredAssetEmbedding(11)?.embedding).toEqual([0.3, 0.7]);
    expect(loadStoredAssetEmbedding(12)).toBeNull();
  });

  it("a corrupt or empty-embedding file still yields null", async () => {
    const dir = path.join(TMP_DIR, "archive-embeddings");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "13.json"), "{broken");
    writeLegacyFile(fileRecord(14, []));
    expect(loadStoredAssetEmbedding(13)).toBeNull();
    expect(loadStoredAssetEmbedding(14)).toBeNull();
  });

  it("indexArchiveAssetEmbedding still writes the file and returns true", async () => {
    const ok = await indexArchiveAssetEmbedding({ id: 21, title: "Bunker exterior 1945" });
    expect(ok).toBe(true);
    const onDisk = JSON.parse(
      readFileSync(path.join(TMP_DIR, "archive-embeddings", "21.json"), "utf8")
    ) as StoredAssetEmbedding;
    expect(onDisk.assetId).toBe(21);
    expect(onDisk.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(onDisk.document).toBe("doc:Bunker exterior 1945");
  });
});

// ── Writes ────────────────────────────────────────────────────────────────────

describe("indexArchiveAssetEmbedding (with DB)", () => {
  it("upserts the DB row, updates the cache and writes the legacy file", async () => {
    const ok = await indexArchiveAssetEmbedding({ id: 5, title: "t", tags: ["a"], sourceNote: null });
    expect(ok).toBe(true);
    // Cache: readable synchronously without any ensure call.
    expect(loadStoredAssetEmbedding(5)?.embedding).toEqual([0.1, 0.2, 0.3]);
    // DB: one INSERT ... ON DUPLICATE KEY UPDATE.
    const inserts = dbExecute.mock.calls.filter(([q]) => sqlText(q).includes("INSERT INTO fastvid_archive_asset_embeddings"));
    expect(inserts).toHaveLength(1);
    expect(sqlText(inserts[0][0])).toContain("ON DUPLICATE KEY UPDATE");
    // Legacy file still written.
    expect(fs.existsSync(path.join(TMP_DIR, "archive-embeddings", "5.json"))).toBe(true);
  });

  it("a failing DB upsert does not fail the indexing (cache + file still land)", async () => {
    dbExecute.mockImplementation(async (q: unknown) => {
      if (sqlText(q).includes("INSERT INTO")) throw new Error("deadlock");
      return [];
    });
    const ok = await indexArchiveAssetEmbedding({ id: 6, title: "x" });
    expect(ok).toBe(true);
    expect(loadStoredAssetEmbedding(6)).not.toBeNull();
  });

  it("returns false when the embedding provider yields nothing — unchanged", async () => {
    createTextEmbeddingMock.mockResolvedValueOnce([]);
    expect(await indexArchiveAssetEmbedding({ id: 30, title: "t" })).toBe(false);
    expect(loadStoredAssetEmbedding(30)).toBeNull();
  });

  it("returns false when disabled — unchanged", async () => {
    process.env.ENABLE_ARCHIVE_EMBEDDING_INDEX = "false";
    expect(await indexArchiveAssetEmbedding({ id: 31, title: "t" })).toBe(false);
  });
});

describe("legacy file self-migration", () => {
  it("a cache miss that hits a legacy file migrates it into cache and DB", async () => {
    writeLegacyFile(fileRecord(50, [0.9, 0.1]));
    const first = loadStoredAssetEmbedding(50);
    expect(first?.embedding).toEqual([0.9, 0.1]);
    await new Promise((r) => setTimeout(r, 10)); // the upsert is fire-and-forget
    const inserts = dbExecute.mock.calls.filter(([q]) => sqlText(q).includes("INSERT INTO fastvid_archive_asset_embeddings"));
    expect(inserts).toHaveLength(1);
    // Second read comes from cache (delete the file to prove it).
    fs.rmSync(path.join(TMP_DIR, "archive-embeddings", "50.json"));
    expect(loadStoredAssetEmbedding(50)?.embedding).toEqual([0.9, 0.1]);
  });
});

// ── Backfill ──────────────────────────────────────────────────────────────────

describe("backfillMissingArchiveEmbeddings", () => {
  it("embeds and upserts every active asset that has no stored embedding", async () => {
    installDb([], [
      { id: 100, title: "Hitler bunker photo", tags: JSON.stringify(["bunker"]), sourceNote: null },
      { id: 101, title: "Berlin 1945", tags: null, sourceNote: "loc" },
    ]);
    const done = await backfillMissingArchiveEmbeddings();
    expect(done).toBe(2);
    expect(createTextEmbeddingMock).toHaveBeenCalledTimes(2);
    expect(loadStoredAssetEmbedding(100)).not.toBeNull();
    expect(loadStoredAssetEmbedding(101)).not.toBeNull();
    const inserts = dbExecute.mock.calls.filter(([q]) => sqlText(q).includes("INSERT INTO fastvid_archive_asset_embeddings"));
    expect(inserts).toHaveLength(2);
  });

  it("one failing asset does not stop the rest", async () => {
    installDb([], [
      { id: 110, title: "a", tags: null, sourceNote: null },
      { id: 111, title: "b", tags: null, sourceNote: null },
    ]);
    createTextEmbeddingMock
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce([0.4, 0.6]);
    const done = await backfillMissingArchiveEmbeddings();
    expect(done).toBe(1);
    expect(loadStoredAssetEmbedding(110)).toBeNull();
    expect(loadStoredAssetEmbedding(111)?.embedding).toEqual([0.4, 0.6]);
  });

  it("no missing assets → 0, and no embedding calls at all", async () => {
    installDb([], []);
    expect(await backfillMissingArchiveEmbeddings()).toBe(0);
    expect(createTextEmbeddingMock).not.toHaveBeenCalled();
  });

  it("without a DB it is a 0-op", async () => {
    hoisted.state.dbAvailable = false;
    expect(await backfillMissingArchiveEmbeddings()).toBe(0);
  });

  it("the missing-asset query is bounded and only targets ACTIVE assets", () => {
    const src = readFileSync(path.join(__dirname, "archiveEmbeddingIndex.ts"), "utf8");
    expect(src).toContain("const BACKFILL_MAX_ASSETS_PER_LOAD = 100;");
    expect(src).toContain("const BACKFILL_TIME_BUDGET_MS = 60_000;");
    expect(src).toContain("WHERE a.isActive = 1 AND e.asset_id IS NULL");
    expect(src).toContain("LIMIT ${BACKFILL_MAX_ASSETS_PER_LOAD}");
  });
});

// ── Scoring path ──────────────────────────────────────────────────────────────

describe("scoreBeatAgainstStoredEmbedding", () => {
  it("warms the cache itself, so callers need no separate ensure call", async () => {
    installDb([dbRow(7, [1, 0, 0])]);
    createTextEmbeddingMock.mockResolvedValueOnce([1, 0, 0]); // beat embedding, identical
    const score = await scoreBeatAgainstStoredEmbedding("beat doc", 7);
    expect(score).toBeCloseTo(1, 5);
  });

  it("returns null for an unknown asset — no beat embedding is even computed", async () => {
    installDb([]);
    expect(await scoreBeatAgainstStoredEmbedding("beat doc", 999)).toBeNull();
    expect(createTextEmbeddingMock).not.toHaveBeenCalled();
  });

  it("clamps negatives to 0 — unchanged", async () => {
    installDb([dbRow(7, [1, 0, 0])]);
    createTextEmbeddingMock.mockResolvedValueOnce([-1, 0, 0]);
    expect(await scoreBeatAgainstStoredEmbedding("beat doc", 7)).toBe(0);
  });
});

// ── Downstream contracts + RONDE 1/2/3 integrity ─────────────────────────────

describe("downstream contracts and earlier rounds are untouched", () => {
  const funnelSrc = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");
  const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const poolSrc = readFileSync(path.join(__dirname, "scenePool.ts"), "utf8");

  it("retrievalFunnel.ts is byte-for-byte untouched by RONDE 4 (sync call site intact)", () => {
    // mergeCandidates still calls the sync loader — the very reason the cache exists.
    expect(funnelSrc).toContain("const storedEmb = loadStoredAssetEmbedding(pick.asset.id);");
    // scoreBeatAgainstStoredEmbedding call sites unchanged.
    expect(funnelSrc).toContain("scoreBeatAgainstStoredEmbedding(beatDocument, c.asset.id).catch(() => null)");
    // No RONDE 4 identifiers leaked into the funnel.
    expect(funnelSrc).not.toContain("ensureArchiveEmbeddingCacheLoaded");
  });

  it("every async entry point that precedes the sync reads awaits the cache load", () => {
    const src = readFileSync(path.join(__dirname, "archiveEmbeddingIndex.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function scoreBeatAgainstStoredEmbedding"));
    expect(fn).toContain("await ensureArchiveEmbeddingCacheLoaded();");
  });

  it("coverage thresholds and funnel constants did not move (FIX 5 still not done)", () => {
    expect(funnelSrc).toContain("const KEYWORD_SCORE_MAX = 100;");
    expect(funnelSrc).toMatch(/const ARCHIVE_DOMINANT_THRESHOLD = envThreshold\("ARCHIVE_DOMINANT_THRESHOLD", 0\.46\)/);
    expect(funnelSrc).toMatch(/export const BEAT_ARCHIVE_STOP_THRESHOLD = archiveThreshold\("BEAT_ARCHIVE_STOP_THRESHOLD", 0\.50\)/);
    expect(funnelSrc).toContain("export const STOCK_TIER_WIN_MARGIN = 1.0;");
  });

  it("RONDE 1/2/3 are intact", () => {
    expect(funnelSrc).toContain("const unusedPassers = usedCandidateIds?.size");
    expect(funnelSrc).toContain('case "archive_only":\n    case "one_external":\n    case "all_external":');
    const adds = pipelineSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      .match(/dedup\.usedFunnelCandidateIds\.add\(candidate\.id\);/g) ?? [];
    expect(adds).toHaveLength(2);
    expect(poolSrc).toContain("const DETAIL_FETCH_CONCURRENCY = 5;");
  });

  it("the write call sites (upload/ingest/retag) still call the same function", () => {
    for (const f of ["archiveUpload.ts", "archiveIngestion.ts", "archiveBulkVisionTagging.ts", "archiveBulkGeoRetag.ts"]) {
      const src = readFileSync(path.join(__dirname, f), "utf8");
      expect(src, f).toContain("indexArchiveAssetEmbedding");
    }
  });
});
