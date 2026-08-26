import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// F3-34: license/rights gate before download for Internet Archive.
//
// Internet Archive: server/videoPipeline.ts:8659-8672 now checks metadata.licenseurl
// (documented at https://help.archive.org/help/rights/ and
// https://archive.org/developers/md-record.html — confirmed via independent research this
// pass, not guessed) BEFORE ever building a /download/ URL or calling downloadToFileStreaming.
// The metadata call itself changed from archive.org/metadata/{id}/files (which only returns
// `{ result: [...] }`, no rights info) to archive.org/metadata/{id} (the full record, same
// single call, now also carrying `metadata.licenseurl`) — no new network call was added.
//
// NARA: server/videoPipeline.ts:fetchNaraClips is INTENTIONALLY UNCHANGED this pass. Per the
// task's own "stop and report, don't guess the JSON structure" instruction: independent
// research (WebSearch across NARA's Catalog-API GitHub repo, its docs site, and
// archives.gov/research/catalog/help/api) confirmed that a human-readable "Use Restrictions"
// concept exists on NARA catalog records, but could NOT confirm the actual JSON field name(s)
// or nesting used by the v2 records/search response (candidates like `useRestriction.status`
// were not corroborated by any fetchable source — catalog.archives.gov itself is blocked by
// this sandbox's network egress policy, so a live response could not be inspected either).
// Building a gate against a guessed field name risks a silent no-op just as easily as it risks
// silently accepting the wrong thing, which is not something to gamble on for a licensing
// gate. No production code change was made for NARA — see the F3-34 report for the full
// reasoning. Tests 3/4 (NARA) from the task spec are therefore not implemented here.
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

import { fetchInternetArchiveClips, isAllowedInternetArchiveLicense } from "./videoPipeline";

/**
 * RONDE 90 — this file calls provider fetchers directly, outside any beat.
 *
 * In production every provider search runs inside a beat's provenance scope
 * (withSearchProvenance), and that scope is what lets the gate verify a query against what the
 * script actually says. A direct call has no such scope, so strict mode refuses it — correctly,
 * and by design: a query nobody can trace is exactly what RONDE 90 exists to stop.
 *
 * That refusal is not what this file is about. Its subject is what happens AFTER a query is
 * admitted — the render-scoped query cache, the per-item licence gates, the dedup skips, the call
 * ceilings. The gate's own behaviour, including the refusal above, is covered by
 * ronde89ProviderGate and ronde90SearchProvenance; restating it in every assertion here would
 * test the gate twice and these mechanics not at all.
 */
// Set at module scope, not in beforeAll: several suites here snapshot `process.env` into an
// ORIGINAL_ENV constant while the file is being evaluated and restore it before every test, so a
// value written later is wiped again before the first assertion runs.
process.env.SEARCH_GATE_STRICT = "false";


describe("isAllowedInternetArchiveLicense — F3-34 (pure license-string classifier)", () => {
  it("accepts public domain URLs", () => {
    expect(isAllowedInternetArchiveLicense("https://creativecommons.org/publicdomain/zero/1.0/")).toBe(true);
    expect(isAllowedInternetArchiveLicense("https://creativecommons.org/publicdomain/mark/1.0/")).toBe(true);
  });

  it("accepts CC-BY and CC-BY-SA (commercial use + derivatives permitted)", () => {
    expect(isAllowedInternetArchiveLicense("https://creativecommons.org/licenses/by/4.0/")).toBe(true);
    expect(isAllowedInternetArchiveLicense("https://creativecommons.org/licenses/by-sa/3.0/")).toBe(true);
  });

  it("rejects non-commercial and no-derivatives licenses", () => {
    expect(isAllowedInternetArchiveLicense("https://creativecommons.org/licenses/by-nc/4.0/")).toBe(false);
    expect(isAllowedInternetArchiveLicense("https://creativecommons.org/licenses/by-nd/4.0/")).toBe(false);
    expect(isAllowedInternetArchiveLicense("https://creativecommons.org/licenses/by-nc-nd/4.0/")).toBe(false);
  });

  it("rejects missing, empty, or unrecognized values", () => {
    expect(isAllowedInternetArchiveLicense(undefined)).toBe(false);
    expect(isAllowedInternetArchiveLicense(null)).toBe(false);
    expect(isAllowedInternetArchiveLicense("")).toBe(false);
    expect(isAllowedInternetArchiveLicense("   ")).toBe(false);
    expect(isAllowedInternetArchiveLicense("https://example.com/some-other-terms")).toBe(false);
  });
});

describe("fetchInternetArchiveClips — F3-34 Test 1/2 (rights gate before download)", () => {
  beforeEach(() => {
    nodeFetchMock.mockReset();
    getActiveVideoIdMock.mockReturnValue(undefined);
    isVideoGenerationCancelRequestedMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function searchResponse(identifier: string, title = "Test clip") {
    return {
      ok: true,
      json: async () => ({ response: { docs: [{ identifier, title }] } }),
    };
  }

  it("Test 1 — a candidate without a usable license is skipped and the download URL is never requested", async () => {
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) return Promise.resolve(searchResponse("no-rights-item"));
      if (u.includes("/metadata/no-rights-item")) {
        return Promise.resolve({
          ok: true,
          // No `metadata.licenseurl` at all — the exact "missing rights info" case.
          json: async () => ({
            metadata: {},
            files: [{ name: "movie.mp4", format: "MP4", size: "1000000" }],
          }),
        });
      }
      // Belt-and-braces: if the code ever reaches a /download/ URL, fail loudly so the test
      // catches it rather than silently returning a fake success.
      if (u.includes("/download/")) return Promise.resolve({ ok: false, status: 403 });
      return Promise.resolve({ ok: false, status: 404 });
    });

    const result = await fetchInternetArchiveClips("test query", 6, "/tmp", 0, 1);

    expect(result).toEqual([]);
    const downloadCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("/download/"));
    expect(downloadCalls).toHaveLength(0);
  });

  it("Test 2 — a candidate with an explicit, allowed license passes the gate and reaches the download stage", async () => {
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) return Promise.resolve(searchResponse("good-rights-item"));
      if (u.includes("/metadata/good-rights-item")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            metadata: { licenseurl: "https://creativecommons.org/licenses/by/4.0/" },
            files: [{ name: "movie.mp4", format: "MP4", size: "1000000" }],
          }),
        });
      }
      // Download stage — deliberately fails so no real streaming/ffmpeg is reached; this test
      // only needs to prove the licensed item got this far (same convention as the F3-30
      // Europeana test for the identical reason).
      return Promise.resolve({ ok: false, status: 404 });
    });

    await fetchInternetArchiveClips("test query", 6, "/tmp", 0, 1);

    const downloadCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("/download/good-rights-item/"));
    expect(downloadCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("a non-commercial license (explicitly present but disallowed) is also skipped before download", async () => {
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) return Promise.resolve(searchResponse("nc-item"));
      if (u.includes("/metadata/nc-item")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            metadata: { licenseurl: "https://creativecommons.org/licenses/by-nc/4.0/" },
            files: [{ name: "movie.mp4", format: "MP4", size: "1000000" }],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const result = await fetchInternetArchiveClips("test query", 6, "/tmp", 0, 1);

    expect(result).toEqual([]);
    const downloadCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("/download/"));
    expect(downloadCalls).toHaveLength(0);
  });
});
