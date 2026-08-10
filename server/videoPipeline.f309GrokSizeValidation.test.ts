import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { generateGrokVideoClip } from "./videoPipeline";

// F3-09 finding 3.1: generateGrokVideoClip downloaded the final video with
// response.buffer() (node-fetch's full in-memory buffer) and returned its output path
// unconditionally, unlike generateLeonardoAIClip and the F3-08-fixed
// generateRunwayClip/generateLumaClip/generatePikaClip/generateManusForgeClip. It now
// validates the written file's size before returning the path, matching that exact
// existing pattern. The Grok download itself already uses AbortSignal.timeout(120_000)
// (covers headers AND body, unlike the codebase's fetchWithTimeout helper) — untouched here.
//
// Transport is mocked at the node-fetch layer (same technique as F3-08's Runway tests):
// generateGrokVideoClip -> generateGrokVideo (server/_core/grokVideo.ts) -> shared
// server/_core/fetchWithTimeout.ts for create/poll, and videoPipeline.ts's own fetch for the
// final download — both ultimately resolve to the same "node-fetch" module, so one mock
// covers the whole flow. REPLICATE_API_KEY is a module-level const in both videoPipeline.ts
// and grokVideo.ts, so it must be set before either module is imported (see the run command
// in the F3-09 implementation report).
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
    buffer: async () => buf,
  } as unknown as Awaited<ReturnType<typeof fetchModule>>;
}

describe("generateGrokVideoClip size validation (F3-09 finding 3.1)", () => {
  let dir: string;
  let outputPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f309-test-"));
    outputPath = path.join(dir, "scene_0.mp4");
    mockedFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the output path for a valid (>1000 byte) download", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ id: "pred1" })); // create
    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ status: "succeeded", output: "http://fake/video.mp4" })
    ); // poll — succeeds on first check, no wait needed
    mockedFetch.mockResolvedValueOnce(bufferResponse(Buffer.alloc(5000, "v"))); // download

    const result = await generateGrokVideoClip("a prompt", 5, outputPath, 0);

    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);
    expect(fs.statSync(result!).size).toBe(5000);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });

  it("returns null for a too-small (<1000 byte) download instead of the path", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ id: "pred1" }));
    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ status: "succeeded", output: "http://fake/video.mp4" })
    );
    mockedFetch.mockResolvedValueOnce(bufferResponse(Buffer.alloc(200, "v")));

    const result = await generateGrokVideoClip("a prompt", 5, outputPath, 0);

    expect(result).toBeNull();
  });
});
