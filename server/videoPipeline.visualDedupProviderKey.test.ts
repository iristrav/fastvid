import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Visual Deduplication Patch: the same real media asset (same provider + same provider-native
// ID, or the same canonical URL when a provider has no stable ID) must never be adopted twice
// within a single video render, no matter which cascade/fallback route finds it.
//
// The mechanism (see clipContentKey / providerAssetKey / tagPathWithProviderAsset in
// videoPipeline.ts) is deliberately decomposed into two independently-testable halves instead of
// one heavy full-pipeline test that would also have to fake out ffmpeg trimming, the CLIP vision
// gate, entity/category gates, etc. (all pre-existing, unrelated to this patch):
//
//   (A) ACCEPTANCE identity — clipContentKey(path) returns the exact same "provider:hash(id)"
//       key for the same underlying asset regardless of which scene/fileTag/counter produced the
//       local filename, and a DIFFERENT key for a different asset. This is what adoptClip's
//       existing `dedup.usedContentKeys.has(contentKey)` check (unchanged) uses to block a
//       second acceptance — see videoPipeline.f349HistoricalCascadeDedup.test.ts and the dozens
//       of other adoptClip-covering tests already in this suite for proof that the accept-gate
//       itself (given a correct key) already works and is race-safe (single lock).
//   (B) PRE-DOWNLOAD skip — every provider fetch function checks a caller-supplied
//       `usedProviderKeys`/`dedup.usedContentKeys` set (the SAME set (A) populates on real
//       acceptance) before spending the metadata/license/download cost on a candidate whose key
//       is already in it.
//
// (A) + (B) together are exactly "found via a different cascade/fallback route → blocked",
// tested here via real network-mocked calls into the exported fetch functions, proving the skip
// happens strictly before any further HTTP call (metadata/license/download), not just before
// adoption.
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: (...args: unknown[]) => nodeFetchMock(...args) };
});

async function freshPipeline() {
  vi.resetModules();
  return import("./videoPipeline");
}

describe("Visual dedup — (A) acceptance identity via clipContentKey", () => {
  it("Test 1/4/5/7 — the SAME provider asset found via two different call sites (different scene/tag/counter) produces the SAME content key", async () => {
    const { tagPathWithProviderAsset, clipContentKey } = await freshPipeline();
    // Simulates: historical cascade downloads archive.org identifier "abc123" as
    // scene_2_tag_hist_archive_0.mp4; researchBeatClipUnified independently downloads the exact
    // same identifier as scene_2_tag_research_archive_1.mp4 (different scene tag, different
    // per-call counter — exactly what the two real cascades would produce).
    const fromHistoricalCascade = tagPathWithProviderAsset(
      "/tmp/work/scene_2_tag_hist_archive_0.mp4",
      "internet_archive",
      "abc123"
    );
    const fromResearchCascade = tagPathWithProviderAsset(
      "/tmp/work/scene_2_tag_research_archive_1.mp4",
      "internet_archive",
      "abc123"
    );
    expect(fromHistoricalCascade).not.toEqual(fromResearchCascade); // different files on disk
    expect(clipContentKey(fromHistoricalCascade)).toEqual(clipContentKey(fromResearchCascade));
    // adoptClip's existing `dedup.usedContentKeys.has(contentKey)` check therefore blocks the
    // second one — this IS the cross-cascade guarantee, regardless of which route ran first.
  });

  it("Test 2/6 — two DIFFERENT provider assets (different ids, same subject/provider) produce DIFFERENT content keys, so both are adoptable", async () => {
    const { tagPathWithProviderAsset, clipContentKey } = await freshPipeline();
    const assetA = tagPathWithProviderAsset("/tmp/work/scene_0_archive_0.mp4", "internet_archive", "moon-landing-nasa-1969");
    const assetB = tagPathWithProviderAsset("/tmp/work/scene_1_archive_0.mp4", "internet_archive", "apollo-11-launch-footage");
    expect(clipContentKey(assetA)).not.toEqual(clipContentKey(assetB));
  });

  it("Test 3 — the SAME provider asset tagged from two entirely different download URLs/basenames still produces the SAME content key", async () => {
    const { tagPathWithProviderAsset, clipContentKey } = await freshPipeline();
    // The key is derived only from provider+id, never from the CDN/download URL or basename —
    // so a mirrored/alternate-CDN URL for the exact same archive.org item still collides.
    const viaCdnA = tagPathWithProviderAsset("/tmp/work/scene_3_cdn1_download_9.mp4", "vimeo", "/videos/778899");
    const viaCdnB = tagPathWithProviderAsset("/tmp/work/scene_3_altcdn_dl_2.mp4", "vimeo", "/videos/778899");
    expect(clipContentKey(viaCdnA)).toEqual(clipContentKey(viaCdnB));
  });

  it("Test 8 — a provider with no stable ID falls back to the canonical URL: same URL twice collides, different URL does not", async () => {
    const { tagPathWithProviderAsset, clipContentKey } = await freshPipeline();
    // media.ccc / NARA have no discrete ID field in their typed API response, so their
    // recording_url / objectUrl (known before download) is used as the canonical-URL fallback.
    const sameUrlFirst = tagPathWithProviderAsset("/tmp/work/scene_0_ccc_0.mp4", "media_ccc", "https://cdn.media.ccc.de/talk1.mp4");
    const sameUrlSecond = tagPathWithProviderAsset("/tmp/work/scene_5_ccc_2.mp4", "media_ccc", "https://cdn.media.ccc.de/talk1.mp4");
    const differentUrl = tagPathWithProviderAsset("/tmp/work/scene_5_ccc_3.mp4", "media_ccc", "https://cdn.media.ccc.de/talk2.mp4");
    expect(clipContentKey(sameUrlFirst)).toEqual(clipContentKey(sameUrlSecond));
    expect(clipContentKey(sameUrlFirst)).not.toEqual(clipContentKey(differentUrl));
  });

  it("a provider tag never collides with the existing curated-asset / stock / still-photo / fallback classifiers", async () => {
    const { tagPathWithProviderAsset, clipContentKey } = await freshPipeline();
    const tagged = tagPathWithProviderAsset("/tmp/work/scene_0_archive_0.mp4", "internet_archive", "some-id");
    // Provider-tagged filenames must still read as ordinary archive video for source-aware
    // grading/classification (isStockVideoClip et al. are unrelated pre-existing logic) — the
    // tag lives after the existing `_archive_` marker, before the extension, so it doesn't
    // shadow the classifiers those functions already rely on.
    expect(tagged).toMatch(/_archive_0__pid_internet_archive-[0-9a-f]{16}\.mp4$/);
    // Round-trips back through the curated-asset short-circuit untouched (no `_curated_a` match).
    expect(clipContentKey(tagged)).toMatch(/^internet_archive:[0-9a-f]{16}$/);
  });

  it("no id (undefined/empty) leaves the path untagged — falls back to the pre-existing content-key heuristic, not a crash", async () => {
    const { tagPathWithProviderAsset } = await freshPipeline();
    expect(tagPathWithProviderAsset("/tmp/work/scene_0_archive_0.mp4", "internet_archive", undefined)).toEqual(
      "/tmp/work/scene_0_archive_0.mp4"
    );
    expect(tagPathWithProviderAsset("/tmp/work/scene_0_archive_0.mp4", "internet_archive", "  ")).toEqual(
      "/tmp/work/scene_0_archive_0.mp4"
    );
  });
});

describe("Visual dedup — (B) pre-download skip (fetchInternetArchiveClips)", () => {
  beforeEach(() => nodeFetchMock.mockReset());

  it("Test 4/5/7 — skips an already-used archive.org identifier before the metadata/license/download call", async () => {
    const { fetchInternetArchiveClips, providerAssetKey } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ response: { docs: [{ identifier: "abc123", title: "Some Documentary Reel" }] } }),
        });
      }
      // Anything else (metadata/download, or an unrelated background call) resolves harmlessly —
      // the assertion below checks the metadata URL specifically was never requested, rather than
      // failing the test on any other incidental call.
      return Promise.resolve({ ok: false, status: 500 });
    });

    const alreadyUsed = new Set([providerAssetKey("internet_archive", "abc123")]);
    const result = await fetchInternetArchiveClips(
      "moon landing", 6, "/tmp", 0, 2, "", "", [], alreadyUsed
    );
    expect(result).toEqual([]);
    const metadataCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("/metadata/abc123"));
    expect(metadataCalls).toHaveLength(0); // pre-download skip fired — metadata never attempted
  });

  it("a DIFFERENT identifier (not in usedProviderKeys) proceeds past the search step normally", async () => {
    const { fetchInternetArchiveClips, providerAssetKey } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ response: { docs: [{ identifier: "new-item-999", title: "Another Reel" }] } }),
        });
      }
      // Deliberately fails past this point (including the metadata call) — this test only needs
      // to prove the item was NOT pre-download-skipped, i.e. the metadata call actually happened.
      return Promise.resolve({ ok: false, status: 404 });
    });

    const usedForADifferentAsset = new Set([providerAssetKey("internet_archive", "abc123")]);
    await fetchInternetArchiveClips("moon landing", 6, "/tmp", 0, 2, "", "", [], usedForADifferentAsset);
    const metadataCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("/metadata/new-item-999"));
    expect(metadataCalls).toHaveLength(1);
  });
});

describe("Visual dedup — (B) pre-download skip (fetchNasaVideoClips, fetchNaraClips)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    nodeFetchMock.mockReset();
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("fetchNasaVideoClips skips an already-used nasa_id before the asset-manifest call", async () => {
    const { fetchNasaVideoClips, providerAssetKey } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("images-api.nasa.gov/search")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ collection: { items: [{ data: [{ nasa_id: "NASA-1969-APOLLO", title: "Apollo footage" }] }] } }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    const alreadyUsed = new Set([providerAssetKey("nasa", "NASA-1969-APOLLO")]);
    const result = await fetchNasaVideoClips("apollo launch", 6, "/tmp", 0, 2, alreadyUsed);
    expect(result).toEqual([]);
    const assetCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("/asset/NASA-1969-APOLLO"));
    expect(assetCalls).toHaveLength(0); // pre-download skip fired — asset manifest never attempted
  });

  it("fetchNaraClips (canonical-URL fallback, Test 8) skips an already-used objectUrl before the download call", async () => {
    process.env.NARA_API_KEY = "test-key";
    const { fetchNaraClips, providerAssetKey } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("catalog.archives.gov")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            body: {
              hits: {
                hits: [
                  {
                    _source: {
                      record: {
                        title: "National Archives reel",
                        digitalObjects: [{ objectUrl: "https://catalog.archives.gov/media/reel-42.mp4", objectType: "video" }],
                      },
                    },
                  },
                ],
              },
            },
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    const alreadyUsed = new Set([providerAssetKey("nara", "https://catalog.archives.gov/media/reel-42.mp4")]);
    const result = await fetchNaraClips("national archives", 6, "/tmp", 0, 1, alreadyUsed);
    expect(result).toEqual([]);
    const downloadCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("reel-42.mp4"));
    expect(downloadCalls).toHaveLength(0); // pre-download skip fired — download never attempted
  });
});

describe("Visual dedup — cross-cascade wiring in fetchHistoricalBeatVideo (Test 4/5/7, production call site)", () => {
  beforeEach(() => nodeFetchMock.mockReset());

  it("the internet_archive tier is skipped pre-download when dedup.usedContentKeys already holds that identifier's key (as a prior acceptance elsewhere in the same render would leave it)", async () => {
    const { fetchHistoricalBeatVideo, createVisualDedupState, getPipelinePerfProfile, providerAssetKey } =
      await freshPipeline();
    const { buildMediaSearchIntent } = await import("./mediaResearchEngine");

    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ response: { docs: [{ identifier: "shared-asset-1", title: "Shared reel" }] } }),
        });
      }
      // Every other tier (YouTube/Wikimedia/etc.) is unconfigured in this test env and returns
      // early without a network call, so archive.org's metadata endpoint is the only thing that
      // would ever be reached next — must never happen once the identifier is already "used".
      return Promise.resolve({ ok: false, status: 500 });
    });

    const dedup = createVisualDedupState(getPipelinePerfProfile("8-10"));
    // Simulates: this exact asset was already ACCEPTED earlier this render (by adoptClip, via a
    // different beat/cascade) — the real acceptance path adds this same key to usedContentKeys.
    dedup.usedContentKeys.add(providerAssetKey("internet_archive", "shared-asset-1"));

    const beat = { index: 0, text: "A documentary beat", searchQuery: "shared reel", powerWord: "", keywords: [] as string[], holdSec: 4 };
    const scene = { index: 0, text: "scene", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 10 };
    const intent = buildMediaSearchIntent({
      beatText: beat.text,
      searchQueries: [beat.searchQuery],
      keywords: [],
      primaryPerson: "",
      persons: [],
      videoTitle: "Test",
      powerWord: "",
      personTopicLock: false,
      spaceTopic: false,
      muskTopic: false,
    });

    await fetchHistoricalBeatVideo(beat as any, scene as any, "/tmp", scene.index, 4, dedup, intent, {}, "test");

    const metadataCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("/metadata/shared-asset-1"));
    expect(metadataCalls).toHaveLength(0); // pre-download skip fired — no metadata/license/download spend
  });
});
