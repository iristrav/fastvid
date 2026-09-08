/**
 * TWO RENDERS OF ONE VIDEO CANNOT BOTH BE RUNNING.
 *
 * ── The record that could not say which run it described ─────────────────────────────────────
 *
 * Video 574's stored report carried `renderId=rmtspxhka-1` over a window of 147 milliseconds,
 * beside `gateAttempts=0`. The run that produced the delivered film was `rmtsu22cb-1`, lasted
 * twenty-one minutes, and its own log said `attempts=54 answered=54`. Two runs, one record, and
 * two rounds of analysis reasoned about the difference before anyone noticed.
 *
 * R190 made that visible. This makes it impossible: `runVideoPipeline` had no concurrency guard
 * of any kind, and a module-level boolean would not have been one — FastVid runs more than one
 * worker, a deploy overlaps two instances, and a restart forgets.
 *
 * ── What these tests prove, and what they cannot ─────────────────────────────────────────────
 *
 * The SEQUENCING is proven here: insert-first rather than read-then-decide, holder-scoped release,
 * a takeover conditional on the expiry the caller saw, and a refusal that names both renders.
 *
 * The ATOMICITY is not, and cannot be from here — there is no database in this environment. It
 * comes from `render_locks.videoId` being UNIQUE and from the conditional UPDATE's own WHERE
 * clause, both of which are properties of the schema in `drizzle/0052_ronde192_render_locks.sql`.
 * The store below enforces those two rules exactly as MySQL would, so what is tested is that this
 * module BEHAVES correctly given a store that keeps its promises. That the real store keeps them
 * is a claim about the migration, stated and not exercised.
 */
import { describe, expect, it } from "vitest";

import {
  acquireRenderLock,
  extendRenderLock,
  formatRenderLock,
  formatRenderLockRelease,
  releaseRenderLock,
  RENDER_LOCK_LEASE_MS,
  type RenderLockRow,
  type RenderLockStore,
} from "./renderLock";

/**
 * A store with MySQL's two guarantees and nothing else.
 *
 * The unique key: `insertIfAbsent` refuses when a row for that video exists. The conditional
 * update: `takeOverIfExpired` changes a row only when the stored expiry is still the one the
 * caller saw. A store that is looser than this would let these tests pass on a lock that does not
 * lock.
 */
function fakeStore(): RenderLockStore & { rows: Map<number, RenderLockRow>; calls: string[] } {
  const rows = new Map<number, RenderLockRow>();
  const calls: string[] = [];
  return {
    rows,
    calls,
    async insertIfAbsent(row) {
      calls.push("insert");
      if (rows.has(row.videoId)) return false;
      rows.set(row.videoId, { ...row });
      return true;
    },
    async read(videoId) {
      calls.push("read");
      const row = rows.get(videoId);
      return row ? { ...row } : null;
    },
    async takeOverIfExpired(row, seenExpiry) {
      calls.push("takeover");
      const current = rows.get(row.videoId);
      if (!current) return false;
      if (current.expiresAt.getTime() !== seenExpiry.getTime()) return false;
      rows.set(row.videoId, { ...row });
      return true;
    },
    async releaseOwn(videoId, productionRenderId) {
      calls.push("release");
      const current = rows.get(videoId);
      if (!current || current.productionRenderId !== productionRenderId) return false;
      rows.delete(videoId);
      return true;
    },
    async extendOwn(videoId, productionRenderId, expiresAt) {
      calls.push("extend");
      const current = rows.get(videoId);
      if (!current || current.productionRenderId !== productionRenderId) return false;
      rows.set(videoId, { ...current, expiresAt });
      return true;
    },
  };
}

const NOW = new Date("2026-09-08T15:00:00.000Z");

/* ═══════════════════════ Test A — the same video ═══════════════════════ */

describe("two renders of the same video", () => {
  it("exactly one gets the lock", async () => {
    const store = fakeStore();
    const a = await acquireRenderLock(store, { videoId: 570, productionRenderId: "A", now: NOW });
    const b = await acquireRenderLock(store, { videoId: 570, productionRenderId: "B", now: NOW });
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(false);
  });

  it("the refusal names the render that holds it, not just that it is held", async () => {
    const store = fakeStore();
    await acquireRenderLock(store, { videoId: 570, productionRenderId: "A", now: NOW });
    const b = await acquireRenderLock(store, { videoId: 570, productionRenderId: "B", now: NOW });
    expect(b.acquired === false && b.reason).toBe("RENDER_ALREADY_RUNNING");
    expect(b.acquired === false && b.existingRenderId).toBe("A");
    expect(b.acquired === false && b.requestedRenderId).toBe("B");
  });

  it("the acquire asks the key first, never a read it then acts on", async () => {
    /**
     * Read-then-decide is the classic race: both workers read "free", both insert, one gets an
     * error it has no plan for. The first call this module makes must be the INSERT.
     */
    const store = fakeStore();
    await acquireRenderLock(store, { videoId: 570, productionRenderId: "A", now: NOW });
    expect(store.calls[0]).toBe("insert");
  });

  it("ten simultaneous requests still produce one winner", async () => {
    const store = fakeStore();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        acquireRenderLock(store, { videoId: 570, productionRenderId: `R${i}`, now: NOW })
      )
    );
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
  });
});

/* ═══════════════════════ Test B — different videos ═══════════════════════ */

describe("different videos are not each other's business", () => {
  it("both may run", async () => {
    const store = fakeStore();
    const a = await acquireRenderLock(store, { videoId: 570, productionRenderId: "A", now: NOW });
    const b = await acquireRenderLock(store, { videoId: 571, productionRenderId: "B", now: NOW });
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });

  it("releasing one does not touch the other", async () => {
    const store = fakeStore();
    await acquireRenderLock(store, { videoId: 570, productionRenderId: "A", now: NOW });
    await acquireRenderLock(store, { videoId: 571, productionRenderId: "B", now: NOW });
    await releaseRenderLock(store, 570, "A");
    expect(store.rows.has(571)).toBe(true);
  });
});

/* ═══════════════════════ Test C — a lease nobody released ═══════════════════════ */

describe("a crashed worker does not make a video unrenderable", () => {
  const later = new Date(NOW.getTime() + RENDER_LOCK_LEASE_MS + 1000);

  it("an expired lease can be taken over", async () => {
    const store = fakeStore();
    await acquireRenderLock(store, { videoId: 570, productionRenderId: "A", now: NOW });
    const b = await acquireRenderLock(store, { videoId: 570, productionRenderId: "B", now: later });
    expect(b.acquired).toBe(true);
  });

  it("and the takeover says so, rather than looking like a clean start", async () => {
    const store = fakeStore();
    await acquireRenderLock(store, { videoId: 570, productionRenderId: "A", now: NOW });
    const b = await acquireRenderLock(store, { videoId: 570, productionRenderId: "B", now: later });
    expect(b.acquired === true && b.lock.recoveredStale).toBe(true);
    expect(formatRenderLock(b)).toContain("STALE_LOCK_RECOVERED");
  });

  it("a lease that has NOT expired is not taken over", async () => {
    const store = fakeStore();
    await acquireRenderLock(store, { videoId: 570, productionRenderId: "A", now: NOW });
    const soon = new Date(NOW.getTime() + 60_000);
    const b = await acquireRenderLock(store, { videoId: 570, productionRenderId: "B", now: soon });
    expect(b.acquired).toBe(false);
  });

  it("two workers finding the same dead lease still produce one winner", async () => {
    /**
     * The takeover is conditional on the expiry each caller SAW. The second one matches no row,
     * because the first already moved it.
     */
    const store = fakeStore();
    await acquireRenderLock(store, { videoId: 570, productionRenderId: "A", now: NOW });
    const [b, c] = await Promise.all([
      acquireRenderLock(store, { videoId: 570, productionRenderId: "B", now: later }),
      acquireRenderLock(store, { videoId: 570, productionRenderId: "C", now: later }),
    ]);
    expect([b.acquired, c.acquired].filter(Boolean)).toHaveLength(1);
  });

  it("a live render keeps its lease by extending it", async () => {
    const store = fakeStore();
    await acquireRenderLock(store, { videoId: 570, productionRenderId: "A", now: NOW });
    await extendRenderLock(store, 570, "A", { now: later });
    const b = await acquireRenderLock(store, { videoId: 570, productionRenderId: "B", now: later });
    expect(b.acquired).toBe(false);
  });

  it("a render that no longer holds the lock cannot extend it", async () => {
    const store = fakeStore();
    await acquireRenderLock(store, { videoId: 570, productionRenderId: "A", now: NOW });
    expect(await extendRenderLock(store, 570, "SOMEONE_ELSE", { now: NOW })).toBe(false);
  });
});

/* ═══════════════════════ Tests D and E — every ending gives it back ═══════════════════════ */

describe("the lock is released on every ending", () => {
  it("after a success the next render may start", async () => {
    const store = fakeStore();
    await acquireRenderLock(store, { videoId: 570, productionRenderId: "A", now: NOW });
    expect(await releaseRenderLock(store, 570, "A")).toBe(true);
    const b = await acquireRenderLock(store, { videoId: 570, productionRenderId: "B", now: NOW });
    expect(b.acquired).toBe(true);
  });

  it("release is holder-scoped, so an overrun render cannot take its successor's lock", async () => {
    /**
     * A renders past its lease, B takes over, A finally finishes and releases. If release were
     * keyed on the video alone, A's tidy-up would unlock a video B is still rendering.
     */
    const store = fakeStore();
    await acquireRenderLock(store, { videoId: 570, productionRenderId: "A", now: NOW });
    const later = new Date(NOW.getTime() + RENDER_LOCK_LEASE_MS + 1000);
    await acquireRenderLock(store, { videoId: 570, productionRenderId: "B", now: later });
    expect(await releaseRenderLock(store, 570, "A")).toBe(false);
    expect(store.rows.get(570)?.productionRenderId).toBe("B");
  });

  it("and it says which of the two happened", async () => {
    expect(formatRenderLockRelease(570, "A", true)).toContain("RELEASED");
    expect(formatRenderLockRelease(570, "A", false)).toContain("RELEASE_NOOP");
  });

  it("releasing a lock nobody holds is not an error", async () => {
    /** Called from a `finally` on every path, including ones where the acquire never happened. */
    expect(await releaseRenderLock(fakeStore(), 570, "A")).toBe(false);
  });
});

/* ═══════════════════════ Test F — a refused render writes nothing ═══════════════════════ */

describe("a refused second render leaves no trace", () => {
  it("it never reaches the pipeline, because the lock is taken before any scope is opened", async () => {
    /**
     * Structural, and the only honest way to assert it: the guarantee is not a behaviour to
     * measure but an ORDER — the acquire and its refusal sit above every `with…Scope` wrapper and
     * above `_runVideoPipelineInner`, so a refused request has nothing to write into.
     */
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const acquire = src.indexOf("await acquireRenderLock(dbRenderLockStore");
    const refusal = src.indexOf("PIPELINE_ERROR.RENDER_ALREADY_RUNNING");
    const firstScope = src.indexOf("return await withVisionCensus(visionCensus");
    expect(acquire, "the lock is not taken in runVideoPipeline").toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(acquire);
    expect(refusal, "a refusal must happen before any pipeline scope opens").toBeLessThan(firstScope);
  });

  it("the release is in a finally, so no ending can keep the lock", async () => {
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const at = src.indexOf("return await withVisionCensus(visionCensus");
    const tail = src.slice(at, at + 2000);
    expect(tail).toContain("} finally {");
    expect(tail).toContain("releaseRenderLock(dbRenderLockStore, videoId, productionRenderId)");
  });

  it("the lock uses the pipeline's own id minter, not a fourth vocabulary", async () => {
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(src).toContain("const productionRenderId = newRenderId();");
  });
});

/* ═══════════════════════ the lease is a number somebody chose ═══════════════════════ */

describe("the lease bounds silence, not work", () => {
  it("it is comfortably longer than a real render", async () => {
    /** Renders 573 and 574 ran 21.5 and 17 minutes; the cinematic pass alone is bounded at 20. */
    expect(RENDER_LOCK_LEASE_MS).toBeGreaterThan(25 * 60_000);
  });

  it("and short enough that a crash does not cost an hour", async () => {
    expect(RENDER_LOCK_LEASE_MS).toBeLessThanOrEqual(60 * 60_000);
  });

  it("with no database the lock is vacuous, and says so rather than blocking every render", async () => {
    /**
     * With `DATABASE_URL` unset the pipeline persists nothing — no metadata, no report, no lineage
     * — so two such runs cannot overwrite each other's record. Refusing them would stop every
     * development render to prevent a collision that cannot happen. The warning is what keeps that
     * from reading as enforcement: a misconfigured worker must not look isolated.
     */
    const { dbRenderLockStore } = await import("./db");
    expect(
      await dbRenderLockStore.insertIfAbsent({ videoId: 570, productionRenderId: "A", expiresAt: NOW })
    ).toBe(true);
  });

  it("and the release is honest about it too", async () => {
    const { dbRenderLockStore } = await import("./db");
    expect(await dbRenderLockStore.releaseOwn(570, "A")).toBe(false);
  });
});
