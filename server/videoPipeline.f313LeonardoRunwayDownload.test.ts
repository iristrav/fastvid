import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";

// F3-13 finding 3.2: generateLeonardoAIClip's final image download and generateRunwayClip's
// final video download used fetchWithTimeout(...) + Buffer.from(await resp.arrayBuffer()) — a
// timeout that only protects up to the response headers arriving (fetchWithTimeout's internal
// clearTimeout fires the instant fetch() itself resolves) plus full in-memory buffering. Both now
// use fetch(url, { signal: AbortSignal.timeout(ms) }) — which covers the entire request lifecycle
// including the body-read, the same pattern already proven for Grok/Veo/Higgsfield's downloads in
// this file and for F3-10's streamArchiveAssetDownload — piped straight to disk via
// stream/promises' pipeline() instead of buffering.
//
// The create/poll steps are mocked (fast, deterministic JSON responses); node-fetch's default
// export is wrapped (not fully replaced) so calls to the real create/poll URLs are intercepted
// while the one download call in each test reaches a real local http.createServer — same
// "mock only what must be mocked, exercise the real transport for the thing under test"
// convention as videoPipeline.downloadToFileStreaming.test.ts and
// curatedMediaSourcing.f310Streaming.test.ts.
//
// AbortSignal.timeout()'s internal timer is implemented outside Node's public, vi.useFakeTimers()
// -patchable setTimeout (confirmed empirically before writing these tests: advancing fake timers
// past an AbortSignal.timeout(...) budget does not trip it) — so the two body-hang tests below use
// real wall-clock waits for the download step specifically, per the download timeouts' actual
// values (20s / 60s). This makes them slow but is the only way to genuinely exercise the real
// cancellation mechanism rather than a stand-in for it.
//
// LEONARDO_API_KEY / RUNWAY_API_KEY are module-level consts captured from process.env at import
// time, so this file must be run with those env vars already set.
vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: vi.fn(actual.default) };
});

import fetchModule from "node-fetch";
import { generateLeonardoAIClip, generateRunwayClip, exec } from "./videoPipeline";
const mockedFetch = vi.mocked(fetchModule);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Awaited<ReturnType<typeof fetchModule>>;
}

describe("Leonardo AI + Runway Gen-4 final download (F3-13 finding 3.2, tests E/F + success paths)", () => {
  let dir: string;
  let outputPath: string;
  let server: http.Server | undefined;
  let baseUrl: string;

  beforeEach(() => {
    // RONDE 30: these were never set anywhere, and the provider credentials used to be
    // captured at import time, so this file could only pass when someone prefixed the
    // vitest command with them by hand. The keys are read at call time now, so setting
    // them here is enough — and a real key in the environment still wins.
    process.env.LEONARDO_API_KEY = process.env.LEONARDO_API_KEY || "test-key";
    process.env.RUNWAY_API_KEY = process.env.RUNWAY_API_KEY || "test-key";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f313-dl-test-"));
    outputPath = path.join(dir, "scene_0.mp4");
    mockedFetch.mockClear(); // keep the real-fetch pass-through implementation, only clear call history
  });

  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  function startServer(handler: http.RequestListener): Promise<void> {
    server = http.createServer(handler);
    return new Promise((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        const { port } = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  /** Routes Leonardo/Runway API calls to fake JSON responses; anything else (the real download
   *  URL, pointing at the local test server) falls through to the real node-fetch implementation
   *  the mock was seeded with. */
  function mockApiCalls(responses: { match: RegExp; response: unknown }[]) {
    mockedFetch.mockImplementation(async (url, opts) => {
      const urlStr = String(url);
      for (const { match, response } of responses) {
        if (match.test(urlStr)) return response as Awaited<ReturnType<typeof fetchModule>>;
      }
      const real = (await vi.importActual<typeof import("node-fetch")>("node-fetch")).default;
      return real(url, opts as never);
    });
  }

  it("Test E — Leonardo: a stalled download body is aborted by the 20s timeout instead of hanging forever, and no partial file is left", async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.write(Buffer.alloc(20_000, "i")); // partial body
      // never call res.end() — the body never completes
    });
    mockApiCalls([
      { match: /leonardo\.ai\/api\/rest\/v1\/generations$/, response: jsonResponse({ sdGenerationJob: { generationId: "gen1" } }) },
      {
        match: /leonardo\.ai\/api\/rest\/v1\/generations\//,
        response: jsonResponse({
          generations_by_pk: { status: "COMPLETE", generated_images: [{ url: `${baseUrl}/img.jpg` }] },
        }),
      },
    ]);

    const expectedPngPath = outputPath.replace(".mp4", "_leonardo.jpg");
    const start = Date.now();
    const result = await generateLeonardoAIClip("a prompt", 5, outputPath, 0);
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(30_000); // aborted at ~20s (+ the one 5s poll wait), not left hanging
    expect(fs.existsSync(expectedPngPath)).toBe(false); // no partial file left behind
  }, 35_000);

  it("Test F — Runway: a stalled download body is aborted by the 60s timeout instead of hanging forever, and no partial video file is left", async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.write(Buffer.alloc(50_000, "v")); // partial body
      // never call res.end() — the body never completes
    });
    mockApiCalls([
      { match: /runwayml\.com\/v1\/image_to_video$/, response: jsonResponse({ id: "task1" }) },
      { match: /runwayml\.com\/v1\/tasks\//, response: jsonResponse({ status: "SUCCEEDED", output: [`${baseUrl}/video.mp4`] }) },
    ]);

    const expectedRunwayPath = outputPath.replace(".mp4", "_runway.mp4");
    const start = Date.now();
    const result = await generateRunwayClip("prompt", null, 5, outputPath, 0);
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(70_000); // aborted at ~60s (+ the one 5s poll wait), not left hanging
    expect(fs.existsSync(expectedRunwayPath)).toBe(false); // no partial file left behind
  }, 75_000);

  it("Leonardo: a normal, complete download still succeeds and produces a valid Ken-Burns clip", async () => {
    // A real, valid, noisy JPEG (ffmpeg needs to actually decode this for the Ken Burns
    // conversion step to succeed, same technique already used by
    // videoPipeline.f308AiProviders.test.ts's Stability AI test) — a flat-color image compresses
    // too well to exercise a real decode, so random noise is used instead.
    const seedPath = path.join(dir, "seed.jpg");
    await exec(`ffmpeg -y -f lavfi -i "nullsrc=s=640x360,geq=random(1)*255:128:128" -update 1 -frames:v 1 "${seedPath}"`);
    const payload = fs.readFileSync(seedPath);
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(payload);
    });
    mockApiCalls([
      { match: /leonardo\.ai\/api\/rest\/v1\/generations$/, response: jsonResponse({ sdGenerationJob: { generationId: "gen1" } }) },
      {
        match: /leonardo\.ai\/api\/rest\/v1\/generations\//,
        response: jsonResponse({
          generations_by_pk: { status: "COMPLETE", generated_images: [{ url: `${baseUrl}/img.jpg` }] },
        }),
      },
    ]);

    const result = await generateLeonardoAIClip("a prompt", 5, outputPath, 0);

    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);
    expect(fs.statSync(result!).size).toBeGreaterThan(1000);
    expect(mockedFetch).toHaveBeenCalledTimes(3); // generate, poll, download
  }, 30_000);

  it("Runway: a normal, complete download still succeeds and produces the expected output file", async () => {
    const payload = Buffer.from("v".repeat(5_000));
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(payload);
    });
    mockApiCalls([
      { match: /runwayml\.com\/v1\/image_to_video$/, response: jsonResponse({ id: "task1" }) },
      { match: /runwayml\.com\/v1\/tasks\//, response: jsonResponse({ status: "SUCCEEDED", output: [`${baseUrl}/video.mp4`] }) },
    ]);

    const result = await generateRunwayClip("prompt", null, 5, outputPath, 0);

    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);
    expect(fs.statSync(result!).size).toBe(payload.length);
    expect(fs.readFileSync(result!).equals(payload)).toBe(true);
  }, 15_000);
});
