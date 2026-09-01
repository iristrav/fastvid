/**
 * RONDE 173 — a hundred and fifty-six provider searches, and a query cache that saw none of them.
 *
 * ── What render 555 measured ─────────────────────────────────────────────────────────────────
 *
 *     [SearchGate]      TOTAL built=554 validated=156 rejected=398 sent=156 bypassAttempts=0
 *     [SourcingMetrics] videoId=- queryHits=0 queryMisses=0 assetHits=0 downloads=0
 *                       networkCallsAvoided=0 searches=0 providers=5
 *
 * The gate admitted and sent 156 searches. The cache counted zero of them, on a render whose
 * delivered assets came from pexels (94), internet_archive (67), nasa (52) and loc (42) — none of
 * which even appear in the five providers the metrics block lists.
 *
 * ── The cause, counted ───────────────────────────────────────────────────────────────────────
 *
 * `cachedProviderSearch` opens with `if (!cache) return search();`. No cache means no dedup, no
 * counting, and a fresh network call for a query that may have been asked three beats ago.
 *
 * A scan of the seven provider fetchers that accept a `sourcingCache` parameter:
 *
 *     fetchPexelsClips                 0 of 11 call sites pass it
 *     fetchPixabayClips                0 of 10
 *     fetchInternetArchiveClips        3 of  7
 *     fetchNasaVideoClips              2 of  6
 *     fetchPersonCelebrityVideoClips   2 of  6
 *     fetchEuropeanaVideos             2 of  4
 *     fetchWikimediaVideos             3 of  5
 *                                     ─────────
 *                                     35 of 72 — 37 call sites reaching the network uncached
 *
 * Pexels and Pixabay, the two highest-volume providers, passed it at ZERO of their twenty-one
 * sites. Nothing was broken; the cache simply was not reachable from most of the code that needed
 * it.
 *
 * ── The fix, and why not 37 edits ────────────────────────────────────────────────────────────
 *
 * The cache sits at parameter index 9, 10 or 12 depending on the fetcher, behind optional
 * arguments with defaults. Threading it through 37 sites is 37 chances to put a `usedProviderKeys`
 * where a `stockBeatCtx` belongs, and the 38th site added next round starts uncovered again.
 *
 * `RenderCtx` already exists for exactly this shape of problem — the budget tracker, the watchdog
 * and the video topic are all reached through it — and it is per-render by construction, so two
 * concurrent renders on one worker cannot share a cache. The render publishes its cache once, and
 * `cachedProviderSearch` falls back to it when a caller had none to give.
 *
 * ── What it does NOT change ──────────────────────────────────────────────────────────────────
 *
 * Nothing about what a search returns. A cache hit replays the identical payload the miss stored,
 * so ranking, the gates, licensing and vision all see exactly what they saw before — they simply
 * see it without a second round trip. The SearchGate still decides admission BEFORE the cache is
 * consulted, so a query that may not be sent is still not sent.
 */
import { describe, expect, it } from "vitest";

import {
  cachedProviderSearch,
  createSourcingCache,
  logSourcingMetrics,
  withRenderSourcingCacheScope,
} from "./videoPipeline";
import { withSearchProvenance, emptyQueryContext } from "./searchQueryContract";

/** A provider search that counts how often it actually reaches "the network". */
function countingProvider<T>(payload: T) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    search: async (): Promise<T> => {
      calls += 1;
      return payload;
    },
  };
}

/**
 * The ambient proof a real beat search runs under, so the SearchGate admits these queries.
 *
 * The beat's own words are what proves them — check C of the validator, "the script's own words
 * prove themselves". Nothing here weakens the gate: a word the beat does not contain is still
 * refused, which the "unbacked query" test below relies on.
 */
function withProvenBeat<T>(beatText: string, fn: () => Promise<T>): Promise<T> {
  return withSearchProvenance(emptyQueryContext(beatText), fn);
}

describe("RONDE 173 — the same query does not go to the same provider twice", () => {
  it("BEFORE: with no cache reachable, every repeat is a fresh network call", async () => {
    // This is render 555's shape: `cachedProviderSearch(undefined, …)` — the 37 call sites.
    const provider = countingProvider(["a", "b"]);
    await withProvenBeat("Churchill", async () => {
      for (let i = 0; i < 5; i++) {
        await cachedProviderSearch(undefined, "pexels", "Churchill", provider.search, "test");
      }
    });
    expect(provider.calls).toBe(5);
  });

  it("AFTER: the same five repeats cost one call", async () => {
    const cache = createSourcingCache();
    const provider = countingProvider(["a", "b"]);
    await withProvenBeat("Churchill", async () => {
      for (let i = 0; i < 5; i++) {
        await cachedProviderSearch(cache, "pexels", "Churchill", provider.search, "test");
      }
    });
    expect(provider.calls).toBe(1);
    expect(cache.totals.queryCacheHits).toBe(4);
  });

  it("a cache hit replays the identical payload — nothing downstream sees a different search", async () => {
    /**
     * The regression guarantee this whole round rests on. Ranking, the metadata gate, licensing
     * and VisionGate all read what the provider returned; if a hit returned anything but the same
     * object, "faster" would be bought with a different render.
     */
    const cache = createSourcingCache();
    const payload = [{ id: 1, title: "Churchill at Tehran" }];
    const provider = countingProvider(payload);
    const [first, second] = await withProvenBeat("Churchill", async () => [
      await cachedProviderSearch(cache, "pexels", "Churchill", provider.search, "test"),
      await cachedProviderSearch(cache, "pexels", "Churchill", provider.search, "test"),
    ]);
    expect(second).toBe(first);
    expect(second).toEqual(payload);
    expect(provider.calls).toBe(1);
  });

  it("different queries and different providers are still separate searches", async () => {
    // The cache must collapse repeats, never distinct questions.
    const cache = createSourcingCache();
    const provider = countingProvider(["x"]);
    await withProvenBeat("Churchill and Stalin", async () => {
      await cachedProviderSearch(cache, "pexels", "Churchill", provider.search, "test");
      await cachedProviderSearch(cache, "pexels", "Stalin", provider.search, "test");
      await cachedProviderSearch(cache, "pixabay", "Churchill", provider.search, "test");
    });
    expect(provider.calls).toBe(3);
    expect(cache.totals.queryCacheHits).toBe(0);
  });

  it("a failed search is not cached as an answer", async () => {
    /**
     * Caching a throw would turn one provider hiccup into a render-long outage for that query.
     * The miss is counted, the payload is not stored, and the next ask really asks again.
     */
    const cache = createSourcingCache();
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error("provider 503");
      return ["recovered"];
    };
    await withProvenBeat("Churchill", async () => {
      await expect(
        cachedProviderSearch(cache, "pexels", "Churchill", flaky, "test")
      ).rejects.toThrow("provider 503");
      expect(await cachedProviderSearch(cache, "pexels", "Churchill", flaky, "test"))
        .toEqual(["recovered"]);
    });
    expect(calls).toBe(2);
  });

  it("the gate still decides admission BEFORE the cache is consulted", async () => {
    /**
     * A query with nothing backing it is refused in strict mode and must not be sent — and must
     * not be cached either, or one refusal would be replayed as an empty result all render.
     */
    const cache = createSourcingCache();
    const provider = countingProvider(["never"]);
    const out = await cachedProviderSearch(cache, "pexels", "unbacked query", provider.search, "test");
    expect(out).toEqual([]);
    expect(provider.calls).toBe(0);
    expect(cache.queries.size).toBe(0);
  });
});

describe("RONDE 173 — the saving, measured", () => {
  it("a render's repeated questions collapse to one call each", async () => {
    /**
     * Render 555's own shape, scaled down: nineteen beats asking a handful of recurring questions
     * across four providers. The number that matters is the ratio, and it is reported rather than
     * asserted tightly — the point is that it is far below 1:1, not that it is exactly this.
     */
    const questions = ["Tehran Conference", "Winston Churchill", "Joseph Stalin", "1943 newsreel"];
    const providers = ["pexels", "pixabay", "wikimedia", "internet_archive"];
    const beats = 19;
    // Every question is drawn from the beat's own words, as a real query builder's would be —
    // otherwise the gate refuses it and no search of either kind is made.
    const beatText =
      "At the Tehran Conference in 1943 a newsreel filmed Winston Churchill beside Joseph Stalin.";

    const run = async (cache: ReturnType<typeof createSourcingCache> | undefined) => {
      let network = 0;
      const search = async () => {
        network += 1;
        return ["asset"];
      };
      await withProvenBeat(beatText, async () => {
        for (let beat = 0; beat < beats; beat++) {
          for (const p of providers) {
            await cachedProviderSearch(cache, p, questions[beat % questions.length], search, "test");
          }
        }
      });
      return network;
    };

    const before = await run(undefined);
    const after = await run(createSourcingCache());
    expect(before).toBe(beats * providers.length);
    expect(after).toBe(questions.length * providers.length);
    // 76 network searches down to 16 on this shape.
    expect(after).toBeLessThan(before / 4);
  });
});

describe("RONDE 173 — reachable without being passed", () => {
  it("the render publishes its cache on RenderCtx exactly once", () => {
    /**
     * One publisher, so a second render stage cannot quietly swap the cache mid-render. The
     * declaration and the scope helper that tests the ambient path are named rather than counted
     * away — a bare occurrence count would drift with any comment mentioning the setter.
     */
    const src = pipelineSource();
    const publishers = (src.match(/^\s*set_activeSourcingCache\(.*\);$/gm) ?? []).map((l) => l.trim());
    expect(publishers.slice().sort()).toEqual([
      "set_activeSourcingCache(cache);", // withRenderSourcingCacheScope
      "set_activeSourcingCache(visualDedup.sourcingCache);", // the render, once
    ]);
    expect((src.match(/^function set_activeSourcingCache\(/gm) ?? []).length).toBe(1);
  });

  it("cachedProviderSearch falls back to it, and to nothing else", () => {
    // Bounded by the function's own end, not by the file: the old line is quoted in this round's
    // prose upstream, and a whole-file `not.toContain` is satisfied — or defeated — by a comment.
    const src = pipelineSource();
    const start = src.indexOf("export async function cachedProviderSearch<T>(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("export function logSourcingMetrics(", start));
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("const activeCache = cache ?? get_activeSourcingCache() ?? undefined;");
    // The old unconditional bail is gone — that line was the whole leak.
    expect(body).not.toMatch(/^\s*if \(!cache\) return search\(\);/m);
    // And the gate is still consulted first, on the line that decides.
    expect(body.indexOf("if (!decision.admitted)")).toBeLessThan(body.indexOf("const activeCache"));
  });

  it("the 37 uncached call sites now hit the render's cache, passing nothing", async () => {
    /**
     * THE round, as behaviour. Every argument is what render 555's uncached sites pass —
     * `cachedProviderSearch(undefined, …)` — and the saving comes from the render context alone.
     */
    const cache = createSourcingCache();
    const provider = countingProvider(["a"]);
    await withRenderSourcingCacheScope(cache, () =>
      withProvenBeat("Churchill", async () => {
        for (let i = 0; i < 5; i++) {
          await cachedProviderSearch(undefined, "pexels", "Churchill", provider.search, "test");
        }
      })
    );
    expect(provider.calls).toBe(1);
    expect(cache.totals.queryCacheHits).toBe(4);
  });

  it("a caller's own cache still wins over the ambient one", async () => {
    // The fallback is a fallback. A site that was already threading a cache keeps using that one.
    const ambient = createSourcingCache();
    const own = createSourcingCache();
    const provider = countingProvider(["a"]);
    await withRenderSourcingCacheScope(ambient, () =>
      withProvenBeat("Churchill", async () => {
        await cachedProviderSearch(own, "pexels", "Churchill", provider.search, "test");
        await cachedProviderSearch(own, "pexels", "Churchill", provider.search, "test");
      })
    );
    expect(provider.calls).toBe(1);
    expect(own.totals.queryCacheHits).toBe(1);
    expect(ambient.totals.queryCacheHits).toBe(0);
    expect(ambient.queries.size).toBe(0);
  });

  it("two concurrent renders never read each other's cache", async () => {
    /**
     * Why RenderCtx and not a module-level singleton. A worker runs MAX_CONCURRENT_JOBS renders in
     * one process; a shared cache would let one render's search results answer another's question.
     */
    const a = createSourcingCache();
    const b = createSourcingCache();
    const providerA = countingProvider(["from-a"]);
    const providerB = countingProvider(["from-b"]);
    const [ra, rb] = await Promise.all([
      withRenderSourcingCacheScope(a, () =>
        withProvenBeat("Churchill", () =>
          cachedProviderSearch(undefined, "pexels", "Churchill", providerA.search, "test")
        )
      ),
      withRenderSourcingCacheScope(b, () =>
        withProvenBeat("Churchill", () =>
          cachedProviderSearch(undefined, "pexels", "Churchill", providerB.search, "test")
        )
      ),
    ]);
    expect(ra).toEqual(["from-a"]);
    expect(rb).toEqual(["from-b"]);
    expect(providerA.calls).toBe(1);
    expect(providerB.calls).toBe(1);
    expect(a.queries.size).toBe(1);
    expect(b.queries.size).toBe(1);
  });

  it("outside a render there is no ambient cache, so behaviour is exactly as before", async () => {
    /**
     * `getRenderCtx()` hands back a throwaway when no render owns the async context, so the
     * fallback yields null and the function bails to a plain search — which is what the first
     * test in this file measures. Tools, scripts and tests are unaffected.
     */
    const provider = countingProvider(["a"]);
    await withProvenBeat("Churchill", async () => {
      await cachedProviderSearch(undefined, "pexels", "Churchill", provider.search, "test");
      await cachedProviderSearch(undefined, "pexels", "Churchill", provider.search, "test");
    });
    expect(provider.calls).toBe(2);
  });

  it("the metrics line can name the render it belongs to", () => {
    // 555 printed `videoId=-`, which made the block hard to attribute in a shared log.
    const src = pipelineSource();
    expect(src).toContain("logSourcingMetrics(visualDedup.sourcingCache, videoId);");
    expect(() => logSourcingMetrics(undefined)).not.toThrow();
  });
});

function pipelineSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
}
