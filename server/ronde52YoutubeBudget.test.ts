import { describe, expect, it, vi, afterEach } from "vitest";
import { YOUTUBE_META_PROBE_TIMEOUT_MS } from "./sourcingPolicy";

/**
 * RONDE 52 — YouTube found 60 videos in render 530 and contributed zero clips.
 *
 *   youtube_cc: searches=10  results=60  downloads=44  accepted=0
 *
 * Three faults, each pinned below:
 *
 *   1. The failure message named the wrong cause. Every fetch is aborted by EITHER its own timer
 *      OR the enclosing scene budget, but the error always reported its own timeout. Nine
 *      "RapidAPI YouTube meta exceeded 20s" landed within 2ms of each other — one abort, not
 *      nine timeouts — and one "exceeded 180s" was in the same batch, seconds after it started.
 *   2. The budgets could not fit. The rescue scope allowed 22s; inside it a search wanted 15s,
 *      a metadata call 20s and a download 180s. Eight times the containing budget.
 *   3. The breaker could not trip. markYoutubeSearchResult(false) sits after the resp.ok check,
 *      which a thrown timeout never reaches, so YouTube was retried 24 times while Wikimedia
 *      correctly stood itself down after three failures.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("RONDE 52 #1 — an abort names the signal that actually fired", () => {
  /** A server that accepts the connection and then never answers — a hanging provider. */
  const hangingServer = async () => {
    const http = await import("http");
    const sockets: import("net").Socket[] = [];
    const server = http.createServer(() => {
      /* deliberately never responds */
    });
    server.on("connection", (s) => sockets.push(s));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}/never`,
      close: () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy();
          server.close(() => resolve());
        }),
    };
  };

  it("a scope abort is reported as a scope abort, not as the call's own timeout", async () => {
    const { withSceneFetchTimeout, isScopeAbortError, fetchWithTimeout } = await import(
      "./videoPipeline"
    );
    const srv = await hangingServer();
    try {
      // The render-530 shape: an inner call with a generous limit inside a scope with a tight
      // one. The inner error is captured through a side channel — once the scope times out it
      // rejects on its own, so the inner failure cannot be returned through it.
      let inner: unknown;
      await withSceneFetchTimeout(
        async () => {
          try {
            await fetchWithTimeout(srv.url, 20_000, "RapidAPI YouTube meta scene 1");
          } catch (e) {
            inner = e;
          }
          return null;
        },
        300,
        "historical archival rescue s1 b2"
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));

      expect(inner).toBeInstanceOf(Error);
      expect(isScopeAbortError(inner)).toBe(true);
      const message = (inner as Error).message;
      // The old message claimed the inner call had exceeded its own 20 seconds. It had not: it
      // had been alive for a fraction of a second when the 300ms scope cut it off.
      expect(message).not.toMatch(/exceeded 20s/);
      expect(message).toMatch(/cancelled by the enclosing scene budget/);
      expect(message).toContain("RapidAPI YouTube meta scene 1");
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("a genuine own-timer timeout is still reported as one, and is NOT a scope abort", async () => {
    const { isScopeAbortError, fetchWithTimeout } = await import("./videoPipeline");
    const srv = await hangingServer();
    try {
      // No enclosing scope: the call's own 200ms timer is the only thing that can stop it.
      const err = await fetchWithTimeout(srv.url, 200, "YouTube CC search scene 1").catch(
        (e: Error) => e
      );
      expect(err).toBeInstanceOf(Error);
      expect(isScopeAbortError(err)).toBe(false);
      expect((err as Error).message).toMatch(/Timeout: YouTube CC search scene 1 exceeded 0s/);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("isScopeAbortError distinguishes the two, so a breaker can act on only one", async () => {
    const { isScopeAbortError } = await import("./videoPipeline");
    expect(isScopeAbortError(new Error("Timeout: X exceeded 20s"))).toBe(false);
    expect(isScopeAbortError(null)).toBe(false);
    expect(isScopeAbortError(undefined)).toBe(false);
    expect(isScopeAbortError("string")).toBe(false);
  });
});

describe("RONDE 52 #2 — a call sizes itself against the budget containing it", () => {

  it("a nested scope can never advertise more time than its parent", async () => {
    const { withSceneFetchTimeout, remainingScopeMs } = await import("./videoPipeline");
    await withSceneFetchTimeout(
      async () => {
        // Inner scope asks for far more than the outer one has.
        await withSceneFetchTimeout(
          async () => {
            expect(remainingScopeMs()).toBeLessThanOrEqual(3_000);
            return null;
          },
          60_000,
          "inner"
        );
        return null;
      },
      3_000,
      "outer"
    );
  }, 20_000);
});

describe("RONDE 52 — the wiring is where it needs to be", () => {
  const src = async () => {
    const { readFileSync } = await import("fs");
    const path = await import("path");
    return readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  };

  it("the YouTube search catch reaches the breaker, and exempts scope aborts", async () => {
    const s = await src();
    const guarded = [...s.matchAll(/if \(!isScopeAbortError\(err\)\) markYoutubeSearchResult\(false\);/g)];
    // The search catch. The RapidAPI download catch and its metadata helper left with RapidAPI.
    expect(guarded).toHaveLength(1);
    // And the breaker is never called unguarded from a catch block.
    expect(s).not.toMatch(/catch \(err\) \{\s*\n\s*markYoutubeSearchResult\(false\);/);
  });

  it("the scope carries a deadline so inner calls can read it", async () => {
    const s = await src();
    expect(s).toContain("deadlineAtMs");
    /**
     * The parent's deadline always wins when it is earlier. RONDE 259 reads the clock once into
     * `openedAtMs` — the same expression, computed once instead of twice, because the reserve is
     * sized against the window this scope actually got and the two readings must be one moment.
     */
    expect(s).toContain("const openedAtMs = Date.now();");
    expect(s).toContain("Math.min(openedAtMs + delayMs, parentDeadline)");
  });

  /**
   * The claim behind the line above, checked rather than spelled: a child asked for more than its
   * parent has left gets the parent's deadline, not its own.
   */
  it("AND IT HOLDS WHEN RUN: an oversized child never outlives its parent", async () => {
    const { withSceneFetchTimeout, remainingScopeMs } = await import("./videoPipeline");
    await withSceneFetchTimeout(
      async () => {
        const parentLeft = remainingScopeMs();
        await withSceneFetchTimeout(
          async () => {
            expect(remainingScopeMs()).toBeLessThanOrEqual(parentLeft);
            expect(remainingScopeMs()).toBeLessThan(120_000);
          },
          600_000,
          "r52 oversized child"
        );
      },
      5_000,
      "r52 parent"
    );
  });
});
