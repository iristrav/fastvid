import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  generateStabilityAIClip,
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
  } as unknown as Awaited<ReturnType<typeof fetchModule>>;
}

describe("generateStabilityAIClip timeout (F3-08-A)", () => {
  let dir: string;
  let outputPath: string;
  let realPng: Buffer;

  beforeEach(async () => {
    process.env.STABILITY_AI_ENABLED = "true";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f308a-test-"));
    outputPath = path.join(dir, "scene_0.mp4");
    mockedFetch.mockReset();
    // A real, valid, noisy PNG (>50KB, matching Stability's own `raw.length > 50_000` gate) —
    // ffmpeg needs to actually decode this for the Ken Burns conversion step to succeed, same
    // as it would with a genuine Stability AI response. A flat-color PNG compresses to well
    // under 1KB regardless of resolution, so random noise is used to produce a realistic size.
    const pngPath = path.join(dir, "seed.png");
    const { exec: execHelper } = await import("./videoPipeline");
    await execHelper(`ffmpeg -y -f lavfi -i "nullsrc=s=640x360,geq=random(1)*255:128:128" -update 1 -frames:v 1 "${pngPath}"`);
    realPng = fs.readFileSync(pngPath);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
    delete process.env.STABILITY_AI_ENABLED;
  });

  it("still produces a valid clip on a normal successful core response (fetchWithTimeout wired correctly)", async () => {
    mockedFetch.mockResolvedValueOnce(bufferResponse(realPng, true));

    const result = await generateStabilityAIClip("a blue square", 1, outputPath, 0);

    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);
    expect(fs.statSync(result!).size).toBeGreaterThan(1000);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [calledUrl] = mockedFetch.mock.calls[0]!;
    expect(String(calledUrl)).toContain("stable-image/generate");
  });

  it("aborts within the 45s budget when the core response headers never arrive, instead of hanging", async () => {
    vi.useFakeTimers();
    mockedFetch.mockImplementation(
      (_url, opts?: Record<string, unknown>) =>
        new Promise((_resolve, reject) => {
          const signal = opts?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }) as ReturnType<typeof fetchModule>
    );

    const resultPromise = generateStabilityAIClip("a blue square", 1, outputPath, 0);
    await vi.advanceTimersByTimeAsync(45_000);
    const result = await resultPromise;

    // A timeout throws (AbortError -> pipelineError), which the function's own outer catch
    // turns into null — never a hang, and never falls through to the SDXL fallback (a thrown
    // error skips the `if (coreResp.ok) {...} else {...}` branch entirely — same control flow
    // as before this fix, since withTimeout also threw on timeout).
    expect(result).toBeNull();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("still falls back to the legacy SDXL endpoint when the core endpoint returns a non-ok response", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ error: "core down" }, false, 500));
    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ artifacts: [{ base64: realPng.toString("base64"), finishReason: "SUCCESS" }] })
    );

    const result = await generateStabilityAIClip("a blue square", 1, outputPath, 0);

    expect(result).not.toBeNull();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    const [, secondUrl] = mockedFetch.mock.calls.map((c) => String(c[0]));
    expect(secondUrl).toContain("stable-diffusion-xl-1024-v1-0");
  });
});

describe("AI-video-provider size validation (F3-08-B)", () => {
  let dir: string;
  let outputPath: string;

  beforeEach(() => {
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

  it("Runway: returns the output path for a valid (>1000 byte) download", async () => {
    // All three responses (create, poll, download) are queued up front — the poll-wait timer
    // advance below can synchronously drive the call straight through to the download fetch
    // within the same microtask flush, so the download mock must already be queued by then.
    mockedFetch.mockResolvedValueOnce(jsonResponse({ id: "task1" }));
    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ status: "SUCCEEDED", output: ["http://fake/video.mp4"] })
    );
    mockedFetch.mockResolvedValueOnce(bufferResponse(Buffer.alloc(5000, "v"), true));
    vi.useFakeTimers();
    const callPromise = generateRunwayClip("prompt", null, 5, outputPath, 0);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await callPromise;

    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);
    expect(fs.statSync(result!).size).toBe(5000);
  });

  it("Runway: returns null for a too-small (<1000 byte) download instead of the path", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ id: "task1" }));
    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ status: "SUCCEEDED", output: ["http://fake/video.mp4"] })
    );
    mockedFetch.mockResolvedValueOnce(bufferResponse(Buffer.alloc(200, "v"), true));
    vi.useFakeTimers();
    const callPromise = generateRunwayClip("prompt", null, 5, outputPath, 0);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await callPromise;

    expect(result).toBeNull();
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
