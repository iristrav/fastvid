import { describe, expect, it, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

// F3-39: proves at RUNTIME (not just structurally) that an under-filled scene, driven through
// the REAL getPipelinePerfProfile() (not a hand-rolled profile — see the F3-33 test file's own
// note on this gap), actually reaches the external fallback cascade (Internet Archive / YouTube
// CC) via recoverSceneClipsIfEmpty() -> fetchBeatArchivalThenPexels() -> fetchHistoricalBeatVideo(),
// downloads a real candidate, trims it with real ffmpeg, and adopts the result — instead of
// falling straight to the guaranteed text/color placeholder the way it did before this fix
// (see the F3-39 diagnosis report: getPipelinePerfProfile forced enableArchival/maxEntityYoutube
// to 0 unconditionally in curated-only mode, and a separate stock-budget check in
// fetchBeatArchivalThenPexels gated the same free/CC cascade on an unrelated Pexels budget).
//
// RAPIDAPI_KEY is a module-level `const` in videoPipeline.ts (captured once at import time), so
// it must be set before the module is first imported — vi.hoisted runs before any import/mock.
vi.hoisted(() => {
  process.env.RAPIDAPI_KEY = "f339-test-rapidapi-key";
});

const nodeFetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: (...args: unknown[]) => nodeFetchMock(...args) }));

const fetchCuratedArchiveBeatClipMock = vi.fn<(...args: unknown[]) => Promise<string | null>>();
vi.mock("./curatedMediaSourcing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./curatedMediaSourcing")>();
  return {
    ...actual,
    fetchCuratedArchiveBeatClip: (...args: unknown[]) => fetchCuratedArchiveBeatClipMock(...args),
  };
});

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

import {
  recoverSceneClipsIfEmpty,
  createVisualDedupState,
  getPipelinePerfProfile,
  isAllowedInternetArchiveLicense,
  fetchInternetArchiveClips,
  type Scene,
} from "./videoPipeline";

// RONDE 30: raised from 60s. This case walks the whole external cascade with real ffmpeg
// trims per candidate; 60s was enough when ffmpeg was absent and every encode failed fast,
// but not once the encodes actually run.
const FFMPEG_TEST_TIMEOUT_MS = 240_000;

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    index: 0,
    text: "Historic steam locomotives crossing the Golden Gate Bridge in 1937.",
    visualCue: "steam locomotives Golden Gate Bridge",
    pexelsQuery: "steam locomotives Golden Gate Bridge",
    aiImagePrompt: "steam locomotives Golden Gate Bridge",
    duration: 20,
    ...overrides,
  };
}

// Real, ffmpeg-generated ~18s color test sources — long enough that trimRemoteVideoToClip's
// `-ss 10 -t <duration>` (Internet Archive calls it with clipStart=10) still has footage left to
// cut. Several visually-distinct sources (not just one) so repeated top-up attempts within
// recoverSceneClipsIfEmpty download genuinely different content each time — adoptClip's own
// real content-dedup would otherwise legitimately reject a 2nd/3rd byte-identical "candidate"
// within the same scene, forcing extra real-ffmpeg retry cycles that blow the test timeout even
// though production behavior is fine (real archive.org items are never byte-identical). Each
// mocked download picks the next source round-robin via nextSourceVideo(). Generated once in
// beforeAll and re-read via a fresh fs.createReadStream per call (Node streams are single-use).
const SOURCE_COLORS = ["blue", "red", "green", "yellow", "purple", "cyan", "orange"];
let sourceVideoPaths: string[];
let sourceVideoCallCount = 0;
let workDir: string;

function nextSourceVideo(): string {
  const p = sourceVideoPaths[sourceVideoCallCount % sourceVideoPaths.length]!;
  sourceVideoCallCount++;
  return p;
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "f339-workdir-"));
  // adoptClip rejects any candidate under 180KB (videoPipeline.ts's `if (fileSize < 180_000)
  // continue;`) — a flat `color=` source compresses to almost nothing under h264, well under
  // that floor, and was silently rejected on every attempt. `testsrc2` (a moving, colorful SMPTE
  // test pattern) has real per-frame entropy so the trimmed/rescaled output clears the floor.
  sourceVideoPaths = SOURCE_COLORS.map((_color, i) => {
    const p = path.join(os.tmpdir(), `f339-source-${i}.mp4`);
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=10`, "-t", "18",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", p,
    ], { stdio: "ignore" });
    return p;
  });
});

afterAll(() => {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const p of sourceVideoPaths ?? []) {
    try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }
});

// ─── isAllowedInternetArchiveLicense — F3-39 rights-field widening ───────────────────────────
describe("isAllowedInternetArchiveLicense — F3-39 (rights fallback when licenseurl is absent)", () => {
  it("still accepts everything the F3-34 gate already accepted via licenseurl", () => {
    expect(isAllowedInternetArchiveLicense("https://creativecommons.org/publicdomain/zero/1.0/")).toBe(true);
    expect(isAllowedInternetArchiveLicense("https://creativecommons.org/licenses/by/4.0/")).toBe(true);
    expect(isAllowedInternetArchiveLicense("https://creativecommons.org/licenses/by-nc/4.0/")).toBe(false);
  });

  it("a licenseurl that IS present but unrecognized is rejected — rights never overrides it", () => {
    expect(isAllowedInternetArchiveLicense("https://example.com/some-other-terms", "Public domain")).toBe(false);
  });

  it("no licenseurl, no rights at all — still rejected (no invented rights info)", () => {
    expect(isAllowedInternetArchiveLicense(undefined, undefined)).toBe(false);
    expect(isAllowedInternetArchiveLicense(null, "")).toBe(false);
    expect(isAllowedInternetArchiveLicense(undefined, "   ")).toBe(false);
  });

  it("no licenseurl, rights explicitly states public domain — accepted", () => {
    expect(isAllowedInternetArchiveLicense(undefined, "Public domain")).toBe(true);
    expect(isAllowedInternetArchiveLicense(null, "No known copyright restrictions")).toBe(true);
  });

  it("no licenseurl, rights is present but vague/non-committal — still rejected (no guessing)", () => {
    expect(isAllowedInternetArchiveLicense(undefined, "See item description for details")).toBe(false);
    expect(isAllowedInternetArchiveLicense(undefined, "All rights reserved")).toBe(false);
  });

  it("no licenseurl, rights explicitly non-commercial/no-derivatives wording — still rejected", () => {
    expect(isAllowedInternetArchiveLicense(undefined, "Public domain, non-commercial use only")).toBe(false);
    expect(isAllowedInternetArchiveLicense(undefined, "Public domain but no derivatives permitted")).toBe(false);
  });
});

describe("getPipelinePerfProfile — F3-39 (external fallback no longer forced off in curated-only mode)", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("enableArchival is now inherited from the length profile in curated-only mode (default), instead of hardcoded false", () => {
    delete process.env.CURATED_ARCHIVE_ONLY; // archive-only default
    delete process.env.CURATED_ARCHIVE_EXTERNAL_FALLBACK; // default: fallback allowed
    const profile = getPipelinePerfProfile("8-10"); // bucket whose base profile has enableArchival: true
    expect(profile.enableArchival).toBe(true);
  });

  it("CURATED_ARCHIVE_EXTERNAL_FALLBACK=false restores the old fully-archive-only behavior", () => {
    delete process.env.CURATED_ARCHIVE_ONLY;
    process.env.CURATED_ARCHIVE_EXTERNAL_FALLBACK = "false";
    const profile = getPipelinePerfProfile("8-10");
    expect(profile.enableArchival).toBe(false);
  });

  it("CURATED_ARCHIVE_ONLY=false (fully opted out of archive-first) is unaffected by the new flag", () => {
    process.env.CURATED_ARCHIVE_ONLY = "false";
    const profile = getPipelinePerfProfile("8-10");
    expect(profile.enableArchival).toBe(true);
  });
});

// ─── fetchInternetArchiveClips — F3-39 Test 2/3 (rights gate, download, trim) ─────────────────
describe("fetchInternetArchiveClips — F3-39 Test 2 (accepted candidate reaches download + real trim)", () => {
  beforeEach(() => {
    nodeFetchMock.mockReset();
    getActiveVideoIdMock.mockReturnValue(undefined);
    isVideoGenerationCancelRequestedMock.mockReturnValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockArchiveOk(identifier: string, rightsField: "licenseurl" | "rights") {
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ response: { docs: [{ identifier, title: "Steam locomotive newsreel" }] } }),
        });
      }
      if (u.includes(`/metadata/${identifier}`)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            metadata:
              rightsField === "licenseurl"
                ? { licenseurl: "https://creativecommons.org/publicdomain/mark/1.0/" }
                : { rights: "Public domain" },
            files: [{ name: "movie.mp4", format: "MP4", size: "500000" }],
          }),
        });
      }
      if (u.includes(`/download/${identifier}/`)) {
        return Promise.resolve({ ok: true, body: fs.createReadStream(nextSourceVideo()) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
  }

  it(
    "Test 2 — a candidate with an explicit allowed licenseurl is accepted, downloaded, and successfully trimmed by real ffmpeg",
    async () => {
      mockArchiveOk("good-licenseurl-item", "licenseurl");

      const result = await fetchInternetArchiveClips("steam locomotive", 6, workDir, 0, 1, "t2");

      expect(result).toHaveLength(1);
      expect(fs.existsSync(result[0]!.path)).toBe(true);
      expect(fs.statSync(result[0]!.path).size).toBeGreaterThan(10_000);
      const downloadCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("/download/good-licenseurl-item/"));
      expect(downloadCalls.length).toBeGreaterThanOrEqual(1);
    },
    FFMPEG_TEST_TIMEOUT_MS
  );

  it(
    "F3-39 — a candidate with NO licenseurl but an explicit public-domain rights statement is now also accepted, downloaded, and trimmed",
    async () => {
      mockArchiveOk("good-rights-item", "rights");

      const result = await fetchInternetArchiveClips("steam locomotive", 6, workDir, 0, 1, "t2b");

      expect(result).toHaveLength(1);
      expect(fs.existsSync(result[0]!.path)).toBe(true);
      expect(fs.statSync(result[0]!.path).size).toBeGreaterThan(10_000);
    },
    FFMPEG_TEST_TIMEOUT_MS
  );
});

describe("fetchInternetArchiveClips — F3-39 Test 3 (candidate without reliable rights info is rejected before download)", () => {
  beforeEach(() => {
    nodeFetchMock.mockReset();
    getActiveVideoIdMock.mockReturnValue(undefined);
    isVideoGenerationCancelRequestedMock.mockReturnValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Test 3 — no licenseurl and no rights field at all: rejected, download function called exactly 0 times", async () => {
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ response: { docs: [{ identifier: "no-rights-item", title: "Untitled reel" }] } }),
        });
      }
      if (u.includes("/metadata/no-rights-item")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ metadata: {}, files: [{ name: "movie.mp4", format: "MP4", size: "500000" }] }),
        });
      }
      if (u.includes("/download/")) return Promise.resolve({ ok: false, status: 403 });
      return Promise.resolve({ ok: false, status: 404 });
    });

    const result = await fetchInternetArchiveClips("steam locomotive", 6, workDir, 0, 1, "t3");

    expect(result).toEqual([]);
    const downloadCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("/download/"));
    expect(downloadCalls).toHaveLength(0);
  });

  it("Test 3b — rights present but not an explicit public-domain statement: still rejected, 0 download calls", async () => {
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("advancedsearch.php")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ response: { docs: [{ identifier: "vague-rights-item", title: "Untitled reel" }] } }),
        });
      }
      if (u.includes("/metadata/vague-rights-item")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            metadata: { rights: "Contact the archive for usage terms" },
            files: [{ name: "movie.mp4", format: "MP4", size: "500000" }],
          }),
        });
      }
      if (u.includes("/download/")) return Promise.resolve({ ok: false, status: 403 });
      return Promise.resolve({ ok: false, status: 404 });
    });

    const result = await fetchInternetArchiveClips("steam locomotive", 6, workDir, 0, 1, "t3b");

    expect(result).toEqual([]);
    const downloadCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("/download/"));
    expect(downloadCalls).toHaveLength(0);
  });
});

// ─── recoverSceneClipsIfEmpty — F3-39 Test 1/4/5 (end-to-end, driven by the REAL perf profile) ─
describe("recoverSceneClipsIfEmpty — F3-39 Test 1 (under-filled scene reaches Internet Archive and adopts a real clip, not the blue/text fallback)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CURATED_ARCHIVE_ONLY; // archive-only default (the production default)
    delete process.env.CURATED_ARCHIVE_EXTERNAL_FALLBACK; // default: fallback allowed
    process.env.VISUAL_MATCHING_V1 = "false"; // skip the unrelated legacy Wikimedia-stills pre-step
    nodeFetchMock.mockReset();
    fetchCuratedArchiveBeatClipMock.mockReset();
    fetchCuratedArchiveBeatClipMock.mockResolvedValue(null); // own archive: nothing found, ever
    getActiveVideoIdMock.mockReturnValue(undefined);
    isVideoGenerationCancelRequestedMock.mockReturnValue(false);
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it(
    "Test 1 — curated archive empty -> external cascade reached -> Internet Archive candidate downloaded/trimmed/adopted -> no blue/text placeholder used",
    async () => {
      // A fresh, unique archive.org "item" per search call — not one fixed identifier reused
      // across every query/top-up attempt. adoptClip's own real dedup rejects a repeat of the
      // same already-used identifier/content (correctly — two truly-identical archive.org items
      // never happen in production), so reusing one fixed identifier here would make every
      // attempt after the first a legitimate, correctly-rejected duplicate, forcing the tier
      // loop to exhaust all queries/tiers for every top-up index and blow the test timeout.
      let searchCounter = 0;
      nodeFetchMock.mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes("advancedsearch.php")) {
          const id = `f339-t1-item-${searchCounter++}`;
          return Promise.resolve({
            ok: true,
            json: async () => ({ response: { docs: [{ identifier: id, title: `Steam locomotive newsreel ${id}` }] } }),
          });
        }
        const metaMatch = u.match(/\/metadata\/(f339-t1-item-\d+)/);
        if (metaMatch) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              metadata: { licenseurl: "https://creativecommons.org/publicdomain/mark/1.0/" },
              files: [{ name: "movie.mp4", format: "MP4", size: "500000" }],
            }),
          });
        }
        if (/\/download\/f339-t1-item-\d+\//.test(u)) {
          return Promise.resolve({ ok: true, body: fs.createReadStream(nextSourceVideo()) });
        }
        // Every other tier (YouTube CC, Wikimedia, NARA, Flickr, ...) fails fast and moves on.
        return Promise.resolve({ ok: false, status: 404 });
      });

      // Real getPipelinePerfProfile() — the exact function this fix changed — not a hand-rolled
      // profile, so this test actually exercises the production gate, not a bypass of it.
      const perf = getPipelinePerfProfile("8-10");
      const dedup = createVisualDedupState(perf);
      const scene = makeScene({ duration: 12 });

      const result = await recoverSceneClipsIfEmpty(scene, workDir, "Golden Gate railway history", dedup);

      expect(result.clips.length).toBeGreaterThan(0);
      for (const clipPath of result.clips) {
        expect(fs.existsSync(clipPath)).toBe(true);
        expect(fs.statSync(clipPath).size).toBeGreaterThan(0);
      }
      // At least one adopted clip actually came from the Internet Archive tier (its own distinct
      // output filename pattern), not the guaranteed text/color placeholder (`_guaranteed.mp4`).
      expect(result.clips.some((p) => p.includes("archive_"))).toBe(true);
      expect(result.clips.some((p) => p.includes("_guaranteed"))).toBe(false);
      const archiveOrgCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("archive.org"));
      expect(archiveOrgCalls.length).toBeGreaterThan(0);
    },
    FFMPEG_TEST_TIMEOUT_MS
  );
});

describe("recoverSceneClipsIfEmpty — F3-39 Test 4 (YouTube CC reached and its existing download flow attempted)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CURATED_ARCHIVE_ONLY;
    delete process.env.CURATED_ARCHIVE_EXTERNAL_FALLBACK;
    process.env.VISUAL_MATCHING_V1 = "false";
    process.env.ENABLE_YOUTUBE_SOURCING = "true";
    process.env.YOUTUBE_API_KEY = "f339-test-youtube-key"; // read dynamically, safe to set here
    nodeFetchMock.mockReset();
    fetchCuratedArchiveBeatClipMock.mockReset();
    fetchCuratedArchiveBeatClipMock.mockResolvedValue(null);
    getActiveVideoIdMock.mockReturnValue(undefined);
    isVideoGenerationCancelRequestedMock.mockReturnValue(false);
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it(
    "Test 4 — curated archive empty -> Internet Archive tier misses -> YouTube CC tier is reached and its existing search+download flow is attempted",
    async () => {
      nodeFetchMock.mockImplementation((url: string) => {
        const u = String(url);
        // Internet Archive: always misses for this test, so the loop reaches the youtube_cc tier.
        if (u.includes("advancedsearch.php")) {
          return Promise.resolve({ ok: true, json: async () => ({ response: { docs: [] } }) });
        }
        if (u.includes("googleapis.com/youtube/v3/search")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              items: [
                {
                  id: { videoId: "f339dQw4w9WgXcQ" },
                  snippet: {
                    title: "Historic steam locomotives crossing the Golden Gate Bridge in 1937.",
                    description: "Archival newsreel footage.",
                    thumbnails: { high: { url: "https://example.com/thumb.jpg" } },
                  },
                },
              ],
            }),
          });
        }
        if (u.includes("/dl?id=f339dQw4w9WgXcQ")) {
          // RapidAPI metadata — proves the existing downloader (RAPIDAPI_KEY branch) is reached;
          // deliberately no usable mp4 format so the test doesn't also need a full second real
          // ffmpeg trim run — this test's claim is reachability of the existing download flow
          // (per the task spec: "geldige kandidaat kan de bestaande downloadflow bereiken"),
          // which Test 1 above already proves end-to-end with a real trim for Internet Archive.
          return Promise.resolve({ ok: true, json: async () => ({ formats: [], adaptiveFormats: [] }) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      const perf = getPipelinePerfProfile("8-10");
      const dedup = createVisualDedupState(perf);
      const scene = makeScene({ duration: 12 });

      await recoverSceneClipsIfEmpty(scene, workDir, "Golden Gate railway history", dedup);

      const ytSearchCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("googleapis.com/youtube/v3/search"));
      expect(ytSearchCalls.length).toBeGreaterThan(0);
      const rapidApiCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("/dl?id=f339dQw4w9WgXcQ"));
      expect(rapidApiCalls.length).toBeGreaterThan(0);
    },
    FFMPEG_TEST_TIMEOUT_MS
  );
});

describe("recoverSceneClipsIfEmpty — F3-39 Test 5 (no external source yields anything -> controlled blue/text fallback, no crash, no invalid file)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CURATED_ARCHIVE_ONLY;
    delete process.env.CURATED_ARCHIVE_EXTERNAL_FALLBACK;
    process.env.VISUAL_MATCHING_V1 = "false";
    nodeFetchMock.mockReset();
    nodeFetchMock.mockResolvedValue({ ok: false, status: 404 }); // every tier misses
    fetchCuratedArchiveBeatClipMock.mockReset();
    fetchCuratedArchiveBeatClipMock.mockResolvedValue(null);
    getActiveVideoIdMock.mockReturnValue(undefined);
    isVideoGenerationCancelRequestedMock.mockReturnValue(false);
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it(
    "Test 5 — every source (curated archive, Wikimedia, external cascade) comes up empty: the pipeline still ends up with a valid, existing clip file via the guaranteed fallback, no crash",
    async () => {
      const perf = getPipelinePerfProfile("8-10");
      const dedup = createVisualDedupState(perf);
      const scene = makeScene({ duration: 12 });

      const result = await recoverSceneClipsIfEmpty(scene, workDir, "Golden Gate railway history", dedup);

      expect(result.clips.length).toBeGreaterThan(0);
      for (const clipPath of result.clips) {
        expect(fs.existsSync(clipPath)).toBe(true);
        expect(fs.statSync(clipPath).size).toBeGreaterThan(0);
      }
    },
    FFMPEG_TEST_TIMEOUT_MS
  );
});
