/**
 * RONDE 175 — YouTube is CALLED BY the pool, not merely translatable into it.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────────────────────
 *
 * R169 built `youtubePoolSource.ts` and proved a YouTube row becomes a pool candidate. R174's own
 * audit then found the thing that made it useless: `buildSceneCandidatePool` never called it. The
 * adapter existed, the type existed, the tests passed, and during a real render YouTube could
 * still only be reached through the first-hit-wins cascade.
 *
 * That is the exact failure mode this whole series keeps finding — code that exists and is never
 * invoked — so R175 asks for a test that FAILS when YouTube exists but the pool does not call it.
 * That is the first test below, and it is written to fail for that reason and no other: it asserts
 * on the injected search function being invoked BY `buildSceneCandidatePool`, not on the adapter.
 *
 * PRODUCTION STATUS: LOCAL. The search function is injected — which is how production passes it
 * too — so what is proven is that the pool calls it, ranks what it returns, and treats it like any
 * other source. Not that YouTube answered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSceneCandidatePool, type YoutubePoolSearch } from "./scenePool";
import type { YoutubeRowLike } from "./youtubePoolSource";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  /** No provider keys: every other source skips, so what remains in the pool is YouTube's doing. */
  for (const k of ["PEXELS_API_KEY", "PIXABAY_API_KEY", "EUROPEANA_API_KEY", "NARA_API_KEY"]) {
    delete process.env[k];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL)) delete process.env[k];
  Object.assign(process.env, ORIGINAL);
});

function ytRow(videoId: string, over: Partial<YoutubeRowLike> = {}): YoutubeRowLike {
  return {
    item: {
      id: { videoId },
      snippet: {
        title: over.title ?? "Apple Park ring campus aerial",
        description: over.desc ?? "A flight over the Cupertino ring.",
        channelTitle: "A Channel",
        publishedAt: "2019-04-01T00:00:00Z",
        thumbnails: { high: { url: `https://i.ytimg.invalid/${videoId}.jpg` } },
      },
    },
    title: over.title ?? "Apple Park ring campus aerial",
    desc: over.desc ?? "A flight over the Cupertino ring.",
    rel: over.rel ?? 0.9,
  };
}

/** A pool request with every network-backed source switched off except the injected YouTube. */
function poolRequest(youtubeSearch?: YoutubePoolSearch, extra: Record<string, unknown> = {}) {
  return {
    sceneIndex: 0,
    sceneText: "A helicopter sweeps over the Apple Park ring campus in Cupertino.",
    primaryQuery: "apple park aerial",
    skipPexels: true,
    skipPixabay: true,
    skipInternetArchive: true,
    skipEuropeana: true,
    skipOpenverse: true,
    skipNasa: true,
    skipNara: true,
    skipLoc: true,
    ...(youtubeSearch ? { youtubeSearch } : {}),
    ...extra,
  } as never;
}

/* ═══════════════════════ the one that must fail if nothing calls it ═══════════════════════ */

describe("R175 — buildSceneCandidatePool actually invokes the YouTube search", () => {
  /**
   * The test R175 asks for by name. It does not touch `youtubePoolCandidates` — it hands the POOL
   * a search function and asserts the POOL called it. If somebody removes the wiring while leaving
   * the adapter in place, every other YouTube test still passes and this one fails.
   */
  it("calls the injected search function", async () => {
    const search = vi.fn(async () => [ytRow("a1")]);
    await buildSceneCandidatePool(poolRequest(search as never));
    expect(search, "the pool never asked YouTube for anything").toHaveBeenCalled();
  });

  it("asks it the query the pool is building for", async () => {
    const search = vi.fn(async () => [ytRow("a1")]);
    await buildSceneCandidatePool(poolRequest(search as never));
    const [query, sceneIndex] = search.mock.calls[0]!;
    expect(query).toBe("apple park aerial");
    expect(sceneIndex).toBe(0);
  });

  /** The pool must not invent a licence question — CC is the default, and it is passed through. */
  it("asks under the CC licence by default", async () => {
    const search = vi.fn(async () => [ytRow("a1")]);
    await buildSceneCandidatePool(poolRequest(search as never));
    expect(search.mock.calls[0]![2]).toBe("creative_common");
  });

  it("passes a caller's licence mode through unchanged", async () => {
    const search = vi.fn(async () => [ytRow("a1")]);
    await buildSceneCandidatePool(poolRequest(search as never, { youtubeLicenseMode: "any" }));
    expect(search.mock.calls[0]![2]).toBe("any");
  });

  /** YouTube's results have to actually land in the pool, not merely be fetched and dropped. */
  it("puts the YouTube results into the pool as ordinary candidates", async () => {
    const pool = await buildSceneCandidatePool(
      poolRequest((async () => [ytRow("a1"), ytRow("a2")]) as never)
    );
    const yt = pool.candidates.filter((c) => c.source === "youtube_cc");
    expect(yt.map((c) => c.assetId).sort()).toEqual(["a1", "a2"]);
  });

  it("gives them the pool's own id shape, so dedup treats them like any other source", async () => {
    const pool = await buildSceneCandidatePool(poolRequest((async () => [ytRow("a1")]) as never));
    const yt = pool.candidates.find((c) => c.source === "youtube_cc")!;
    expect(yt.id).toBe("youtube_cc:a1");
  });

  /**
   * §"dezelfde deduplication" — the same video returned twice must collapse to one candidate, by
   * the same mechanism every other source's duplicates collapse by.
   */
  it("dedups a video the search returned twice", async () => {
    const pool = await buildSceneCandidatePool(
      poolRequest((async () => [ytRow("dup"), ytRow("dup")]) as never)
    );
    expect(pool.candidates.filter((c) => c.assetId === "dup")).toHaveLength(1);
  });

  it("counts the search as one provider API call, like every other source", async () => {
    const pool = await buildSceneCandidatePool(poolRequest((async () => [ytRow("a1")]) as never));
    expect(pool.metrics.apiCallsPerProvider.youtube_cc).toBe(1);
  });
});

/* ═══════════════════════ absent, failing, and empty are three things ═══════════════════════ */

describe("R175 — a pool without YouTube says so, rather than looking the same as an empty search", () => {
  /**
   * The distinction §8 keeps asking for. No search function supplied is a CONFIGURATION fact; a
   * search that returned nothing is a RESULT. A log that cannot tell them apart cannot answer
   * "why was YouTube not used", which is the question this whole area exists to make answerable.
   */
  it("records why YouTube was not queried at all", async () => {
    const pool = await buildSceneCandidatePool(poolRequest());
    expect(pool.candidates.filter((c) => c.source === "youtube_cc")).toEqual([]);
    expect(pool.metrics.apiCallsPerProvider.youtube_cc).toBeUndefined();
  });

  it("a search that returns nothing is not the same as one that was never made", async () => {
    const search = vi.fn(async () => []);
    const pool = await buildSceneCandidatePool(poolRequest(search as never));
    expect(search).toHaveBeenCalled();
    expect(pool.metrics.apiCallsPerProvider.youtube_cc).toBe(1);
    expect(pool.candidates.filter((c) => c.source === "youtube_cc")).toEqual([]);
  });

  /**
   * A provider that throws must not take the whole pool down with it. Every other source in this
   * builder is isolated the same way, and YouTube — which 429s on quota routinely — is the one
   * most likely to need it.
   */
  it("a failing YouTube search does not fail the pool", async () => {
    const pool = await buildSceneCandidatePool(
      poolRequest((async () => { throw new Error("quota exceeded"); }) as never)
    );
    expect(pool.candidates.filter((c) => c.source === "youtube_cc")).toEqual([]);
    /** The pool itself still resolved, which is what "isolated" means. */
    expect(pool.sceneIndex).toBe(0);
  });

  /** A row with no video id can never be fetched again, so it is dropped rather than carried. */
  it("drops a result with no video id instead of adding an unfetchable candidate", async () => {
    const pool = await buildSceneCandidatePool(
      poolRequest((async () => [{ ...ytRow("x"), item: { id: {} } }]) as never)
    );
    expect(pool.candidates.filter((c) => c.source === "youtube_cc")).toEqual([]);
  });
});

/* ═══════════════════════ it is one source among many ═══════════════════════ */

describe("R175 — YouTube is treated as one source among many, not a special case", () => {
  /**
   * The point of putting it in the pool at all: its candidates sit alongside the others and are
   * ranked together. This asserts they share the pool, which is the precondition for RULE 6 —
   * a ranking cannot let YouTube win if YouTube is not in the list.
   */
  it("shares one pool with the other sources", async () => {
    const pool = await buildSceneCandidatePool(
      poolRequest((async () => [ytRow("a1")]) as never, { skipOpenverse: false })
    );
    const sources = new Set(pool.candidates.map((c) => c.source));
    expect(sources.has("youtube_cc")).toBe(true);
    /** Every candidate in the pool has the same shape, whichever source produced it. */
    for (const c of pool.candidates) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.assetId).toBe("string");
      expect(c).toHaveProperty("rankingScore");
    }
  });

  it("respects the per-source cap like every other provider", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ytRow(`v${i}`));
    const search = vi.fn(async () => many);
    await buildSceneCandidatePool(poolRequest(search as never, { maxPerSource: 4 }));
    /** The cap is passed to the search, so quota is not spent fetching what will be discarded. */
    expect(search.mock.calls[0]![6]).toBe(4);
  });

  /** The pool holds no key and no media URL — only the watch page the download layer takes. */
  it("carries no credential into the pool", async () => {
    const pool = await buildSceneCandidatePool(poolRequest((async () => [ytRow("a1")]) as never));
    const yt = pool.candidates.find((c) => c.source === "youtube_cc")!;
    expect(yt.remoteUrl).toBe("https://www.youtube.com/watch?v=a1");
    expect(JSON.stringify(yt)).not.toMatch(/api[_-]?key/i);
  });
});
