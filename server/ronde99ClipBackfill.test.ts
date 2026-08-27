/**
 * RONDE 99 — the backfill has to converge.
 *
 * backfillMissingClipEmbeddings walked every active video asset from `backfillAssetCursor`, a
 * module-level number, and asked the local filesystem per asset whether it already had an
 * embedding. Both halves break on restart: the cursor resets to 0, and the filesystem index sits
 * on ephemeral container disk. The Railway logs showed exactly that failure — `skipped 0` on
 * every batch, 289 asset ids indexed in two separate runs, and an id range that restarted below
 * the previous run's high-water mark.
 *
 * The work list now comes from the database (which assets have no indexed row), each asset is
 * claimed so two replicas cannot both take it, and the "still missing" number in the log is a
 * real count instead of `missing - indexed`.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  state: { dbAvailable: true, activeJobs: 0, claimAffected: 1 },
  indexAsset: vi.fn(async (_id: number, _p: string) => true),
  listBatch: vi.fn(async (_after: number, _limit: number) => [] as unknown[]),
}));
const { dbExecute } = hoisted;

vi.mock("./db", () => ({
  getDb: async () => (hoisted.state.dbAvailable ? { execute: hoisted.dbExecute } : null),
  listActiveVideoArchiveAssetsBatch: (after: number, limit: number) => hoisted.listBatch(after, limit),
}));
vi.mock("./videoQueue", () => ({
  workerLocalActiveJobs: () => hoisted.state.activeJobs,
}));
vi.mock("./storage", () => ({
  storageGetSignedUrl: async () => "https://signed.example/x.mp4",
}));
vi.mock("./storageLocal", () => ({
  LOCAL_UPLOADS_DIR: "/nonexistent-uploads-dir",
  // Every asset in these tests resolves to a local file, so nothing is downloaded and the
  // tests exercise the work-list/claim logic rather than the fetch path.
  resolveLocalVideoPath: (url: string) =>
    url.startsWith("/local-storage/") ? "/tmp/ronde99-fixture.mp4" : null,
}));
vi.mock("./archiveClipEmbedding", () => ({
  clipEmbeddingIndexEnabled: () => true,
  indexArchiveClipEmbedding: (id: number, p: string) => hoisted.indexAsset(id, p),
  loadStoredClipEmbedding: () => null,
}));

import { backfillMissingClipEmbeddings } from "./archiveClipIndexBackfill";
import { __resetClipEmbeddingStoreForTests } from "./archiveClipEmbeddingStore";

const BACKFILL_SRC = fs.readFileSync(path.join(__dirname, "archiveClipIndexBackfill.ts"), "utf8");

function sqlText(q: unknown): string {
  return JSON.stringify(q);
}
function calls(fragment: string): unknown[] {
  return dbExecute.mock.calls.filter(([q]) => sqlText(q).includes(fragment));
}

/** A local asset the indexer can reach without downloading anything. */
function asset(id: number) {
  return { id, storageUrl: `/local-storage/${id}.mp4`, storageKey: null };
}

function installDb(workList: ReturnType<typeof asset>[], remaining = 0) {
  dbExecute.mockImplementation(async (q: unknown) => {
    const text = sqlText(q);
    if (text.includes("CREATE TABLE")) return [];
    if (text.includes("SELECT a.id")) return workList;
    if (text.includes("COUNT(*)")) return [{ remaining }];
    if (text.includes("SELECT asset_id")) return [];
    return [{ affectedRows: hoisted.state.claimAffected }];
  });
}

let logLines: string[] = [];
const prevBackfillFlag = process.env.AUTO_CLIP_EMBEDDING_BACKFILL;

beforeEach(() => {
  __resetClipEmbeddingStoreForTests();
  dbExecute.mockReset();
  hoisted.indexAsset.mockReset();
  hoisted.indexAsset.mockImplementation(async () => true);
  hoisted.listBatch.mockReset();
  hoisted.listBatch.mockImplementation(async () => []);
  hoisted.state.dbAvailable = true;
  hoisted.state.activeJobs = 0;
  hoisted.state.claimAffected = 1;
  installDb([]);
  delete process.env.AUTO_CLIP_EMBEDDING_BACKFILL;
  logLines = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logLines.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevBackfillFlag === undefined) delete process.env.AUTO_CLIP_EMBEDDING_BACKFILL;
  else process.env.AUTO_CLIP_EMBEDDING_BACKFILL = prevBackfillFlag;
});

/* ═══════════ the work list ═══════════ */

describe("RONDE 99 — the backfill asks the database what is left", () => {
  it("TEST 1 — with a database it never walks the asset table from a cursor", async () => {
    installDb([asset(1), asset(2)]);
    const result = await backfillMissingClipEmbeddings(10);
    expect(result.indexed).toBe(2);
    expect(hoisted.listBatch).not.toHaveBeenCalled();
    expect(calls("SELECT a.id")).toHaveLength(1);
  });

  it("TEST 2 — every asset in the list is indexed; none is re-checked first", async () => {
    installDb([asset(3), asset(4), asset(5)]);
    await backfillMissingClipEmbeddings(10);
    expect(hoisted.indexAsset.mock.calls.map(([id]) => id)).toEqual([3, 4, 5]);
  });

  it("TEST 3 — the same run twice does not index the same asset twice", async () => {
    // The database is what makes this true: an indexed asset drops out of the work list.
    installDb([asset(9)]);
    await backfillMissingClipEmbeddings(10);
    installDb([]); // asset 9 now has an indexed row
    hoisted.indexAsset.mockClear();
    const second = await backfillMissingClipEmbeddings(10);
    expect(second.indexed).toBe(0);
    expect(hoisted.indexAsset).not.toHaveBeenCalled();
  });

  it("TEST 4 — the batch size is respected even when the work list is longer", async () => {
    installDb([1, 2, 3, 4, 5, 6].map(asset));
    const result = await backfillMissingClipEmbeddings(2);
    expect(result.indexed).toBe(2);
    expect(hoisted.indexAsset).toHaveBeenCalledTimes(2);
  });
});

/* ═══════════ claiming ═══════════ */

describe("RONDE 99 — one asset, one worker", () => {
  it("TEST 5 — each asset is claimed before it is indexed", async () => {
    installDb([asset(11)]);
    await backfillMissingClipEmbeddings(10);
    const claim = calls("INSERT INTO fastvid_archive_clip_embeddings");
    expect(claim.length).toBeGreaterThanOrEqual(1);
    expect(sqlText(claim[0])).toContain("'claimed'");
  });

  it("TEST 6 — an asset another replica holds is left alone", async () => {
    hoisted.state.claimAffected = 0; // ON DUPLICATE KEY UPDATE changed nothing
    installDb([asset(12), asset(13)]);
    const result = await backfillMissingClipEmbeddings(10);
    expect(hoisted.indexAsset).not.toHaveBeenCalled();
    expect(result.indexed).toBe(0);
  });

  it("TEST 7 — a claim on an asset that could not be indexed is released", async () => {
    hoisted.indexAsset.mockImplementation(async () => false);
    installDb([asset(14)]);
    await backfillMissingClipEmbeddings(10);
    expect(calls("DELETE FROM fastvid_archive_clip_embeddings")).toHaveLength(1);
  });

  it("TEST 8 — a successful index does not delete its own row", async () => {
    installDb([asset(15)]);
    await backfillMissingClipEmbeddings(10);
    expect(calls("DELETE FROM fastvid_archive_clip_embeddings")).toHaveLength(0);
  });
});

/* ═══════════ yielding to renders ═══════════ */

describe("RONDE 99 — the backfill still yields to a render", () => {
  it("TEST 9 — a render already running pauses the whole batch", async () => {
    hoisted.state.activeJobs = 1;
    installDb([asset(21)]);
    const result = await backfillMissingClipEmbeddings(10);
    expect(result).toEqual({ indexed: 0, skipped: 0, missing: 0 });
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it("TEST 10 — a render that starts mid-batch stops it at the next asset", async () => {
    installDb([asset(22), asset(23), asset(24)]);
    hoisted.indexAsset.mockImplementation(async () => {
      hoisted.state.activeJobs = 1;
      return true;
    });
    const result = await backfillMissingClipEmbeddings(10);
    expect(result.indexed).toBe(1);
    expect(logLines.join("\n")).toContain("yielding mid-batch");
  });

  it("TEST 11 — ignoreActiveJobCap still overrides the pause", async () => {
    hoisted.state.activeJobs = 2;
    installDb([asset(25)]);
    const result = await backfillMissingClipEmbeddings(10, { ignoreActiveJobCap: true });
    expect(result.indexed).toBe(1);
  });
});

/* ═══════════ the log line ═══════════ */

describe("RONDE 99 — the log stops claiming the archive is done", () => {
  it("TEST 12 — 'still missing' is the database's count, not the batch's arithmetic", async () => {
    installDb([asset(31)], 4821);
    await backfillMissingClipEmbeddings(10);
    const line = logLines.find((l) => l.includes("Backfill batch"));
    expect(line).toContain("archive still missing 4821");
  });

  it("TEST 13 — the old `missing - indexed` arithmetic is gone from the source", () => {
    // It printed "still missing ~0" whenever a batch finished its own scan, which read as
    // "the archive is fully indexed" while thousands of assets were untouched.
    expect(BACKFILL_SRC).not.toContain("still missing ~${Math.max(0, missing - indexed)}");
  });

  it("TEST 14 — assets held by another replica are reported, not silently dropped", async () => {
    hoisted.state.claimAffected = 0;
    installDb([asset(32), asset(33)], 7);
    await backfillMissingClipEmbeddings(10);
    expect(logLines.find((l) => l.includes("Backfill batch"))).toContain("claimed elsewhere 2");
  });
});

/* ═══════════ no database ═══════════ */

describe("RONDE 99 — without a database the old behaviour is untouched", () => {
  it("TEST 15 — the cursor scan is still there as the fallback", async () => {
    hoisted.state.dbAvailable = false;
    hoisted.listBatch.mockImplementationOnce(async () => [asset(41), asset(42)]);
    const result = await backfillMissingClipEmbeddings(10);
    expect(hoisted.listBatch).toHaveBeenCalled();
    expect(result.indexed).toBe(2);
  });

  it("TEST 16 — the fallback log says which strategy ran", async () => {
    hoisted.state.dbAvailable = false;
    hoisted.listBatch.mockImplementationOnce(async () => [asset(43)]);
    await backfillMissingClipEmbeddings(10);
    expect(logLines.find((l) => l.includes("Backfill batch"))).toContain("no index DB");
  });

  it("TEST 17 — the backfill can still be switched off entirely", async () => {
    process.env.AUTO_CLIP_EMBEDDING_BACKFILL = "false";
    installDb([asset(44)]);
    const result = await backfillMissingClipEmbeddings(10);
    expect(result).toEqual({ indexed: 0, skipped: 0, missing: 0 });
    expect(hoisted.indexAsset).not.toHaveBeenCalled();
  });
});
