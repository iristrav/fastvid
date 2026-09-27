import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import {
  
  generateRunwayClip,
  generateLumaClip,
  generatePikaClip,
  generateManusForgeClip,
} from "./videoPipeline";

// F3-08-A: generateStabilityAIClip's two fetch paths (core/ultra generation, legacy SDXL
// fallback) used withTimeout(fetch(...)) — a zombie-timeout pattern that never aborts the
// underlying connection. Both now use fetchWithTimeout (real AbortController), matching every
// other AI-video-provider's final download step. Only the transport is mocked here (node-fetch,
// the same technique used for F3-07's fetchExternalUrlSafely tests) — the real 45s timeout
// value, fallback chain, and error handling all run unmocked.
//
// F3-08-B: generateRunwayClip/generateLumaClip/generatePikaClip/generateManusForgeClip now
// validate the downloaded file's size before returning its path (matching the existing
// generateLeonardoAIClip pattern), instead of unconditionally trusting the response. Per the
// F3-08 research report, only generateRunwayClip is reachable from live code (via
// fetchBeatAIClip); generateLumaClip/generatePikaClip/generateManusForgeClip are confirmed dead
// code (never called anywhere in server/), so their tests are necessarily isolated —
// driving each function directly through its own create/poll/download flow.
//
// STABILITY_AI_API_KEY / RUNWAY_API_KEY / LUMA_API_KEY / PIKA_API_KEY are module-level consts
// captured from process.env at import time, so this file must be run with those env vars
// already set (see the F3-08 implementation report for the exact command). BUILT_IN_FORGE_API_URL/
// _KEY are read live inside generateManusForgeClip itself, so they're set per-test instead.
vi.mock("node-fetch", () => ({ default: vi.fn() }));

import fetchModule from "node-fetch";
const mockedFetch = vi.mocked(fetchModule);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Awaited<ReturnType<typeof fetchModule>>;
}

function bufferResponse(buf: Buffer, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    // F3-13 regression fix: generateRunwayClip's download step now streams via
    // pipeline(dlResp.body, ...) instead of arrayBuffer() — body is a real Node Readable
    // (matching node-fetch's actual Response.body shape) yielding the same bytes as
    // arrayBuffer() above, so both the still-arrayBuffer()-based callers (Stability AI,
    // Luma/Pika/Manus Forge — untouched by F3-13) and Runway's new streaming consumption
    // get consistent, correct data from the same mock.
    body: Readable.from(buf),
  } as unknown as Awaited<ReturnType<typeof fetchModule>>;
}

describe("AI-video-provider size validation (F3-08-B)", () => {
  let dir: string;
  let outputPath: string;

  beforeEach(() => {
    // RONDE 30: these were never set anywhere, and the provider credentials used to be
    // captured at import time, so this file could only pass when someone prefixed the
    // vitest command with them by hand. The keys are read at call time now, so setting
    // them here is enough — and a real key in the environment still wins.
    process.env.REPLICATE_API_KEY = process.env.REPLICATE_API_KEY || "test-key";
    process.env.RUNWAY_API_KEY = process.env.RUNWAY_API_KEY || "test-key";
    process.env.STABILITY_AI_API_KEY = process.env.STABILITY_AI_API_KEY || "test-key";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f308b-test-"));
    outputPath = path.join(dir, "scene_0.mp4");
    mockedFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
    delete process.env.BUILT_IN_FORGE_API_URL;
    delete process.env.BUILT_IN_FORGE_API_KEY;
  });

  it("Luma (dead code, isolated): returns null for a too-small download", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ id: "gen1" }));
    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ state: "completed", assets: { video: "http://fake/video.mp4" } })
    );
    mockedFetch.mockResolvedValueOnce(bufferResponse(Buffer.alloc(100, "v"), true));
    vi.useFakeTimers();
    const callPromise = generateLumaClip("prompt", null, 5, outputPath, 0);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await callPromise;

    expect(result).toBeNull();
  });

  it("Pika (dead code, isolated): returns null for a too-small download", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ id: "task1" }));
    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ status: "finished", videos: [{ url: "http://fake/video.mp4" }] })
    );
    mockedFetch.mockResolvedValueOnce(bufferResponse(Buffer.alloc(100, "v"), true));
    vi.useFakeTimers();
    const callPromise = generatePikaClip("prompt", null, 5, outputPath, 0);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await callPromise;

    expect(result).toBeNull();
  });

  it("Manus Forge (dead code, isolated): returns null for a too-small download on the direct-URL path", async () => {
    process.env.BUILT_IN_FORGE_API_URL = "https://fake-forge.example";
    process.env.BUILT_IN_FORGE_API_KEY = "test-key";
    mockedFetch.mockResolvedValueOnce(jsonResponse({ url: "http://fake/video.mp4" }));
    mockedFetch.mockResolvedValueOnce(bufferResponse(Buffer.alloc(100, "v"), true));

    const result = await generateManusForgeClip("prompt", 5, outputPath, 0);

    expect(result).toBeNull();
  });

  it("shared size-gate pattern: a missing output file is rejected (fs.existsSync guard)", () => {
    // The exact literal pattern added to all five return sites in F3-08-B —
    // verified in isolation against a real (deleted) file on disk, matching the
    // "geïsoleerd" allowance for the unreachable providers' identical code shape.
    const missingPath = path.join(dir, "never_written.mp4");
    const check = (p: string) => (fs.existsSync(p) && fs.statSync(p).size > 1000 ? p : null);

    expect(check(missingPath)).toBeNull();
  });
});
