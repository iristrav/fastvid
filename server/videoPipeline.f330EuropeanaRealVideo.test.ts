import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";

const FIXTURE_VIDEO_PATH = path.join(__dirname, "__fixtures__", "f331-tiny-test-video.mp4");

// F3-30: real web-wide video sourcing — Europeana (api.europeana.eu) aggregates real video
// (not stills) from EU cultural institutions and is now enriched to require + return a
// per-item rights URL before a candidate is ever downloaded — genuinely license-verified, not
// "found so assumed free". videoPipeline.ts calls the API via `import fetch from "node-fetch"`
// (not the global fetch), same as the F3-28/F3-29 test convention.
//
// server/videoPipeline.ts reads EUROPEANA_API_KEY into a module-level constant at import time
// (`const EUROPEANA_API_KEY = process.env.EUROPEANA_API_KEY || ""`), so tests that need the key
// "present" must set process.env before the module is (re-)imported — vi.resetModules() +
// dynamic import() per test, rather than a top-level static import.
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

describe("fetchEuropeanaVideos — F3-30 (real video, per-item license gate)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    nodeFetchMock.mockReset();
    getActiveVideoIdMock.mockReturnValue(undefined);
    isVideoGenerationCancelRequestedMock.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is a clean no-op (no network call) without EUROPEANA_API_KEY", async () => {
    process.env.EUROPEANA_API_KEY = "";
    process.env.ENABLE_EUROPEANA = "true";
    const fetchEuropeanaVideos = await loadFetchEuropeanaVideos();
    const result = await fetchEuropeanaVideos("Kylie Jenner", 6, "/tmp", 0, 1);
    expect(result).toEqual([]);
    expect(nodeFetchMock).not.toHaveBeenCalled();
  });

  it("an item WITH a per-item rights URL passes the license gate and reaches the download stage", async () => {
    process.env.EUROPEANA_API_KEY = "test-key";
    process.env.ENABLE_EUROPEANA = "true";
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("api.europeana.eu/record/v2/search.json")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ items: [{ id: "/123/good", title: ["Good clip"] }] }),
        });
      }
      if (u.includes("api.europeana.eu/record/v2/123/good.json")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            object: {
              aggregations: [{
                edmIsShownBy: "https://example.com/good-video.mp4",
                edmRights: "http://creativecommons.org/publicdomain/mark/1.0/",
              }],
              proxies: [{ dcCreator: ["Some Museum"] }],
            },
          }),
        });
      }
      // Download stage — deliberately fails so no real streaming/ffmpeg is reached; this test
      // only needs to prove the licensed item got this far.
      return Promise.resolve({ ok: false, status: 404 });
    });

    const fetchEuropeanaVideos = await loadFetchEuropeanaVideos();
    await fetchEuropeanaVideos("Kylie Jenner", 6, "/tmp", 0, 1);

    const downloadCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("good-video.mp4"));
    expect(downloadCalls).toHaveLength(1);
  });

  it("an item WITHOUT a per-item rights URL is skipped and never downloaded", async () => {
    process.env.EUROPEANA_API_KEY = "test-key";
    process.env.ENABLE_EUROPEANA = "true";
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("api.europeana.eu/record/v2/search.json")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ items: [{ id: "/123/norights", title: ["No rights clip"] }] }),
        });
      }
      if (u.includes("api.europeana.eu/record/v2/123/norights.json")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            object: {
              aggregations: [{ edmIsShownBy: "https://example.com/norights-video.mp4" }],
            },
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const fetchEuropeanaVideos = await loadFetchEuropeanaVideos();
    const result = await fetchEuropeanaVideos("Kylie Jenner", 6, "/tmp", 0, 1);

    expect(result).toEqual([]);
    const downloadCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("norights-video.mp4"));
    expect(downloadCalls).toHaveLength(0);
  });

  it("never throws when the search request itself fails", async () => {
    process.env.EUROPEANA_API_KEY = "test-key";
    process.env.ENABLE_EUROPEANA = "true";
    nodeFetchMock.mockRejectedValue(new Error("network down"));
    const fetchEuropeanaVideos = await loadFetchEuropeanaVideos();
    await expect(fetchEuropeanaVideos("X", 6, "/tmp", 0, 1)).resolves.toEqual([]);
  });

  it("F3-29 Test 8 — makes no network calls at all once cancellation has been requested for the active video", async () => {
    process.env.EUROPEANA_API_KEY = "test-key";
    process.env.ENABLE_EUROPEANA = "true";
    getActiveVideoIdMock.mockReturnValue(42);
    isVideoGenerationCancelRequestedMock.mockReturnValue(true);

    const fetchEuropeanaVideos = await loadFetchEuropeanaVideos();
    const result = await fetchEuropeanaVideos("Kylie Jenner", 6, "/tmp", 0, 1);

    expect(result).toEqual([]);
    expect(nodeFetchMock).not.toHaveBeenCalled();
  });

  it("F3-31 Test 5 — stops record-fetching as soon as one license-safe video has been found (count=1), even with more results in the page", async () => {
    process.env.EUROPEANA_API_KEY = "test-key";
    process.env.ENABLE_EUROPEANA = "true";
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("api.europeana.eu/record/v2/search.json")) {
        // Requesting a smaller page (F3-31 credit optimization: rows=6, was 12) is itself part
        // of what this pass changed — asserted separately below.
        expect(u).toContain("rows=6");
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              { id: "/1/first", title: ["First clip"] },
              { id: "/1/second", title: ["Second clip"] },
            ],
          }),
        });
      }
      if (u.includes("api.europeana.eu/record/v2/1/first.json")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            object: {
              aggregations: [{
                edmIsShownBy: "https://example.com/first-video.mp4",
                edmRights: "http://creativecommons.org/publicdomain/mark/1.0/",
              }],
            },
          }),
        });
      }
      if (u.includes("api.europeana.eu/record/v2/1/second.json")) {
        // Would also be licensed, but must never be reached — proves early stop, not just
        // "second item happens to lack rights".
        return Promise.resolve({
          ok: true,
          json: async () => ({
            object: {
              aggregations: [{
                edmIsShownBy: "https://example.com/second-video.mp4",
                edmRights: "http://creativecommons.org/publicdomain/mark/1.0/",
              }],
            },
          }),
        });
      }
      if (u.includes("first-video.mp4")) {
        // Real, valid, ~10s video bytes so trimRemoteVideoToClip's real ffmpeg trim (duration=6,
        // clipStart=3) genuinely succeeds and `downloaded` actually reaches 1 — proving the
        // early stop against a real success, not a mocked-away one.
        return Promise.resolve({
          ok: true,
          body: Readable.from(fs.readFileSync(FIXTURE_VIDEO_PATH)),
          headers: { get: () => null },
        });
      }
      // Anything else (e.g. a "second-video.mp4" download, which must never be requested).
      return Promise.resolve({ ok: false, status: 404 });
    });

    const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "f331-europeana-test-"));
    try {
      const fetchEuropeanaVideos = await loadFetchEuropeanaVideos();
      const result = await fetchEuropeanaVideos("Kylie Jenner", 6, tmpWorkDir, 0, 1);

      expect(result).toHaveLength(1);
      const firstRecordCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("1/first.json"));
      const secondRecordCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("1/second.json"));
      expect(firstRecordCalls).toHaveLength(1);
      expect(secondRecordCalls).toHaveLength(0);
    } finally {
      fs.rmSync(tmpWorkDir, { recursive: true, force: true });
    }
  });
});
