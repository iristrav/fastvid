import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSceneCandidatePool,
  isAllowedLocRights,
  searchLibraryOfCongressCandidates,
  searchNaraCandidates,
  searchNasaCandidates,
  searchOpenverseCandidates,
} from "./scenePool";

// FASE 3 — Maximum Real Footage Discovery: 4 new metadata-only sources (Openverse, NASA, NARA,
// Library of Congress) added to the unified Retrieval Funnel, mirroring the FASE 2 pattern for
// Internet Archive/Europeana. These tests cover discovery (success/empty/malformed/timeout/
// error), license gating, identity/dedup, and Promise.allSettled failure isolation.

function jsonResponse(ok: boolean, data: unknown): Response {
  return {
    ok,
    json: async () => data,
  } as unknown as Response;
}

function fetchSequence(responses: Array<Response | Error>) {
  let i = 0;
  return vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    return next;
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─── Openverse ──────────────────────────────────────────────────────────────

describe("searchOpenverseCandidates", () => {
  it("returns candidates for a successful, well-formed response", async () => {
    global.fetch = fetchSequence([
      jsonResponse(true, {
        results: [
          {
            id: "ov1",
            url: "https://example.test/photo.jpg",
            title: "Churchill portrait",
            license: "cc-by",
            license_url: "https://creativecommons.org/licenses/by/4.0/",
            creator: "Jane Doe",
          },
        ],
      }),
    ]);
    const { candidates } = await searchOpenverseCandidates(["Churchill"], 5);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: "openverse",
      mediaType: "image",
      license: "cc-by",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      sourceCreator: "Jane Doe",
    });
  });

  it("returns an empty list on an empty results array", async () => {
    global.fetch = fetchSequence([jsonResponse(true, { results: [] })]);
    const { candidates } = await searchOpenverseCandidates(["nonexistent query xyz"], 5);
    expect(candidates).toEqual([]);
  });

  it("rejects an item missing a license (malformed/incomplete response)", async () => {
    global.fetch = fetchSequence([
      jsonResponse(true, {
        results: [{ id: "ov2", url: "https://example.test/a.jpg", title: "no license" }],
      }),
    ]);
    const { candidates } = await searchOpenverseCandidates(["query"], 5);
    expect(candidates).toEqual([]);
  });

  it("rejects a non-image URL (malformed response)", async () => {
    global.fetch = fetchSequence([
      jsonResponse(true, {
        results: [{ id: "ov3", url: "https://example.test/video.mp4", license: "cc0" }],
      }),
    ]);
    const { candidates } = await searchOpenverseCandidates(["query"], 5);
    expect(candidates).toEqual([]);
  });

  it("degrades to an empty list, not a throw, on a network timeout/error", async () => {
    global.fetch = fetchSequence([new Error("network timeout")]);
    const { candidates } = await searchOpenverseCandidates(["query"], 5);
    expect(candidates).toEqual([]);
  });

  it("degrades to an empty list on a provider error status (e.g. 500)", async () => {
    global.fetch = fetchSequence([jsonResponse(false, {})]);
    const { candidates } = await searchOpenverseCandidates(["query"], 5);
    expect(candidates).toEqual([]);
  });

  it("deduplicates repeated ids across queries", async () => {
    const item = { id: "ov-dup", url: "https://example.test/dup.jpg", license: "cc0" };
    global.fetch = fetchSequence([
      jsonResponse(true, { results: [item] }),
      jsonResponse(true, { results: [item] }),
    ]);
    const { candidates } = await searchOpenverseCandidates(["q1", "q2"], 5);
    expect(candidates).toHaveLength(1);
  });
});

// ─── NASA ───────────────────────────────────────────────────────────────────

describe("searchNasaCandidates", () => {
  it("returns candidates for a successful search + asset-manifest response", async () => {
    global.fetch = fetchSequence([
      jsonResponse(true, {
        collection: { items: [{ data: [{ nasa_id: "apollo11", title: "Apollo 11 launch" }] }] },
      }),
      jsonResponse(true, {
        collection: { items: [{ href: "https://images-assets.nasa.gov/apollo11.mp4" }] },
      }),
    ]);
    const { candidates } = await searchNasaCandidates(["Apollo 11 launch"], 5);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: "nasa",
      mediaType: "video",
      assetId: "apollo11",
      license: "Public Domain (NASA / U.S. Government Work)",
      remoteUrl: "https://images-assets.nasa.gov/apollo11.mp4",
    });
  });

  it("returns an empty list when the search has no items", async () => {
    global.fetch = fetchSequence([jsonResponse(true, { collection: { items: [] } })]);
    const { candidates } = await searchNasaCandidates(["nothing here"], 5);
    expect(candidates).toEqual([]);
  });

  it("skips an item whose asset manifest has no mp4 (malformed/unusable asset)", async () => {
    global.fetch = fetchSequence([
      jsonResponse(true, { collection: { items: [{ data: [{ nasa_id: "x1" }] }] } }),
      jsonResponse(true, { collection: { items: [{ href: "https://images-assets.nasa.gov/x1.srt" }] } }),
    ]);
    const { candidates } = await searchNasaCandidates(["query"], 5);
    expect(candidates).toEqual([]);
  });

  it("degrades to an empty list on a search timeout/error", async () => {
    global.fetch = fetchSequence([new Error("timeout")]);
    const { candidates } = await searchNasaCandidates(["query"], 5);
    expect(candidates).toEqual([]);
  });

  it("degrades to an empty list on an asset-manifest fetch error, without crashing the query", async () => {
    global.fetch = fetchSequence([
      jsonResponse(true, { collection: { items: [{ data: [{ nasa_id: "x2" }] }] } }),
      new Error("asset fetch failed"),
    ]);
    const { candidates } = await searchNasaCandidates(["query"], 5);
    expect(candidates).toEqual([]);
  });
});

// ─── NARA ───────────────────────────────────────────────────────────────────

describe("searchNaraCandidates", () => {
  it("returns candidates for a successful, well-formed response", async () => {
    global.fetch = fetchSequence([
      jsonResponse(true, {
        body: {
          hits: {
            hits: [
              {
                _source: {
                  record: {
                    title: "WWII newsreel",
                    digitalObjects: [{ objectUrl: "https://catalog.archives.gov/reel.mp4", objectType: "video" }],
                  },
                },
              },
            ],
          },
        },
      }),
    ]);
    const { candidates } = await searchNaraCandidates(["WWII"], "test-key", 5);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: "nara",
      mediaType: "video",
      license: "Public Domain (NARA / U.S. Government Work)",
      remoteUrl: "https://catalog.archives.gov/reel.mp4",
    });
  });

  it("returns an empty list when no hits are present", async () => {
    global.fetch = fetchSequence([jsonResponse(true, { body: { hits: { hits: [] } } })]);
    const { candidates } = await searchNaraCandidates(["nothing"], "test-key", 5);
    expect(candidates).toEqual([]);
  });

  it("skips a hit with no digitalObjects (malformed record)", async () => {
    global.fetch = fetchSequence([
      jsonResponse(true, { body: { hits: { hits: [{ _source: { record: { title: "no media" } } }] } } }),
    ]);
    const { candidates } = await searchNaraCandidates(["query"], "test-key", 5);
    expect(candidates).toEqual([]);
  });

  it("degrades to an empty list on a search timeout/error", async () => {
    global.fetch = fetchSequence([new Error("timeout")]);
    const { candidates } = await searchNaraCandidates(["query"], "test-key", 5);
    expect(candidates).toEqual([]);
  });

  it("degrades to an empty list on a provider error status", async () => {
    global.fetch = fetchSequence([jsonResponse(false, {})]);
    const { candidates } = await searchNaraCandidates(["query"], "test-key", 5);
    expect(candidates).toEqual([]);
  });

  it("deduplicates repeated objectUrls across queries (its identity fallback)", async () => {
    const hit = {
      _source: {
        record: {
          title: "dup",
          digitalObjects: [{ objectUrl: "https://catalog.archives.gov/dup.mp4", objectType: "video" }],
        },
      },
    };
    global.fetch = fetchSequence([
      jsonResponse(true, { body: { hits: { hits: [hit] } } }),
      jsonResponse(true, { body: { hits: { hits: [hit] } } }),
    ]);
    const { candidates } = await searchNaraCandidates(["q1", "q2"], "test-key", 5);
    expect(candidates).toHaveLength(1);
  });
});

// ─── Library of Congress ───────────────────────────────────────────────────

describe("isAllowedLocRights", () => {
  it("allows an explicit 'no known restrictions' rights string", () => {
    expect(isAllowedLocRights("No known restrictions on publication.")).toBe(true);
  });
  it("allows an explicit 'public domain' rights string", () => {
    expect(isAllowedLocRights("Public domain in the United States.")).toBe(true);
  });
  it("rejects an ambiguous/unevaluated rights string", () => {
    expect(isAllowedLocRights("Rights status not evaluated.")).toBe(false);
  });
  it("rejects a restricted rights string", () => {
    expect(isAllowedLocRights("Permission required for reproduction.")).toBe(false);
  });
  it("rejects a missing rights value", () => {
    expect(isAllowedLocRights(undefined)).toBe(false);
    expect(isAllowedLocRights(null)).toBe(false);
    expect(isAllowedLocRights("")).toBe(false);
  });
});

describe("searchLibraryOfCongressCandidates", () => {
  it("returns candidates for a successful, well-formed, public-domain response", async () => {
    global.fetch = fetchSequence([
      jsonResponse(true, {
        results: [
          { id: "loc1", url: "https://www.loc.gov/item/2004664371/", title: "Lincoln photo", access_restricted: false },
        ],
      }),
      jsonResponse(true, {
        item: { rights: "No known restrictions on publication." },
        resources: [{ files: [[{ mimetype: "image/jpeg", url: "https://tile.loc.gov/lincoln.jpg" }]] }],
      }),
    ]);
    const { candidates } = await searchLibraryOfCongressCandidates(["Lincoln"], 5);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: "loc",
      mediaType: "image",
      remoteUrl: "https://tile.loc.gov/lincoln.jpg",
    });
  });

  it("returns an empty list when the search has no results", async () => {
    global.fetch = fetchSequence([jsonResponse(true, { results: [] })]);
    const { candidates } = await searchLibraryOfCongressCandidates(["nothing"], 5);
    expect(candidates).toEqual([]);
  });

  it("rejects an item with access_restricted=true before ever fetching item detail", async () => {
    const itemFetch = vi.fn();
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes("/search/")) {
        return jsonResponse(true, {
          results: [{ id: "loc2", url: "https://www.loc.gov/item/x/", access_restricted: true }],
        });
      }
      itemFetch();
      return jsonResponse(true, {});
    }) as unknown as typeof fetch;
    const { candidates } = await searchLibraryOfCongressCandidates(["query"], 5);
    expect(candidates).toEqual([]);
    expect(itemFetch).not.toHaveBeenCalled();
  });

  it("rejects an item with an unclear/missing rights field (conservative gate)", async () => {
    global.fetch = fetchSequence([
      jsonResponse(true, { results: [{ id: "loc3", url: "https://www.loc.gov/item/y/", access_restricted: false }] }),
      jsonResponse(true, {
        item: {},
        resources: [{ files: [[{ mimetype: "image/jpeg", url: "https://tile.loc.gov/y.jpg" }]] }],
      }),
    ]);
    const { candidates } = await searchLibraryOfCongressCandidates(["query"], 5);
    expect(candidates).toEqual([]);
  });

  it("rejects an allowed-rights item with no usable media file (malformed resources)", async () => {
    global.fetch = fetchSequence([
      jsonResponse(true, { results: [{ id: "loc4", url: "https://www.loc.gov/item/z/", access_restricted: false }] }),
      jsonResponse(true, { item: { rights: "Public domain." }, resources: [] }),
    ]);
    const { candidates } = await searchLibraryOfCongressCandidates(["query"], 5);
    expect(candidates).toEqual([]);
  });

  it("degrades to an empty list on a search timeout/error", async () => {
    global.fetch = fetchSequence([new Error("timeout")]);
    const { candidates } = await searchLibraryOfCongressCandidates(["query"], 5);
    expect(candidates).toEqual([]);
  });

  it("degrades to an empty list on an item-detail fetch error, without crashing the query", async () => {
    global.fetch = fetchSequence([
      jsonResponse(true, { results: [{ id: "loc5", url: "https://www.loc.gov/item/w/", access_restricted: false }] }),
      new Error("item fetch failed"),
    ]);
    const { candidates } = await searchLibraryOfCongressCandidates(["query"], 5);
    expect(candidates).toEqual([]);
  });
});

// ─── Funnel integration: new sources reach the unified pool, isolation, caps ──

describe("buildSceneCandidatePool — FASE 3 new-source integration", () => {
  it("includes a successful new source's candidates in the unified pool", async () => {
    // Wikimedia always runs (no skip flag for it) alongside NASA here, so route by URL rather
    // than call order — a plain in-order sequence would let Wikimedia's own search call
    // consume a response meant for NASA.
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("images-api.nasa.gov/search")) {
        return jsonResponse(true, {
          collection: { items: [{ data: [{ nasa_id: "n1", title: "Saturn V" }] }] },
        });
      }
      if (u.includes("images-api.nasa.gov/asset")) {
        return jsonResponse(true, { collection: { items: [{ href: "https://images-assets.nasa.gov/n1.mp4" }] } });
      }
      return jsonResponse(true, {});
    }) as unknown as typeof fetch;
    const pool = await buildSceneCandidatePool({
      sceneIndex: 0,
      sceneText: "Saturn V rocket launch",
      primaryQuery: "Saturn V rocket",
      skipPexels: true,
      skipPixabay: true,
      skipInternetArchive: true,
      skipEuropeana: true,
      skipOpenverse: true,
      skipNasa: false,
      skipNara: true,
      skipLoc: true,
    });
    expect(pool.candidates.some(c => c.source === "nasa")).toBe(true);
  });

  it("one failing new source does not block the others (Promise.allSettled isolation)", async () => {
    // NASA's search rejects outright; Openverse's search succeeds. Both run in the same pool.
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes("images-api.nasa.gov")) {
        throw new Error("NASA is down");
      }
      if (String(url).includes("api.openverse.org")) {
        return jsonResponse(true, {
          results: [{ id: "ov-iso", url: "https://example.test/iso.jpg", license: "cc0" }],
        });
      }
      return jsonResponse(true, {});
    }) as unknown as typeof fetch;
    const pool = await buildSceneCandidatePool({
      sceneIndex: 0,
      sceneText: "test",
      primaryQuery: "test query",
      skipPexels: true,
      skipPixabay: true,
      skipInternetArchive: true,
      skipEuropeana: true,
      skipOpenverse: false,
      skipNasa: false,
      skipNara: true,
      skipLoc: true,
    });
    expect(pool.candidates.some(c => c.source === "openverse")).toBe(true);
    expect(pool.candidates.some(c => c.source === "nasa")).toBe(false);
  });

  it("skips NARA entirely when no naraApiKey is provided (clean no-op, matching the eager fetcher)", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(true, { results: [] }));
    global.fetch = fetchSpy as unknown as typeof fetch;
    await buildSceneCandidatePool({
      sceneIndex: 0,
      sceneText: "test",
      primaryQuery: "test query",
      skipPexels: true,
      skipPixabay: true,
      skipInternetArchive: true,
      skipEuropeana: true,
      skipOpenverse: true,
      skipNasa: true,
      skipNara: false,
      skipLoc: true,
      // naraApiKey intentionally omitted
    });
    const calledNara = fetchSpy.mock.calls.some(c => String(c[0]).includes("catalog.archives.gov"));
    expect(calledNara).toBe(false);
  });
});
