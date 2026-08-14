import { describe, expect, it, vi, beforeEach } from "vitest";

// F3-29: web-wide discovery — tier 11 of the F3-28 source cascade, tried only after own
// archive + tiers 2-10 (Internet Archive/YouTube CC/Wikimedia/NARA/Flickr/SepiaSearch/
// Vimeo/media.ccc/NASA) have failed for a beat, and only before Pexels/Pixabay. The only
// engine is Openverse (api.openverse.org, keyless, license_type=commercial,modification
// filter) — license-safe by construction, not by inference. These tests exercise the
// license gate and cancellation directly against the real exported function, mocking only
// the network layer (node-fetch, the same import videoPipeline.ts itself uses) — no real
// downloads, no real ffmpeg conversion is reached in any of these cases.
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

import { searchWebWideVideoClips } from "./videoPipeline";

describe("searchWebWideVideoClips — F3-29 Test C/D (license-safety gate)", () => {
  beforeEach(() => {
    nodeFetchMock.mockReset();
    getActiveVideoIdMock.mockReturnValue(undefined);
    isVideoGenerationCancelRequestedMock.mockReturnValue(false);
  });

  it("Test C — a candidate with an explicit license is downloaded (passes the gate)", async () => {
    nodeFetchMock.mockImplementation((url: string) => {
      if (String(url).includes("api.openverse.org")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "1",
                url: "https://example.com/good.jpg",
                license: "cc-by",
                license_url: "https://creativecommons.org/licenses/by/4.0/",
                creator: "Jane Doe",
                foreign_landing_url: "https://openverse.org/image/1",
                title: "Good Photo",
              },
            ],
          }),
        });
      }
      // Image download deliberately fails — this test only needs to prove the licensed
      // candidate reached the download stage, not that the full ffmpeg conversion succeeds.
      return Promise.resolve({ ok: false, status: 404 });
    });

    await searchWebWideVideoClips(["Kylie Jenner"], 6, "/tmp", 0, 1);

    const downloadCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("good.jpg"));
    expect(downloadCalls).toHaveLength(1);
  });

  it("Test D — a candidate without a reliable license is never even downloaded", async () => {
    nodeFetchMock.mockImplementation((url: string) => {
      if (String(url).includes("api.openverse.org")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { id: "2", url: "https://example.com/bad.jpg", license: "", title: "No license" },
              { id: "3", url: "https://example.com/bad2.jpg", title: "Missing license field" },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const result = await searchWebWideVideoClips(["Kylie Jenner"], 6, "/tmp", 0, 2);

    expect(result).toEqual([]);
    const downloadCalls = nodeFetchMock.mock.calls.filter(
      ([u]) => String(u).includes("bad.jpg") || String(u).includes("bad2.jpg")
    );
    expect(downloadCalls).toHaveLength(0);
  });

  it("never throws when the search request itself fails", async () => {
    nodeFetchMock.mockRejectedValue(new Error("network down"));
    await expect(searchWebWideVideoClips(["X"], 6, "/tmp", 0, 1)).resolves.toEqual([]);
  });
});

describe("searchWebWideVideoClips — F3-29 Test H (cancellation)", () => {
  beforeEach(() => {
    nodeFetchMock.mockReset();
  });

  it("makes no network calls at all once cancellation has been requested for the active video", async () => {
    getActiveVideoIdMock.mockReturnValue(42);
    isVideoGenerationCancelRequestedMock.mockReturnValue(true);

    const result = await searchWebWideVideoClips(["Kylie Jenner"], 6, "/tmp", 0, 1);

    expect(result).toEqual([]);
    expect(nodeFetchMock).not.toHaveBeenCalled();
  });
});
