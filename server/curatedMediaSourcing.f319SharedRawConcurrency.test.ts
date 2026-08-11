import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { execSync } from "child_process";
import { prepareCuratedArchiveClip, type ArchiveAssetRow, type CuratedClipStyleContext } from "./curatedMediaSourcing";

// F3-19: prepareCuratedArchiveClip's rawPath (archive_raw_a{asset.id}.{ext}) is deterministic —
// workDir + asset.id only — so that concurrently-processed scenes/beats that independently pick
// the same popular archive asset can share one download instead of each fetching their own copy.
// The previous sharing guard, `isSharedRaw = rawCache.get(id) === rawPath`, was a one-time
// snapshot with no synchronization: two concurrent callers could each observe "not yet shared",
// each independently call materializeArchiveAsset() against the identical rawPath, and whichever
// one's download failed (or simply finished and considered itself the sole owner) would unlink
// rawPath out from under the other consumer while it was still mid-read in ffmpeg — surfacing in
// production as "archive_raw_a{id}.{ext}: No such file or directory" (confirmed via Railway logs,
// including two ENOENTs on the identical path 565 microseconds apart — proof of genuinely
// concurrent trims racing on one file, not a sequential retry).
//
// The fix replaces that snapshot with acquireSharedRawMaterialization()/
// releaseSharedRawMaterialization() (module-level in curatedMediaSourcing.ts): a synchronous
// Map check-then-set (no `await` in between, so it can't be interleaved) guarantees only one
// materialization attempt is ever in flight per rawPath, and a refcount — not a boolean — governs
// cleanup, so the shared file is only ever deleted once every concurrent consumer has released it.
//
// These tests exercise the real, exported prepareCuratedArchiveClip() end-to-end (real ffmpeg
// encode/probe, no mocks of the sharing mechanism itself), against a real local HTTP server whose
// response is deliberately delayed — the delay sits purely on the external download boundary,
// widening the window in which two genuinely concurrent Promise.all()'d calls both have an
// in-flight consumer, exactly like two overlapping scenes/beats in production. This mirrors the
// existing F3-17 test's convention (videoPipeline.f317DownloadAndTrimPoolCandidate.test.ts):
// execSync ffmpeg -f lavfi to build a real, noisy fixture clip, then a real http.createServer.
describe("prepareCuratedArchiveClip shared rawPath concurrency (F3-19)", () => {
  let dir: string;
  let server: http.Server | undefined;
  let baseUrl: string;
  let requestCount: number;

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

  function makeVideoAsset(id: number, storageUrl: string): ArchiveAssetRow {
    return {
      id,
      mediaType: "video",
      mimeType: "video/mp4",
      storageUrl,
      storageKey: null,
      // Skips the LLM-backed baked-edit-text check (archiveClipHasBakedEditText) — irrelevant to
      // the F3-19 concurrency mechanism under test and not available in this sandbox.
      hasBakedEditText: 0,
      tags: [],
    } as unknown as ArchiveAssetRow;
  }

  it("Test A — two concurrent consumers of the same asset share exactly one materialization, neither sees ENOENT, and the shared file is cleaned up only once both are done", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f319-test-"));
    const seedPath = path.join(dir, "seed.mp4");
    // Noisy source (not a flat color) and comfortably above VIDRUSH_MIN_SOURCE_VIDEO_SEC (2.8s)
    // and archiveVisualMinClipSec (5s), so the real trim step below has real margin to work with.
    execSync(
      `ffmpeg -y -f lavfi -i "nullsrc=s=320x240,geq=random(1)*255:128:128" -t 6 -c:v libx264 -pix_fmt yuv420p "${seedPath}"`,
      { stdio: "pipe" }
    );
    const payload = fs.readFileSync(seedPath);

    requestCount = 0;
    await startServer((_req, res) => {
      requestCount++;
      // Delay sits only on the external download boundary — widens the window during which both
      // concurrent prepareCuratedArchiveClip() calls are genuinely in flight together.
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end(payload);
      }, 300);
    });

    const asset = makeVideoAsset(26907, `${baseUrl}/clip.mp4`);
    const sharedContext: CuratedClipStyleContext = { rawCache: new Map(), fastTrim: true };
    const rawPath = path.join(dir, `archive_raw_a${asset.id}.mp4`);

    const midFlightExists: boolean[] = [];
    const midFlightCheck = new Promise<void>((resolve) => {
      // Fires after the (single, shared) download has resolved (~300ms) but comfortably before
      // either real ffmpeg trim has finished — the shared raw file must still exist here for both
      // in-flight consumers.
      setTimeout(() => {
        midFlightExists.push(fs.existsSync(rawPath));
        resolve();
      }, 350);
    });

    const [resultA, resultB] = await Promise.all([
      prepareCuratedArchiveClip(asset, dir, 11, 0, 5, sharedContext),
      prepareCuratedArchiveClip(asset, dir, 14, 0, 5, sharedContext),
      midFlightCheck,
    ]);

    // Assertion 1 — max one materialization: exactly one real HTTP request for two concurrent
    // consumers of the same asset (proves the Promise-sharing, not two independent downloads).
    expect(requestCount).toBe(1);

    // Assertion 3 — the shared file stayed usable for the duration of both active consumers.
    expect(midFlightExists).toEqual([true]);

    // Assertion 2 — no ENOENT from concurrent cleanup: both consumers resolved with a real,
    // valid, distinct (scene/beat-scoped) output clip instead of one of them throwing.
    expect(fs.existsSync(resultA)).toBe(true);
    expect(fs.statSync(resultA).size).toBeGreaterThan(1_000);
    expect(fs.existsSync(resultB)).toBe(true);
    expect(fs.statSync(resultB).size).toBeGreaterThan(1_000);
    expect(resultA).not.toBe(resultB);

    // Assertion 4 — cleanup eventually happens: once every consumer is done, the shared raw file
    // is removed — no orphan temp file left behind.
    expect(fs.existsSync(rawPath)).toBe(false);
  }, 30_000);

  it("Test B — a shared materialization failure rejects every concurrent consumer with the same error, starts only one download attempt, and leaves no orphan raw file", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f319-fail-test-"));

    requestCount = 0;
    await startServer((_req, res) => {
      requestCount++;
      setTimeout(() => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("server error");
      }, 150);
    });

    const asset = makeVideoAsset(53245, `${baseUrl}/clip.mp4`);
    const sharedContext: CuratedClipStyleContext = { rawCache: new Map(), fastTrim: true };
    const rawPath = path.join(dir, `archive_raw_a${asset.id}.mp4`);

    const [resultA, resultB] = await Promise.allSettled([
      prepareCuratedArchiveClip(asset, dir, 10, 4, 5, sharedContext),
      prepareCuratedArchiveClip(asset, dir, 14, 4, 5, sharedContext),
    ]);

    // Assertion 5 — materialization failure: shared Promise rejects, both waiting consumers get
    // the exact same failure, only one download attempt is made, and no orphan file remains.
    expect(requestCount).toBe(1);
    expect(resultA.status).toBe("rejected");
    expect(resultB.status).toBe("rejected");
    if (resultA.status === "rejected" && resultB.status === "rejected") {
      expect(resultA.reason).toBe(resultB.reason);
      expect((resultA.reason as Error).message).toMatch(/Archive asset download HTTP 500/);
    }
    expect(fs.existsSync(rawPath)).toBe(false);
  }, 30_000);

  it("Test C — after a failed materialization, a later attempt for the same asset.id is not permanently stuck on the rejected promise and can materialize fresh and succeed", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f319-retry-test-"));
    const seedPath = path.join(dir, "seed.mp4");
    execSync(
      `ffmpeg -y -f lavfi -i "nullsrc=s=320x240,geq=random(1)*255:128:128" -t 6 -c:v libx264 -pix_fmt yuv420p "${seedPath}"`,
      { stdio: "pipe" }
    );
    const payload = fs.readFileSync(seedPath);

    requestCount = 0;
    await startServer((_req, res) => {
      requestCount++;
      if (requestCount === 1) {
        // First materialization attempt fails outright.
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("server error");
        return;
      }
      // Every later attempt succeeds with the real fixture clip.
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(payload);
    });

    const asset = makeVideoAsset(26907, `${baseUrl}/clip.mp4`);
    const sharedContext: CuratedClipStyleContext = { rawCache: new Map(), fastTrim: true };
    const rawPath = path.join(dir, `archive_raw_a${asset.id}.mp4`);

    // Attempt 1: materialization fails, and the in-flight entry for this rawPath must not survive
    // the failure (Invariant C) — if it did, attempt 2 below would stay stuck awaiting the same
    // rejected promise forever instead of starting a fresh materialization.
    await expect(prepareCuratedArchiveClip(asset, dir, 10, 4, 5, sharedContext)).rejects.toThrow(
      /Archive asset download HTTP 500/
    );
    expect(fs.existsSync(rawPath)).toBe(false);

    // Attempt 2: a completely separate, later call for the identical asset.id + workDir must be
    // able to materialize fresh and succeed — proving the failed attempt's state was cleared, not
    // permanently latched.
    const result = await prepareCuratedArchiveClip(asset, dir, 12, 1, 5, sharedContext);

    expect(requestCount).toBe(2);
    expect(fs.existsSync(result)).toBe(true);
    expect(fs.statSync(result).size).toBeGreaterThan(1_000);
    expect(fs.existsSync(rawPath)).toBe(false);
  }, 30_000);
});
