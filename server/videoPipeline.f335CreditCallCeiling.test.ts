import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// F3-35: runtime-measured credit-call-ceiling tests for the F3-28/29/30/31 source cascade.
//
// SCOPE NOTE (read before extending this file): this file proves the Europeana ceiling
// (Test 3) and the dedup-before-cap behavior at runtime (Test 4) by actually invoking the
// already-exported fetchEuropeanaVideos and counting real (mocked) node-fetch calls — not by
// re-testing the pure uniqueQueryStrings() utility in isolation the way
// server/videoPipeline.f331CreditOptimization.test.ts already does for the historical-tier
// query construction.
//
// Test 1 and Test 2 (the 27/18 historical-tier ceiling: 9 tiers x 3 or 2 queries) are NOT
// implemented here — deliberately stopped, not guessed around. Reason, concretely evidenced:
// the "27/18" figure counts DISPATCH ATTEMPTS into fetchHistoricalBeatVideo's tier loop
// (9 tiers x queryCap), not raw network calls, and that mapping is not 1:1 for at least one of
// the 9 underlying tier fetchers. fetchYouTubeCCClips (server/videoPipeline.ts:9196) is invoked
// exactly ONCE per (tier=youtube_cc, query) dispatch attempt from fetchHistoricalBeatVideo, but
// internally loops over its own `licensePasses` array (:9240-9245 — "creative_common" then,
// when youtubeFairUseEnabled() (default true), also "any") and calls
// searchYoutubeVideoCandidates() (:9257, a real node-fetch call to
// www.googleapis.com/youtube/v3/search, :9150) ONCE PER PASS — i.e. up to 2 raw node-fetch
// calls for a single tier-dispatch attempt. Counting raw node-fetch calls as a stand-in for
// "tier-dispatch attempts" is therefore not a reliable measurement of the documented 27/18
// ceiling: it would either undercount (when YouTube CC is unconfigured/gated off, contributing
// 0 instead of up to 3 of the 27 budget) or overcount relative to the attempt-based ceiling
// (when YouTube CC is configured, since its 3 possible query attempts can produce up to 6 raw
// calls instead of 3). Reliably measuring the true dispatch-attempt count would require
// spying on the tier dispatcher itself (`fetchTierPaths`, videoPipeline.ts ~15167) — a
// locally-scoped const closure defined inside the private fetchHistoricalBeatVideo, with no
// independent exported name, and giving it one would mean either refactoring
// fetchHistoricalBeatVideo (explicitly forbidden this pass) or exporting/renaming internal
// structure beyond the already-approved F3-33 visibility-only exports (a further production
// code change this pass's scope explicitly does not authorize). Per this task's own stop
// condition, this is reported rather than worked around with an approximate/misleading count.
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: (...args: unknown[]) => nodeFetchMock(...args) }));

const getActiveVideoIdMock = vi.fn<() => number | undefined>(() => undefined);
const isVideoGenerationCancelRequestedMock = vi.fn<(id: number) => boolean>(() => false);
vi.mock("./videoGenerationCancel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./videoGenerationCancel")>();
  return {
    ...actual,
    getActiveVideoId: () => getActiveVideoIdMock(),
    isVideoGenerationCancelRequested: (id: number) => isVideoGenerationCancelRequestedMock(id),
  };
});

async function loadFetchEuropeanaVideos() {
  vi.resetModules();
  const mod = await import("./videoPipeline");
  return mod.fetchEuropeanaVideos;
}

// 6 items per query page, each with a valid video URL but deliberately NO edmRights — every
// one fails the F3-30 license gate, forcing the record-fetch loop to check all 6 before moving
// to the next query. This is the actual worst-case path the "18" ceiling describes.
function noRightsSearchResponse(queryTag: string) {
  return {
    ok: true,
    json: async () => ({
      items: Array.from({ length: 6 }, (_, i) => ({ id: `/${queryTag}/item${i}`, title: [`clip ${i}`] })),
    }),
  };
}

function noRightsRecordResponse() {
  return {
    ok: true,
    json: async () => ({
      object: { aggregations: [{ edmIsShownBy: "https://example.com/clip.mp4" }] }, // no edmRights
    }),
  };
}

describe("fetchEuropeanaVideos — F3-35 Test 3 (runtime-measured 18 record-fetch ceiling: 3 queries x 6 rows)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.EUROPEANA_API_KEY = "test-key";
    process.env.ENABLE_EUROPEANA = "true";
    nodeFetchMock.mockReset();
    getActiveVideoIdMock.mockReturnValue(undefined);
    isVideoGenerationCancelRequestedMock.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("never exceeds 18 record-fetch calls even when every candidate in every query lacks rights (true worst case)", async () => {
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("record/v2/search.json")) {
        const queryParam = new URL(u).searchParams.get("query") ?? "q";
        return Promise.resolve(noRightsSearchResponse(queryParam));
      }
      if (u.includes("record/v2/")) {
        return Promise.resolve(noRightsRecordResponse());
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const fetchEuropeanaVideos = await loadFetchEuropeanaVideos();
    const result = await fetchEuropeanaVideos(["ships", "trains", "planes"], 6, "/tmp", 0, 1);

    expect(result).toEqual([]); // nothing had rights — nothing was ever adopted

    const searchCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("record/v2/search.json"));
    const recordCalls = nodeFetchMock.mock.calls.filter(
      ([u]) => String(u).includes("record/v2/") && !String(u).includes("search.json")
    );
    expect(searchCalls.length).toBe(3); // 3 queries, the documented query cap
    expect(recordCalls.length).toBe(18); // 3 queries x 6 rows, the documented worst-case ceiling
    expect(recordCalls.length).toBeLessThanOrEqual(18);
  }, 30_000); // 21 sequential mocked round-trips through a freshly re-imported videoPipeline.ts
  // (vi.resetModules() forces a full re-transform of that ~25k-line file) can approach the
  // default 5s per-test timeout under sandbox load — raised, not to mask a hang, but because a
  // timed-out test's abandoned async chain keeps calling the shared nodeFetchMock in the
  // background and contaminates later tests' call counts (confirmed while debugging this file).
});

describe("fetchEuropeanaVideos — F3-35 Test 4 (runtime-measured: duplicate query strings never inflate the call budget)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.EUROPEANA_API_KEY = "test-key";
    process.env.ENABLE_EUROPEANA = "true";
    nodeFetchMock.mockReset();
    getActiveVideoIdMock.mockReturnValue(undefined);
    isVideoGenerationCancelRequestedMock.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("5 input queries with exact duplicates still produce at most 3 search calls, one per unique query", async () => {
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("record/v2/search.json")) {
        const queryParam = new URL(u).searchParams.get("query") ?? "q";
        return Promise.resolve(noRightsSearchResponse(queryParam));
      }
      if (u.includes("record/v2/")) {
        return Promise.resolve(noRightsRecordResponse());
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const fetchEuropeanaVideos = await loadFetchEuropeanaVideos();
    // "ships" and "trains" each appear twice — must collapse before the 3-query cap is applied,
    // not count toward it twice (mirrors the exact assertion style of
    // videoPipeline.f331CreditOptimization.test.ts Test 3, but measured here as a live call
    // count instead of a pure-function return value).
    await fetchEuropeanaVideos(["ships", "ships", "trains", "trains", "planes"], 6, "/tmp", 0, 1);

    const searchCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("record/v2/search.json"));
    expect(searchCalls.length).toBe(3);

    const queriedTerms = searchCalls.map(([u]) => new URL(String(u)).searchParams.get("query"));
    expect(queriedTerms).toEqual(["ships", "trains", "planes"]);
    expect(new Set(queriedTerms).size).toBe(queriedTerms.length); // no query searched twice
  }, 30_000);

  it("a single duplicated query still produces exactly one search call for it, not two", async () => {
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("record/v2/search.json")) {
        return Promise.resolve(noRightsSearchResponse("dup"));
      }
      if (u.includes("record/v2/")) {
        return Promise.resolve(noRightsRecordResponse());
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const fetchEuropeanaVideos = await loadFetchEuropeanaVideos();
    await fetchEuropeanaVideos(["same query", "same query"], 6, "/tmp", 0, 1);

    const searchCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("record/v2/search.json"));
    expect(searchCalls.length).toBe(1);
  }, 30_000);
});
