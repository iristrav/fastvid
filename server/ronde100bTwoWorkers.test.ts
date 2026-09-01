/**
 * RONDE 100B §13 — two replicas, one asset.
 *
 * The RONDE 99 tests pinned the claim's SQL and its affectedRows contract by mocking what MySQL
 * would answer. That proves the code reads the answer correctly; it does not prove the answer
 * would be the one we expect. This runs both workers against a fake MySQL that actually enforces
 * a primary key and actually evaluates the ON DUPLICATE KEY UPDATE branch, so the two workers
 * genuinely race for the same row.
 *
 * The production evidence this is standing in for: log aa714a57 shows replica ade1401e indexing
 * 56719→56746 while replica db4f51dc indexed 56682→56710, interleaved, and every one of those 43
 * assets also appears in log a045a135 from a different window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  asset_id: number;
  status: string;
  attempts: number;
  claimed_by: string | null;
  claimed_at: number | null;
  updated_at: number;
  embedding: string | null;
  frame_embeddings: string | null;
  model: string;
};

const hoisted = vi.hoisted(() => ({
  /** The shared "database". One table, keyed like the real one. */
  table: new Map<number, Row>(),
  workerId: { current: "worker-A" },
}));

vi.mock("./db", () => ({
  getDb: async () => ({
    /**
     * Enough of MySQL to be honest about the one thing under test: a PRIMARY KEY on asset_id,
     * and ON DUPLICATE KEY UPDATE returning affectedRows 1 (inserted), 2 (changed) or 0 (nothing
     * changed). Everything else is answered as an empty result.
     */
    execute: async (q: unknown) => {
      const text = JSON.stringify(q);
      /**
       * drizzle interleaves the bound values between StringChunks as RAW values — a StringChunk
       * is the one carrying a `value` ARRAY, so the parameters are everything that is not one.
       * `sql.join(...)` nests whole SQL objects (the prefetch's `IN (...)` list is built that
       * way), so the chunk list has to be flattened before the values can be read off it.
       */
      const flatten = (list: unknown[]): unknown[] =>
        list.flatMap((c) => {
          const nested = (c as { queryChunks?: unknown[] })?.queryChunks;
          if (Array.isArray(nested)) return flatten(nested);
          return [c];
        });
      const chunks: unknown[] = flatten((q as { queryChunks?: unknown[] }).queryChunks ?? []);
      const params = chunks.filter(
        (c) => !(c && typeof c === "object" && Array.isArray((c as { value?: unknown }).value))
      );

      if (text.includes("CREATE TABLE")) return [];

      if (text.includes("INSERT INTO fastvid_archive_clip_embeddings") && text.includes("'claimed'")) {
        const assetId = Number(params[0]);
        const worker = String(params[1]);
        const staleBefore = params[2] instanceof Date ? params[2].getTime() : 0;
        const existing = hoisted.table.get(assetId);
        if (!existing) {
          hoisted.table.set(assetId, {
            asset_id: assetId, status: "claimed", attempts: 0,
            claimed_by: worker, claimed_at: Date.now(), updated_at: Date.now(),
            embedding: null, frame_embeddings: null, model: "",
          });
          return [{ affectedRows: 1 }];
        }
        // ON DUPLICATE KEY UPDATE: only a stale claim (or a retryable failure) changes hands.
        const claimIsStale =
          existing.status === "claimed" &&
          (existing.claimed_at === null || existing.claimed_at < staleBefore);
        if (!claimIsStale) return [{ affectedRows: 0 }];
        existing.claimed_by = worker;
        existing.claimed_at = Date.now();
        existing.status = "claimed";
        return [{ affectedRows: 2 }];
      }

      if (text.includes("INSERT INTO fastvid_archive_clip_embeddings") && text.includes("'indexed'")) {
        const assetId = Number(params[0]);
        hoisted.table.set(assetId, {
          asset_id: assetId, status: "indexed", attempts: 0,
          claimed_by: null, claimed_at: null, updated_at: Date.now(),
          embedding: String(params[2]), frame_embeddings: params[3] ? String(params[3]) : null,
          model: String(params[1]),
        });
        return [{ affectedRows: 1 }];
      }

      if (text.includes("SELECT asset_id")) {
        const wanted = params.map(Number).filter((n) => Number.isFinite(n));
        return [
          [...hoisted.table.values()]
            .filter((r) => r.status === "indexed" && wanted.includes(r.asset_id))
            .map((r) => ({
              assetId: r.asset_id, model: r.model, embedding: r.embedding,
              frameEmbeddings: r.frame_embeddings, updatedAt: String(r.updated_at),
            })),
        ];
      }

      if (text.includes("DELETE FROM")) {
        const assetId = Number(params[0]);
        const worker = String(params[1]);
        const row = hoisted.table.get(assetId);
        if (row && row.status === "claimed" && row.claimed_by === worker) hoisted.table.delete(assetId);
        return [{ affectedRows: 1 }];
      }

      return [];
    },
  }),
}));

import {
  __resetClipEmbeddingStoreForTests,
  cachedClipEmbedding,
  claimAssetForClipIndexing,
  persistClipEmbedding,
  prefetchClipEmbeddings,
  releaseClipIndexClaim,
} from "./archiveClipEmbeddingStore";

/** Run one worker's turn under its own identity. */
async function asWorker<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.RAILWAY_REPLICA_ID;
  process.env.RAILWAY_REPLICA_ID = id;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.RAILWAY_REPLICA_ID;
    else process.env.RAILWAY_REPLICA_ID = prev;
  }
}

beforeEach(() => {
  hoisted.table.clear();
  __resetClipEmbeddingStoreForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("RONDE 100B §13 — two workers cannot index the same asset", () => {
  it("TEST 1 — exactly one of two workers wins the claim", async () => {
    const a = await asWorker("replica-A", () => claimAssetForClipIndexing(56719));
    const b = await asWorker("replica-B", () => claimAssetForClipIndexing(56719));
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(a).toBe(true);
    expect(b).toBe(false);
  });

  it("TEST 2 — the loser is not blocked from a DIFFERENT asset", async () => {
    await asWorker("replica-A", () => claimAssetForClipIndexing(56719));
    expect(await asWorker("replica-B", () => claimAssetForClipIndexing(56720))).toBe(true);
  });

  it("TEST 3 — the two interleaved ranges from the production log do not collide", async () => {
    // replica ade1401e walked 56719.. and db4f51dc walked 56682.., interleaved in one log.
    const a = [56719, 56720, 56723, 56724];
    const b = [56682, 56683, 56684, 56685];
    const winners: Record<number, string> = {};
    for (let i = 0; i < a.length; i++) {
      if (await asWorker("A", () => claimAssetForClipIndexing(a[i]!))) winners[a[i]!] = "A";
      if (await asWorker("B", () => claimAssetForClipIndexing(b[i]!))) winners[b[i]!] = "B";
    }
    expect(Object.keys(winners)).toHaveLength(8);

    // Now the overlap that actually hurt: B reaches ids A already took.
    for (const id of a) {
      expect(await asWorker("B", () => claimAssetForClipIndexing(id)), `B stole ${id}`).toBe(false);
    }
  });

  it("TEST 4 — an indexed asset is never claimed again, by either worker", async () => {
    await asWorker("A", () => claimAssetForClipIndexing(900));
    await persistClipEmbedding({ assetId: 900, model: "m", embedding: [1, 0], updatedAt: "" });

    expect(await asWorker("A", () => claimAssetForClipIndexing(900))).toBe(false);
    expect(await asWorker("B", () => claimAssetForClipIndexing(900))).toBe(false);
  });

  it("TEST 5 — a restart does not re-index: the embedding is read back from the shared store", async () => {
    await asWorker("A", () => claimAssetForClipIndexing(901));
    await persistClipEmbedding({
      assetId: 901, model: "m", embedding: [0.5, 0.5], frameEmbeddings: [[0.5, 0.5]], updatedAt: "",
    });

    // The whole process goes away — new in-memory cache, same database.
    __resetClipEmbeddingStoreForTests();
    expect(cachedClipEmbedding(901)).toBeNull();

    await prefetchClipEmbeddings([901]);
    expect(cachedClipEmbedding(901)?.embedding).toEqual([0.5, 0.5]);
    expect(await asWorker("B", () => claimAssetForClipIndexing(901))).toBe(false);
  });

  it("TEST 6 — a worker that crashed mid-index does not hold the asset forever", async () => {
    await asWorker("A", () => claimAssetForClipIndexing(902));
    expect(await asWorker("B", () => claimAssetForClipIndexing(902))).toBe(false);

    // A died. Age its claim past the TTL.
    const row = hoisted.table.get(902)!;
    row.claimed_at = Date.now() - 60 * 60_000;

    expect(await asWorker("B", () => claimAssetForClipIndexing(902))).toBe(true);
    expect(hoisted.table.get(902)!.claimed_by).toBe("B");
  });

  it("TEST 7 — a released claim frees the asset immediately", async () => {
    await asWorker("A", () => claimAssetForClipIndexing(903));
    await asWorker("A", () => releaseClipIndexClaim(903));
    expect(await asWorker("B", () => claimAssetForClipIndexing(903))).toBe(true);
  });

  it("TEST 8 — one worker cannot release another's claim", async () => {
    await asWorker("A", () => claimAssetForClipIndexing(904));
    await asWorker("B", () => releaseClipIndexClaim(904));
    expect(hoisted.table.get(904)?.claimed_by).toBe("A");
  });

  it("TEST 9 — twenty concurrent attempts on one asset produce exactly one winner", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => asWorker(`replica-${i}`, () => claimAssetForClipIndexing(999)))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
