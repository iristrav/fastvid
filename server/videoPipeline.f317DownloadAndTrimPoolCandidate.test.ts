import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { pipeline } from "stream/promises";
import fetch from "node-fetch";
import { execSync } from "child_process";
import { downloadAndTrimPoolCandidate } from "./videoPipeline";
import type { PoolCandidate } from "./scenePool";

// F3-17 finding 3.6: downloadAndTrimPoolCandidate used to fetch its "raw" pool-candidate asset
// via withTimeout(fetch(...), 22_000) — a wrapper that only guards until fetch() itself resolves
// (headers arriving), never actually aborting the underlying request — then fully buffered the
// response via Buffer.from(await resp.arrayBuffer()) before writing it to rawPath, with no
// cleanup of rawPath after use. It now passes AbortSignal.timeout(22_000) straight into fetch()
// (same proven F3-13/F3-14 pattern, covering the body-read too) and streams straight to rawPath
// via pipeline(), with rawPath removed via a guaranteed finally once ffprobe/trim/
// stillImageToVideo are done with it.
//
// Test A exercises the exact fetch+AbortSignal.timeout+pipeline mechanism the production code
// now uses, via a local replica with a short test-only timeout instead of the real 22_000ms
// (making that configurable would require changing downloadAndTrimPoolCandidate's signature and
// both of its call sites — out of scope for this minimal fix, and explicitly not required per
// the task instructions when the production timeout isn't easily injectable). This proves the
// mechanism genuinely aborts a stalled body and cleans up the partial file; it does not prove the
// literal 22s value itself. It does NOT prove that a hang inside the real, exported function
// necessarily resolves within 22s — only that the identical fetch+AbortSignal.timeout+pipeline
// shape it now uses does abort and clean up correctly.
const SHORT_TIMEOUT_MS = 500;

async function downloadLikePoolCandidate(url: string, destPath: string, timeoutMs: number): Promise<void> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok || !resp.body) throw new Error(`bad response: ${resp.status}`);
  try {
    await pipeline(resp.body, fs.createWriteStream(destPath));
  } catch (err) {
    if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch { /* ignore */ } }
    throw err;
  }
}

describe("downloadAndTrimPoolCandidate download/cleanup (F3-17 finding 3.6)", () => {
  let dir: string;
  let server: http.Server | undefined;
  let baseUrl: string;

  afterEach(async () => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
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

  it("Test A — a stalled body is aborted by the fetch+AbortSignal.timeout+pipeline mechanism, not left hanging, with no partial file left behind", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f317-hang-test-"));
    const destPath = path.join(dir, "raw.mp4");
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.write(Buffer.alloc(20_000, "a"));
      // never call res.end() — the body never completes
    });

    const start = Date.now();
    await expect(downloadLikePoolCandidate(`${baseUrl}/clip.mp4`, destPath, SHORT_TIMEOUT_MS)).rejects.toThrow();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThan(SHORT_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(SHORT_TIMEOUT_MS + 5_000);
    expect(fs.existsSync(destPath)).toBe(false);
  }, 15_000);

  it("Test B — a normal download streams to disk, downstream trim succeeds, and rawPath is cleaned up afterward", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f317-success-test-"));
    const seedPath = path.join(dir, "seed.mp4");
    // Noisy source (not a flat color) so h264 can't trivially compress it away — needs to
    // comfortably clear downloadAndTrimPoolCandidate's existing 50_000-byte minimum-size check.
    execSync(`ffmpeg -y -f lavfi -i "nullsrc=s=320x240,geq=random(1)*255:128:128" -t 2 -c:v libx264 -pix_fmt yuv420p "${seedPath}"`, { stdio: "pipe" });
    const payload = fs.readFileSync(seedPath);
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(payload);
    });

    const candidate: PoolCandidate = {
      id: "archive:test-clip",
      assetId: "test-clip",
      source: "archive",
      remoteUrl: `${baseUrl}/clip.mp4`,
      thumbnailUrl: null,
      title: "test",
      description: null,
      tags: [],
      mediaType: "video",
      durationSec: 2,
      license: null,
      width: 64,
      height: 64,
      clipSimilarity: null,
      embeddingSimilarity: null,
      rankingScore: null,
      visionScore: null,
      selectionScore: null,
    };
    const sceneIndex = 0;
    const beatIndex = 0;
    const safeId = candidate.assetId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
    const rawPath = path.join(dir, `scene_${sceneIndex}_b${beatIndex}_pool_${candidate.source}_${safeId}_raw.mp4`);

    const result = await downloadAndTrimPoolCandidate(candidate, dir, sceneIndex, beatIndex, 1.5);

    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);
    expect(fs.statSync(result!).size).toBeGreaterThan(1_000);
    expect(fs.existsSync(rawPath)).toBe(false);
  }, 30_000);
});
