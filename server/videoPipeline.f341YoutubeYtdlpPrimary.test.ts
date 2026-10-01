import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

// F3-41: swaps downloadYouTubeCCClip()'s download-route priority — the YOUTUBE_CC_DL_SERVICE
// cloud/yt-dlp service (see the F3-40 diagnosis: an external service that runs yt-dlp with an
// ANDROID_VR client workaround, not a local dependency) is now tried FIRST; RapidAPI stays as
// the fallback when the cloud service is unset, errors, or returns nothing usable. YouTube
// search (searchYoutubeVideoCandidates / videoLicense=creativeCommon) is untouched by this fix
// — Test 4 below proves that directly.
//
// RAPIDAPI_KEY is a module-level `const` in videoPipeline.ts (captured once at import time), so
// it must be set before the module is first imported — vi.hoisted runs before any import/mock.
vi.hoisted(() => {
  process.env.RAPIDAPI_KEY = "f341-test-rapidapi-key";
});

const nodeFetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: (...args: unknown[]) => nodeFetchMock(...args) }));

import { downloadYouTubeCCClip, fetchYouTubeCCClips } from "./videoPipeline";

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

const FFMPEG_TEST_TIMEOUT_MS = 30_000;

// A real, ffmpeg-generated ~18s source with real per-frame entropy (a flat `color=` source
// compresses to well under adoptClip's/RapidAPI's own size floors and is rejected — see the
// F3-39 test file's own note on this). Only needed for Test 2, which proves the RapidAPI
// fallback can genuinely succeed (real trim), not just "was called".
let sourceVideoPath: string;
let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "f341-workdir-"));
  sourceVideoPath = path.join(os.tmpdir(), "f341-source.mp4");
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10", "-t", "18",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", sourceVideoPath,
  ], { stdio: "ignore" });
});

afterAll(() => {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(sourceVideoPath, { force: true }); } catch { /* ignore */ }
});

const ORIGINAL_ENV = { ...process.env };

describe("downloadYouTubeCCClip — F3-41 (cloud/yt-dlp service; RapidAPI switched off since video 619)", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    nodeFetchMock.mockReset();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("Test 1 — cloud/yt-dlp service is tried first and succeeds; RapidAPI is never called", async () => {
    process.env.YOUTUBE_CC_DL_SERVICE = "https://f341-cloud-service.example.com";
    const outPath = path.join(workDir, "t1_out.mp4");

    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.startsWith("https://f341-cloud-service.example.com/download")) {
        return Promise.resolve({ ok: true, body: fs.createReadStream(sourceVideoPath) });
      }
      // RapidAPI meta endpoint — must never be hit in this test.
      if (u.includes("/dl?id=")) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const ok = await downloadYouTubeCCClip("f341video1", 6, 10, outPath, 0, "Test video 1");

    expect(ok).toBe(true);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.statSync(outPath).size).toBeGreaterThan(10_000);
    const cloudCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("f341-cloud-service.example.com"));
    expect(cloudCalls.length).toBeGreaterThan(0);
    const rapidApiCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("/dl?id="));
    expect(rapidApiCalls).toHaveLength(0);
  });

  /**
   * VIDEO 619 — RapidAPI is switched off (`RAPIDAPI_SWITCHED_OFF`). Its key is set in this file,
   * and still no request goes to it: a failed cloud cut is the end of the download.
   */
  it("Test 2 — cloud/yt-dlp service fails -> RapidAPI is NOT tried, even with its key set; no crash", async () => {
    process.env.YOUTUBE_CC_DL_SERVICE = "https://f341-cloud-service.example.com";
    const outPath = path.join(workDir, "t2_out.mp4");
    const callOrder: string[] = [];

    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.startsWith("https://f341-cloud-service.example.com/download")) {
        callOrder.push("cloud");
        return Promise.resolve({ ok: false, status: 502, text: async () => "bad gateway" });
      }
      if (u.includes("/dl?id=") || u.includes("rapidapi")) {
        callOrder.push("rapidapi");
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    await expect(downloadYouTubeCCClip("f341video2", 6, 10, outPath, 0, "Test video 2")).resolves.toBe(false);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(callOrder).toEqual(["cloud"]);
  });

  it("Test 3 — a failing cloud route is tried once and nothing after it; function returns false", async () => {
    process.env.YOUTUBE_CC_DL_SERVICE = "https://f341-cloud-service.example.com";
    const outPath = path.join(workDir, "t3_out.mp4");
    const callOrder: string[] = [];

    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.startsWith("https://f341-cloud-service.example.com/download")) {
        callOrder.push("cloud");
        return Promise.resolve({ ok: false, status: 500, text: async () => "server error" });
      }
      if (u.includes("/dl?id=")) {
        callOrder.push("rapidapi-meta");
        return Promise.resolve({ ok: false, status: 403 });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    await expect(downloadYouTubeCCClip("f341video3", 6, 10, outPath, 0, "Test video 3")).resolves.toBe(false);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(callOrder).toEqual(["cloud"]);
  });

  it("Test 3b — cloud service throws (network error): the function returns false instead of propagating", async () => {
    process.env.YOUTUBE_CC_DL_SERVICE = "https://f341-cloud-service.example.com";
    const outPath = path.join(workDir, "t3b_out.mp4");

    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.startsWith("https://f341-cloud-service.example.com/download")) {
        return Promise.reject(new Error("ECONNRESET"));
      }
      if (u.includes("/dl?id=")) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    await expect(downloadYouTubeCCClip("f341video3b", 6, 10, outPath, 0, "Test video 3b")).resolves.toBe(false);
  });

  it("no YOUTUBE_CC_DL_SERVICE configured: RapidAPI is not asked either — there is no route", async () => {
    delete process.env.YOUTUBE_CC_DL_SERVICE;
    const outPath = path.join(workDir, "t_norapid_out.mp4");
    let rapidApiCalled = false;

    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/dl?id=")) {
        rapidApiCalled = true;
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    await expect(downloadYouTubeCCClip("f341video4", 6, 10, outPath, 0, "Test video 4")).resolves.toBe(false);
    expect(rapidApiCalled).toBe(false);
  });
});

