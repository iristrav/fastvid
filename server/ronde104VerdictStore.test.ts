/**
 * RONDE 104 — a verdict survives the render, against a database that behaves like one.
 *
 * The point of this store is that a re-render does not pay again for an answer it already owns.
 * Testing that against a mock which simply returns what it was told proves the code reads its own
 * mock; this runs it against a fake MySQL that actually enforces a primary key, actually applies
 * ON DUPLICATE KEY UPDATE, and actually honours the TTL predicate — so a hit is a hit for the
 * reason production would give one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = { verdict: string; depicts: string; reason: string; model: string; hits: number; updatedAt: number };

const hoisted = vi.hoisted(() => ({
  table: new Map<string, Row>(),
  /** Set to a past time to simulate a row older than the TTL. */
  now: { value: Date.now() },
  queries: [] as string[],
}));

const TTL_MS = 90 * 24 * 60 * 60 * 1000;

vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: unknown) => {
      const text = JSON.stringify(q);
      hoisted.queries.push(text);
      /** drizzle interleaves bound values between StringChunks; a StringChunk carries an ARRAY. */
      const flatten = (list: unknown[]): unknown[] =>
        list.flatMap((c) => {
          const nested = (c as { queryChunks?: unknown[] })?.queryChunks;
          return Array.isArray(nested) ? flatten(nested) : [c];
        });
      const chunks = flatten((q as { queryChunks?: unknown[] }).queryChunks ?? []);
      const params = chunks.filter(
        (c) => !(c && typeof c === "object" && Array.isArray((c as { value?: unknown }).value))
      );

      if (text.includes("CREATE TABLE")) return [];

      if (text.includes("INSERT INTO fastvid_beat_relevance_verdicts")) {
        const [key, verdict, depicts, reason, model] = params.map(String);
        const existing = hoisted.table.get(key!);
        hoisted.table.set(key!, {
          verdict: verdict!, depicts: depicts!, reason: reason!, model: model!,
          hits: existing ? existing.hits + 1 : 0,
          updatedAt: hoisted.now.value,
        });
        return [{ affectedRows: existing ? 2 : 1 }];
      }

      if (text.includes("SELECT verdict_key")) {
        const key = String(params[0]);
        const row = hoisted.table.get(key);
        // The TTL predicate is part of the query, so the fake honours it.
        if (!row || hoisted.now.value - row.updatedAt > TTL_MS) return [[]];
        return [[{ verdictKey: key, verdict: row.verdict, depicts: row.depicts, reason: row.reason }]];
      }
      return [];
    },
  }),
}));

import {
  __resetVerdictStoreForTests,
  cachedVerdict,
  lookupVerdict,
  persistVerdict,
} from "./beatRelevanceVerdictStore";

beforeEach(() => {
  hoisted.table.clear();
  hoisted.queries.length = 0;
  hoisted.now.value = Date.now();
  __resetVerdictStoreForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const KEY = "archive:4711|9f2c1ab0deadbeef";

describe("RONDE 104 — the verdict store", () => {
  it("TEST 1 — an unknown pair has no answer", async () => {
    expect(await lookupVerdict(KEY)).toBeNull();
  });

  it("TEST 2 — a stored verdict comes back with what the model actually said", async () => {
    await persistVerdict(KEY, "does_not_fit", "a roadside sticker", "not about the battle");
    __resetVerdictStoreForTests(); // a different process, same database
    const v = await lookupVerdict(KEY);
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe("does_not_fit");
    expect(v!.depicts).toBe("a roadside sticker");
    expect(v!.reason).toBe("not about the battle");
  });

  it("TEST 3 — the SAME picture on a different beat is a different key, and misses", async () => {
    // This is the RONDE 103 rule, now enforced across renders too: the pair is the unit.
    await persistVerdict("archive:4711|beat-berlin", "fits", "ruins", "matches");
    __resetVerdictStoreForTests();
    expect(await lookupVerdict("archive:4711|beat-boardroom")).toBeNull();
    expect(await lookupVerdict("archive:4711|beat-berlin")).not.toBeNull();
  });

  it("TEST 4 — a second read of the same key does not hit the database again", async () => {
    await persistVerdict(KEY, "fits", "d", "r");
    __resetVerdictStoreForTests();
    await lookupVerdict(KEY);
    const afterFirst = hoisted.queries.filter((q) => q.includes("SELECT verdict_key")).length;
    await lookupVerdict(KEY);
    await lookupVerdict(KEY);
    expect(hoisted.queries.filter((q) => q.includes("SELECT verdict_key")).length).toBe(afterFirst);
  });

  it("TEST 5 — a MISS is cached too, so a genuinely new pair is asked for once", async () => {
    await lookupVerdict("never|seen");
    const afterFirst = hoisted.queries.filter((q) => q.includes("SELECT verdict_key")).length;
    await lookupVerdict("never|seen");
    expect(hoisted.queries.filter((q) => q.includes("SELECT verdict_key")).length).toBe(afterFirst);
    expect(cachedVerdict("never|seen")).toBeNull();
  });

  it("TEST 6 — a verdict older than the TTL is not served", async () => {
    await persistVerdict(KEY, "fits", "d", "r");
    __resetVerdictStoreForTests();
    hoisted.now.value += TTL_MS + 60_000;
    expect(await lookupVerdict(KEY)).toBeNull();
  });

  it("TEST 7 — re-persisting the same pair updates rather than duplicating", async () => {
    await persistVerdict(KEY, "fits", "first", "r1");
    await persistVerdict(KEY, "does_not_fit", "second", "r2");
    expect(hoisted.table.size).toBe(1);
    expect(hoisted.table.get(KEY)!.verdict).toBe("does_not_fit");
    expect(hoisted.table.get(KEY)!.hits).toBe(1);
    __resetVerdictStoreForTests();
    expect((await lookupVerdict(KEY))!.depicts).toBe("second");
  });

  it("TEST 8 — a write that throws costs the caller nothing", async () => {
    /**
     * `persistVerdict` puts the verdict in the in-process cache BEFORE it touches the database,
     * on purpose: the render already has its answer, and a connection problem must cost it a
     * future saving, never the verdict it just paid for. So the write reports failure and this
     * process keeps the answer — what is lost is only that the NEXT process will have to ask.
     */
    const boom = { execute: async () => { throw new Error("connection lost"); } };
    vi.resetModules();
    vi.doMock("./db", () => ({ getDb: async () => boom }));
    const store = await import("./beatRelevanceVerdictStore");
    store.__resetVerdictStoreForTests();

    await expect(store.persistVerdict(KEY, "fits", "d", "r")).resolves.toBe(false);
    expect(store.cachedVerdict(KEY)?.verdict).toBe("fits");

    // A fresh process has nothing, and a lookup against the broken database returns null rather
    // than throwing — the gate must be able to treat "store down" as "store had no answer".
    store.__resetVerdictStoreForTests();
    await expect(store.lookupVerdict(KEY)).resolves.toBeNull();

    vi.doUnmock("./db");
    vi.resetModules();
  });

  it("TEST 9 — the store can be switched off entirely", async () => {
    process.env.BEAT_VERDICT_STORE_DISABLED = "1";
    try {
      __resetVerdictStoreForTests();
      await persistVerdict("off|key", "fits", "d", "r");
      expect(hoisted.table.has("off|key")).toBe(false);
    } finally {
      delete process.env.BEAT_VERDICT_STORE_DISABLED;
    }
  });
});
