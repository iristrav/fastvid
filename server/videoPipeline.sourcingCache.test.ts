import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Asset Intelligence v1 — render-scoped QUERY CACHE (Phase 5) and PROVIDER ASSET CACHE
// (Phase 6), both hanging off the existing VisualDedupState via its `sourcingCache` field.
//
// What these tests pin down, in the same network-mocked style as
// videoPipeline.visualDedupProviderKey.test.ts (which covers the asset-identity/dedup half):
//
//   QUERY CACHE   — the same provider + the exact same normalized query must issue its search
//                   request at most once per render, while a second caller still sees the full
//                   candidate list (cached at the parsed-payload level, NOT short-circuited to
//                   an empty result — that distinction is what stops the cache from silently
//                   shrinking a later cascade's candidate pool).
//   ASSET CACHE   — a provider asset surfaced twice by two DIFFERENT queries (so the query
//                   cache cannot help) must pay for its per-item metadata + license check only
//                   once, including when the verdict was a rejection.
//   CONSERVATISM  — deliberately exact-match only: differently-worded queries for the same
//                   topic stay separate searches, and the same text against a different
//                   provider is a separate entry.
//   METRICS       — the Phase 20 counters actually move, and reading them never throws.
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: (...args: unknown[]) => nodeFetchMock(...args) };
});

async function freshPipeline() {
  vi.resetModules();
  return import("./videoPipeline");
}

/** archive.org search payload for one identifier. */
function iaSearchPayload(identifier: string, title = "Some Reel") {
  return { ok: true, json: async () => ({ response: { docs: [{ identifier, title }] } }) };
}

/** archive.org item record with no usable license — makes the license gate reject, so the test
 *  never reaches a download while still exercising metadata + license exactly once. */
function iaUnlicensedMetadata() {
  return { ok: true, json: async () => ({ metadata: {}, files: [] }) };
}

const searchCalls = () =>
  nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("advancedsearch.php"));
const metadataCallsFor = (id: string) =>
  nodeFetchMock.mock.calls.filter(([u]) => String(u).includes(`/metadata/${id}`));

describe("Phase 5 — render-scoped query cache", () => {
  beforeEach(() => nodeFetchMock.mockReset());

  it("the exact same provider + query runs its search ONCE per render, and the second caller still sees the full candidate list", async () => {
    const { fetchInternetArchiveClips, createSourcingCache } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) return Promise.resolve(iaSearchPayload("abc123"));
      if (u.includes("/metadata/abc123")) return Promise.resolve(iaUnlicensedMetadata());
      return Promise.resolve({ ok: false, status: 500 });
    });

    const cache = createSourcingCache();
    // Two independent cascades in the same render asking the same provider the same thing.
    await fetchInternetArchiveClips("moon landing", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);
    await fetchInternetArchiveClips("moon landing", 6, "/tmp", 1, 1, "", "", [], new Set(), cache);

    expect(searchCalls()).toHaveLength(1); // INVARIANT 3: one search per (provider, query)
    expect(cache.totals.queryCacheHits).toBe(1);
    // Crucially the second cascade was NOT short-circuited to "no candidates": it walked the
    // replayed payload and still evaluated abc123 (its metadata call is the proof). Only the
    // per-asset cache below stops that second evaluation from re-hitting the network.
    expect(metadataCallsFor("abc123").length).toBeGreaterThanOrEqual(1);
  });

  it("a DIFFERENT query issues a new search — no fuzzy/semantic collapsing", async () => {
    const { fetchInternetArchiveClips, createSourcingCache } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) return Promise.resolve(iaSearchPayload("abc123"));
      if (u.includes("/metadata/abc123")) return Promise.resolve(iaUnlicensedMetadata());
      return Promise.resolve({ ok: false, status: 500 });
    });

    const cache = createSourcingCache();
    await fetchInternetArchiveClips("World War II Germany", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);
    await fetchInternetArchiveClips("Germany during World War II", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);

    // Same topic, different wording — the spec explicitly wants these treated as two searches.
    expect(searchCalls()).toHaveLength(2);
    expect(cache.totals.queryCacheHits).toBe(0);
  });

  it("normalization is case/whitespace only — 'Moon  Landing ' reuses 'moon landing'", async () => {
    const { fetchInternetArchiveClips, createSourcingCache, normalizeProviderQuery, providerQueryCacheKey } =
      await freshPipeline();
    expect(normalizeProviderQuery("  Moon   Landing ")).toBe("moon landing");
    expect(providerQueryCacheKey("internet_archive", "Moon  Landing")).toBe(
      providerQueryCacheKey("internet_archive", "moon landing")
    );

    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) return Promise.resolve(iaSearchPayload("abc123"));
      if (u.includes("/metadata/abc123")) return Promise.resolve(iaUnlicensedMetadata());
      return Promise.resolve({ ok: false, status: 500 });
    });

    const cache = createSourcingCache();
    await fetchInternetArchiveClips("moon landing", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);
    await fetchInternetArchiveClips("  Moon   Landing ", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);
    expect(searchCalls()).toHaveLength(1);
  });

  it("the same query text against a DIFFERENT provider is a separate cache entry (both search)", async () => {
    const { fetchInternetArchiveClips, fetchNasaVideoClips, createSourcingCache, providerQueryCacheKey } =
      await freshPipeline();
    expect(providerQueryCacheKey("internet_archive", "apollo 11")).not.toBe(
      providerQueryCacheKey("nasa", "apollo 11")
    );

    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) return Promise.resolve(iaSearchPayload("abc123"));
      if (u.includes("/metadata/abc123")) return Promise.resolve(iaUnlicensedMetadata());
      if (u.includes("images-api.nasa.gov/search")) {
        return Promise.resolve({ ok: true, json: async () => ({ collection: { items: [] } }) });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    const cache = createSourcingCache();
    await fetchInternetArchiveClips("apollo 11", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);
    await fetchNasaVideoClips("apollo 11", 6, "/tmp", 0, 1, new Set(), cache);

    expect(searchCalls()).toHaveLength(1);
    expect(
      nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("images-api.nasa.gov/search"))
    ).toHaveLength(1);
    // Two providers, two entries — never collapsed into one.
    expect(cache.queries.size).toBe(2);
  });

  it("with NO cache supplied (undefined) every call still searches — the cache is strictly additive", async () => {
    const { fetchInternetArchiveClips } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) return Promise.resolve(iaSearchPayload("abc123"));
      if (u.includes("/metadata/abc123")) return Promise.resolve(iaUnlicensedMetadata());
      return Promise.resolve({ ok: false, status: 500 });
    });
    await fetchInternetArchiveClips("moon landing", 6, "/tmp", 0, 1, "", "", [], new Set());
    await fetchInternetArchiveClips("moon landing", 6, "/tmp", 0, 1, "", "", [], new Set());
    expect(searchCalls()).toHaveLength(2);
  });
});

describe("Phase 6 — render-scoped provider asset cache", () => {
  beforeEach(() => nodeFetchMock.mockReset());

  it("the same identifier surfaced by two DIFFERENT queries fetches metadata + license ONCE", async () => {
    const { fetchInternetArchiveClips, createSourcingCache } = await freshPipeline();
    // Both queries legitimately return the same archive.org item, so the query cache cannot
    // help here — only the per-asset cache can. This is the realistic cross-cascade case:
    // fetchHistoricalBeatVideo and researchBeatClipUnified build different query strings from
    // the same beat and land on the same underlying asset.
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) return Promise.resolve(iaSearchPayload("shared-item-1"));
      if (u.includes("/metadata/shared-item-1")) return Promise.resolve(iaUnlicensedMetadata());
      return Promise.resolve({ ok: false, status: 500 });
    });

    const cache = createSourcingCache();
    await fetchInternetArchiveClips("berlin 1945 footage", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);
    await fetchInternetArchiveClips("fall of berlin newsreel", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);

    expect(searchCalls()).toHaveLength(2); // two genuinely different queries — both searched
    // ...but the shared asset's metadata/license work happened exactly once (INVARIANT 2).
    expect(metadataCallsFor("shared-item-1")).toHaveLength(1);
    expect(cache.assets.size).toBe(1);
  });

  it("a cached license REJECTION is honoured — the rejected asset is never re-fetched to be rejected again", async () => {
    const { fetchInternetArchiveClips, createSourcingCache, providerAssetKey } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) return Promise.resolve(iaSearchPayload("unlicensed-1"));
      if (u.includes("/metadata/unlicensed-1")) return Promise.resolve(iaUnlicensedMetadata());
      return Promise.resolve({ ok: false, status: 500 });
    });

    const cache = createSourcingCache();
    await fetchInternetArchiveClips("q one", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);
    const entry = cache.assets.get(providerAssetKey("internet_archive", "unlicensed-1"));
    expect(entry?.licenseAllowed).toBe(false);

    await fetchInternetArchiveClips("q two", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);
    expect(metadataCallsFor("unlicensed-1")).toHaveLength(1);
  });

  it("getCachedProviderAsset/putCachedProviderAsset merge on the stable provider identity, not on filename", async () => {
    const { createSourcingCache, getCachedProviderAsset, putCachedProviderAsset } = await freshPipeline();
    const cache = createSourcingCache();
    expect(getCachedProviderAsset(cache, "vimeo", "/videos/42")).toBeNull();

    putCachedProviderAsset(cache, "vimeo", "/videos/42", { canonicalUrl: "https://vimeo.com/42" });
    putCachedProviderAsset(cache, "vimeo", "/videos/42", { licenseAllowed: true, durationSec: 30 });

    const hit = getCachedProviderAsset(cache, "vimeo", "/videos/42");
    expect(hit).toMatchObject({
      provider: "vimeo",
      providerAssetId: "/videos/42",
      canonicalUrl: "https://vimeo.com/42",
      licenseAllowed: true,
      durationSec: 30,
    });
    expect(cache.assets.size).toBe(1); // merged into one entry, not two
    // An empty id is not an identity — it must never create or match an entry.
    putCachedProviderAsset(cache, "vimeo", "  ", { licenseAllowed: true });
    expect(cache.assets.size).toBe(1);
    expect(getCachedProviderAsset(cache, "vimeo", "")).toBeNull();
  });
});

describe("Phase 20 — sourcing metrics", () => {
  beforeEach(() => nodeFetchMock.mockReset());

  it("a pre-download duplicate skip increments duplicateCandidatesSkipped / duplicateDownloadsPrevented", async () => {
    const { fetchInternetArchiveClips, createSourcingCache, providerAssetKey } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) return Promise.resolve(iaSearchPayload("dup-1"));
      return Promise.resolve({ ok: false, status: 500 });
    });

    const cache = createSourcingCache();
    const alreadyUsed = new Set([providerAssetKey("internet_archive", "dup-1")]);
    await fetchInternetArchiveClips("moon landing", 6, "/tmp", 0, 1, "", "", [], alreadyUsed, cache);

    expect(metadataCallsFor("dup-1")).toHaveLength(0); // no metadata/license/download
    expect(cache.totals.duplicateCandidatesSkipped).toBe(1);
    expect(cache.totals.duplicateDownloadsPrevented).toBe(1);
    expect(cache.metrics.get("internet_archive")?.duplicateSkipped).toBe(1);
  });

  it("providerAssetAlreadyUsed returns false (and counts nothing) for a missing/empty id", async () => {
    const { providerAssetAlreadyUsed, createSourcingCache, providerAssetKey } = await freshPipeline();
    const cache = createSourcingCache();
    const used = new Set([providerAssetKey("nara", "https://example.test/a.mp4")]);
    expect(providerAssetAlreadyUsed(used, cache, "nara", undefined)).toBe(false);
    expect(providerAssetAlreadyUsed(used, cache, "nara", "")).toBe(false);
    expect(cache.totals.duplicateCandidatesSkipped).toBe(0);
    // ...and true for the canonical-URL identity NARA actually uses.
    expect(providerAssetAlreadyUsed(used, cache, "nara", "https://example.test/a.mp4")).toBe(true);
    expect(cache.totals.duplicateCandidatesSkipped).toBe(1);
  });

  it("logSourcingMetrics never throws and never blocks — including on an undefined cache", async () => {
    const { logSourcingMetrics, createSourcingCache } = await freshPipeline();
    expect(() => logSourcingMetrics(undefined)).not.toThrow();
    const cache = createSourcingCache();
    cache.totals.duplicateCandidatesSkipped = 3;
    expect(() => logSourcingMetrics(cache)).not.toThrow();
    // Returns synchronously (no promise handed back that a render could accidentally await).
    expect(logSourcingMetrics(cache)).toBeUndefined();
  });
});

describe("Phase 6 — Europeana asset/license cache (second real license-gate provider)", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    nodeFetchMock.mockReset();
    process.env = { ...ORIGINAL_ENV, EUROPEANA_API_KEY: "test-key", ENABLE_EUROPEANA: "true" };
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("the same recordId surfaced by two DIFFERENT queries fetches the record (metadata+license) ONCE, and a rejection is cached", async () => {
    const { fetchEuropeanaVideos, createSourcingCache, providerAssetKey } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("api.europeana.eu/record/v2/search.json")) {
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ id: "/1/shared", title: ["Shared"] }] }) });
      }
      if (u.includes("api.europeana.eu/record/v2/1/shared.json")) {
        // No edmRights → license gate rejects, so this test never reaches a download while
        // still proving the record call happens exactly once across two different queries.
        return Promise.resolve({
          ok: true,
          json: async () => ({ object: { aggregations: [{ edmIsShownBy: "https://example.com/a.mp4" }] } }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const cache = createSourcingCache();
    await fetchEuropeanaVideos("berlin footage", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);
    await fetchEuropeanaVideos("fall of berlin newsreel", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);

    const recordCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("1/shared.json"));
    expect(recordCalls).toHaveLength(1); // metadata+license paid for exactly once
    const entry = cache.assets.get(providerAssetKey("europeana", "/1/shared"));
    expect(entry?.licenseAllowed).toBe(false);
    const m = cache.metrics.get("europeana")!;
    expect(m.licenseCalls).toBe(1); // one real network call that determined the license
    expect(m.licenseRejectedCacheHits).toBe(1); // the second sighting hit the cached rejection
  });

  it("a LICENSED asset's record is reused (not re-fetched) on a second sighting via a different query", async () => {
    const { fetchEuropeanaVideos, createSourcingCache, providerAssetKey } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("api.europeana.eu/record/v2/search.json")) {
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ id: "/1/licensed", title: ["Licensed"] }] }) });
      }
      if (u.includes("api.europeana.eu/record/v2/1/licensed.json")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            object: {
              aggregations: [{
                edmIsShownBy: "https://example.com/licensed.mp4",
                edmRights: "http://creativecommons.org/publicdomain/mark/1.0/",
              }],
            },
          }),
        });
      }
      // Download deliberately fails — this test only needs to prove the record was reused.
      return Promise.resolve({ ok: false, status: 404 });
    });

    const cache = createSourcingCache();
    await fetchEuropeanaVideos("q one", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);
    await fetchEuropeanaVideos("q two", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);

    const recordCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("1/licensed.json"));
    expect(recordCalls).toHaveLength(1);
    const m = cache.metrics.get("europeana")!;
    expect(m.licenseCalls).toBe(1);
    expect(m.licenseCacheHits).toBe(1); // second sighting reused the cached ALLOWED verdict
    const entry = cache.assets.get(providerAssetKey("europeana", "/1/licensed"));
    expect(entry?.licenseAllowed).toBe(true);
  });
});

describe("Phase 20 — query/asset cache miss counters", () => {
  beforeEach(() => nodeFetchMock.mockReset());

  it("a fresh query increments queryCacheMisses (render total is derivable, per-provider is tracked directly)", async () => {
    const { fetchInternetArchiveClips, createSourcingCache } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) return Promise.resolve(iaSearchPayload("abc123"));
      if (u.includes("/metadata/abc123")) return Promise.resolve(iaUnlicensedMetadata());
      return Promise.resolve({ ok: false, status: 500 });
    });
    const cache = createSourcingCache();
    await fetchInternetArchiveClips("moon landing", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);
    await fetchInternetArchiveClips("moon landing", 6, "/tmp", 1, 1, "", "", [], new Set(), cache);
    const m = cache.metrics.get("internet_archive")!;
    expect(m.queryCacheMisses).toBe(1); // first call only
    expect(m.queryCacheHits).toBe(1); // second call
  });

  it("a first-ever sighting of a provider asset increments assetCacheMisses; the second sighting does not", async () => {
    const { fetchInternetArchiveClips, createSourcingCache } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) return Promise.resolve(iaSearchPayload("shared-x"));
      if (u.includes("/metadata/shared-x")) return Promise.resolve(iaUnlicensedMetadata());
      return Promise.resolve({ ok: false, status: 500 });
    });
    const cache = createSourcingCache();
    await fetchInternetArchiveClips("query one", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);
    await fetchInternetArchiveClips("query two", 6, "/tmp", 0, 1, "", "", [], new Set(), cache);
    const m = cache.metrics.get("internet_archive")!;
    expect(m.assetCacheMisses).toBe(1);
  });

  it("logSourcingMetrics accepts an optional videoId and still never throws", async () => {
    const { logSourcingMetrics, createSourcingCache } = await freshPipeline();
    const cache = createSourcingCache();
    expect(() => logSourcingMetrics(cache, 12345)).not.toThrow();
    expect(() => logSourcingMetrics(cache)).not.toThrow();
  });
});

describe("Phase 4 — F3-49 and the new caches are independent layers", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    nodeFetchMock.mockReset();
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("createVisualDedupState still exposes historicalCascadeAttemptedBeats AND a fresh, empty sourcingCache", async () => {
    const { createVisualDedupState } = await freshPipeline();
    const dedup = createVisualDedupState("8-10");
    // F3-49's per-beat cascade guard is untouched by this round.
    expect(dedup.historicalCascadeAttemptedBeats).toBeInstanceOf(Set);
    expect(dedup.historicalCascadeAttemptedBeats.size).toBe(0);
    // ...and the new render-scoped caches start empty, per render, alongside it.
    expect(dedup.sourcingCache.queries.size).toBe(0);
    expect(dedup.sourcingCache.assets.size).toBe(0);
    expect(dedup.usedContentKeys.size).toBe(0);

    // Two states never share cache instances — no cross-render leakage.
    const other = createVisualDedupState("8-10");
    expect(other.sourcingCache).not.toBe(dedup.sourcingCache);
    dedup.sourcingCache.queries.set("internet_archive|x", null);
    expect(other.sourcingCache.queries.size).toBe(0);
  });
});
