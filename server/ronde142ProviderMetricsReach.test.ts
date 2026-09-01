/**
 * RONDE 142 — the counters that were counting into nothing.
 *
 * ── The line from video 558 that started this ────────────────────────────────────────────────
 *
 *     [SourcingMetrics]   pexels: searches=13 results=0 …
 *
 * while three Pexels clips were downloaded and trimmed in that same render. Thirteen searches that
 * returned nothing, and three clips that came from them: two numbers about the same thirteen
 * requests, disagreeing, one of them impossible.
 *
 * ── The cause ────────────────────────────────────────────────────────────────────────────────
 *
 * A split that RONDE 173 half-closed. Thirty-seven provider call sites pass no `sourcingCache`:
 *
 *   · `cachedProviderSearch` falls back to the render's own cache (RONDE 173) and books the search
 *     there — so `searches=13` was real;
 *   · every `providerMetrics(sourcingCache, …)` inside that same fetcher still received the
 *     undefined parameter, was handed a fresh throwaway object, incremented it, and dropped it on
 *     return — so `results`, `downloads` and every other per-provider number stayed at zero.
 *
 * The numbers were not low. They were counting two different things.
 *
 * ── The fix, and why it is one line ──────────────────────────────────────────────────────────
 *
 * The same ambient fallback, in the one function every counter goes through. Threading the cache
 * into thirty-seven fetchers is the same edit thirty-seven times and the next fetcher written would
 * reintroduce the bug.
 *
 * ── The part that is not a log line ──────────────────────────────────────────────────────────
 *
 * `claimYoutubeDownloadSlot` READS through this function. A cache-less caller got a zeroed object
 * every call, so the render-wide download ceiling counted from zero each time and bounded nothing —
 * RONDE 68's bug, back through the other door. It now holds. That has its own test below.
 */
import { describe, expect, it } from "vitest";

import {
  claimYoutubeDownloadSlot,
  createSourcingCache,
  providerMetrics,
  withRenderSourcingCacheScope,
} from "./videoPipeline";
import {
  emptySummaryCounts,
  formatUsageInconsistencies,
  type SummaryCounts,
  type VisualSourceSummary,
} from "./visualSourceLineage";

const read = () => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
};

/* ═══════════════════════ 1. the counters reach the render ═══════════════════════ */

describe("RONDE 142 §1 — a fetcher that was handed no cache still counts", () => {
  it("THE BUG: an increment through an undefined cache used to vanish", async () => {
    /**
     * Written as the fetcher writes it: `providerMetrics(sourcingCache, "pexels").resultCount += n`
     * with `sourcingCache` undefined, inside the render's own scope. Before this round the object
     * returned here was a throwaway and the render's `pexels` entry stayed at zero.
     */
    const cache = createSourcingCache();
    await withRenderSourcingCacheScope(cache, async () => {
      providerMetrics(undefined, "pexels").resultCount += 15;
      providerMetrics(undefined, "pexels").downloadCount += 3;
    });
    expect(cache.metrics.get("pexels")?.resultCount).toBe(15);
    expect(cache.metrics.get("pexels")?.downloadCount).toBe(3);
  });

  it("the two counters about the same search finally agree", async () => {
    /**
     * The shape of the 558 line, reproduced: the search is booked through the ambient cache and the
     * results through the parameter. `searches=13 results=0` is only possible when those two land
     * in different objects.
     */
    const cache = createSourcingCache();
    await withRenderSourcingCacheScope(cache, async () => {
      for (let i = 0; i < 13; i++) {
        providerMetrics(cache, "pexels").searchCount++; // what cachedProviderSearch does
        providerMetrics(undefined, "pexels").resultCount += 15; // what the fetcher does
      }
    });
    const m = cache.metrics.get("pexels")!;
    expect(m.searchCount).toBe(13);
    expect(m.resultCount).toBe(195);
    expect(m.resultCount, "13 searches that returned nothing is what the log claimed").not.toBe(0);
  });

  it("a caller's own cache still wins over the ambient one", async () => {
    // The fallback is a fallback. A site already threading a cache keeps using that one.
    const ambient = createSourcingCache();
    const own = createSourcingCache();
    await withRenderSourcingCacheScope(ambient, async () => {
      providerMetrics(own, "wikimedia").resultCount += 7;
    });
    expect(own.metrics.get("wikimedia")?.resultCount).toBe(7);
    expect(ambient.metrics.has("wikimedia")).toBe(false);
  });

  it("two concurrent renders never write into each other's counters", async () => {
    /**
     * Why RenderCtx and not a module-level singleton: a worker runs several renders in one
     * process, and a shared counter would make every per-render number meaningless.
     */
    const a = createSourcingCache();
    const b = createSourcingCache();
    await Promise.all([
      withRenderSourcingCacheScope(a, async () => {
        providerMetrics(undefined, "pexels").resultCount += 5;
      }),
      withRenderSourcingCacheScope(b, async () => {
        providerMetrics(undefined, "pexels").resultCount += 9;
      }),
    ]);
    expect(a.metrics.get("pexels")?.resultCount).toBe(5);
    expect(b.metrics.get("pexels")?.resultCount).toBe(9);
  });

  it("with no render context at all, nothing is invented", async () => {
    // A call from a test or a tool must not conjure a render to count against.
    await withRenderSourcingCacheScope(null, async () => {
      const m = providerMetrics(undefined, "pexels");
      m.resultCount += 4;
      expect(m.resultCount).toBe(4); // its own throwaway, as before
    });
  });
});

/* ═══════════════════════ 2. the ceiling that stopped bounding ═══════════════════════ */

describe("RONDE 142 §2 — the YouTube download ceiling holds for cache-less callers too", () => {
  it("THE BEHAVIOUR CHANGE: a cache-less caller no longer gets a fresh counter per call", async () => {
    /**
     * RONDE 68 moved this counter off a local because a per-CALL ceiling bounded nothing across a
     * render's twenty-six fetcher calls. For every caller that passed no cache the counter was
     * still effectively per-call — a zeroed throwaway each time — so `claim` returned true forever.
     */
    const cache = createSourcingCache();
    const granted: boolean[] = [];
    await withRenderSourcingCacheScope(cache, async () => {
      for (let i = 0; i < 5; i++) granted.push(claimYoutubeDownloadSlot(undefined, 3));
    });
    expect(granted).toEqual([true, true, true, false, false]);
    expect(cache.metrics.get("youtube_cc")?.downloadCount).toBe(3);
  });

  it("slots claimed with a cache and without it come out of the same budget", async () => {
    // The two call styles must not each get their own three.
    const cache = createSourcingCache();
    await withRenderSourcingCacheScope(cache, async () => {
      expect(claimYoutubeDownloadSlot(cache, 2)).toBe(true);
      expect(claimYoutubeDownloadSlot(undefined, 2)).toBe(true);
      expect(claimYoutubeDownloadSlot(undefined, 2)).toBe(false);
      expect(claimYoutubeDownloadSlot(cache, 2)).toBe(false);
    });
  });
});

/* ═══════════════════════ 3. the fix is where it belongs ═══════════════════════ */

describe("RONDE 142 §3 — one line, in the function every counter goes through", () => {
  const src = read();
  const body = src.slice(
    src.indexOf("export function providerMetrics("),
    src.indexOf("export function claimYoutubeDownloadSlot(")
  );

  it("providerMetrics consults the render's cache, exactly as cachedProviderSearch does", () => {
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("const active = cache ?? get_activeSourcingCache() ?? undefined;");
    // The unconditional bail was the whole leak.
    expect(body).not.toMatch(/^\s*if \(!cache\) return emptyProviderMetrics\(\);/m);
    // And an absent render context still gets nothing invented for it.
    expect(body).toContain("if (!active) return emptyProviderMetrics();");
  });

  it("the fetchers were NOT rewritten — the point is that they did not have to be", () => {
    /**
     * Thirty-seven call sites threading a cache is the same edit thirty-seven times, and the next
     * fetcher someone writes would reintroduce the bug. This asserts the fetchers still call it the
     * way they always did.
     */
    expect(src).toContain('providerMetrics(sourcingCache, "pexels").resultCount +=');
    expect(src).toContain('providerMetrics(sourcingCache, "youtube_cc").downloadCount');
  });
});

/* ═══════════════════════ 4. the funnel check that cried wolf ═══════════════════════ */

describe("RONDE 142 §4 — downloaded is not between selected and validated", () => {
  const counts = (over: Partial<SummaryCounts> = {}): SummaryCounts => ({
    ...emptySummaryCounts(),
    ...over,
  });
  const summaryOf = (
    byProvider: Record<string, SummaryCounts>,
    total: SummaryCounts
  ): VisualSourceSummary => ({
    byProvider,
    total,
    failureReasons: {},
    routes: {},
  });

  it("THE FALSE ALARM: 41 downloads and 1 validated is normal, not a fault", () => {
    /**
     * Video 558's line, verbatim in numbers. `eligible` is recorded in adoptClip, after the vision
     * gate — and the gate needs the FILE. Downloading is what makes a candidate judgeable, so most
     * downloads exist in order to be refused. The old check had download before validation, so it
     * reported the normal case on every render.
     */
    const real = counts({ results: 200, downloadSucceeded: 41, eligible: 1, selected: 1, ranked: 1, adopted: 1, finalVideo: 1 });
    expect(formatUsageInconsistencies(summaryOf({ pexels: real }, real), true)).toEqual([]);
  });

  it("a curated clip adopted with no search and no download is not a fault either", () => {
    // The archive route prepares a clip from its own store: no results, no download, straight to
    // the gates. RONDE 159 established this; the `results` comparison is what still contradicted it.
    const curated = counts({ results: 0, downloadSucceeded: 0, eligible: 6, ranked: 6, selected: 6, adopted: 4, finalVideo: 4 });
    expect(formatUsageInconsistencies(summaryOf({ archive: curated }, curated), true)).toEqual([]);
  });

  it("A REAL miscount still reports: adopted beyond what cleared the gates", () => {
    const broken = counts({ eligible: 2, ranked: 2, selected: 2, adopted: 5, finalVideo: 5 });
    const problems = formatUsageInconsistencies(summaryOf({ nasa: broken }, broken), true);
    expect(problems.some((p) => p.includes("assigned=5 exceeds validated=2"))).toBe(true);
  });

  it("A REAL miscount still reports: more in the file than was ever adopted", () => {
    const broken = counts({ eligible: 9, ranked: 9, selected: 9, adopted: 3, finalVideo: 7 });
    const problems = formatUsageInconsistencies(summaryOf({ nasa: broken }, broken), true);
    expect(problems.some((p) => p.includes("rendered=7 exceeds assigned=3"))).toBe(true);
  });

  it("A REAL miscount still reports: selected or ranked beyond validated", () => {
    /**
     * These three are written on three consecutive lines of adoptClip, so any difference at all is
     * an instrumentation fault rather than a route difference — the strictest pair in the set.
     */
    const broken = counts({ eligible: 4, ranked: 6, selected: 6, adopted: 1, finalVideo: 1 });
    const problems = formatUsageInconsistencies(summaryOf({ nasa: broken }, broken), true);
    expect(problems.some((p) => p.includes("selected=6 exceeds validated=4"))).toBe(true);
    expect(problems.some((p) => p.includes("ranked=6 exceeds validated=4"))).toBe(true);
  });

  it("`rendered` is only checked once the final video is verified", () => {
    // Before that point finalVideo is not knowable, and 0 would be a claim rather than a fact.
    const broken = counts({ eligible: 9, adopted: 3, finalVideo: 7 });
    expect(formatUsageInconsistencies(summaryOf({ nasa: broken }, broken), false)).toEqual([]);
  });
});
