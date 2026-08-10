import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { materializeArchiveAsset, type ArchiveAssetRow } from "./curatedMediaSourcing";
import { LOCAL_UPLOADS_DIR } from "./storageLocal";

// F3-10 finding 3.1: materializeArchiveAsset (the highest-frequency download in the render
// pipeline — archive clips are the preferred visual source) used to buffer the entire response
// in memory (Buffer.from(await resp.arrayBuffer())) for both its download paths (direct HTTP,
// and R2/S3 via a signed URL) before writing it to disk. It now streams the response body
// straight to destPath via stream/promises' pipeline(), matching F3-05's downloadToFileStreaming
// pattern in videoPipeline.ts (replicated locally here, not imported, since curatedMediaSourcing.ts
// is imported BY videoPipeline.ts and importing the other way would risk a circular dependency).
//
// AbortSignal.timeout(120_000 / 60_000) is untouched — it already covers the body-read, not just
// headers, so nothing about timeout behavior changes here. archiveDownloadLimit/
// archiveDownloadConcurrency() (the pLimit concurrency gate) are untouched. The 500-byte size
// floor is preserved, now checked via fs.statSync(destPath).size after the stream completes
// instead of a buffer's .length. The R2/S3 path now streams once to destPath, then
// fs.copyFileSync's it to the persistent local cache (cachePath) instead of writing the same
// in-memory buffer to both files.
//
// storageGetSignedUrl (server/storage.ts) is mocked to point at a local test HTTP server instead
// of real R2/S3 — no real credentials exist in this sandbox. All other transport runs unmocked
// against a real http.createServer, same convention as F3-05's downloadToFileStreaming tests.
vi.mock("./storage", () => ({ storageGetSignedUrl: vi.fn() }));
import { storageGetSignedUrl } from "./storage";
const mockedGetSignedUrl = vi.mocked(storageGetSignedUrl);

function makeAsset(overrides: Partial<ArchiveAssetRow>): ArchiveAssetRow {
  return {
    storageUrl: "",
    storageKey: null,
    ...overrides,
  } as unknown as ArchiveAssetRow;
}

describe("materializeArchiveAsset streaming (F3-10 finding 3.1)", () => {
  let dir: string;
  let destPath: string;
  let server: http.Server | undefined;
  let baseUrl: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f310-test-"));
    destPath = path.join(dir, "archive_clip.mp4");
    mockedGetSignedUrl.mockReset();
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

  function s3CachePath(key: string): string {
    return path.join(LOCAL_UPLOADS_DIR, "archive-s3-cache", key.replace(/\//g, "_"));
  }

  it("Test 1 — direct HTTP download succeeds and writes the real content to destPath", async () => {
    const payload = Buffer.from("v".repeat(50_000));
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(payload);
    });
    const asset = makeAsset({ storageUrl: `${baseUrl}/clip.mp4` });

    await materializeArchiveAsset(asset, destPath);

    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.readFileSync(destPath).equals(payload)).toBe(true);
  });

  it("Test 2 — R2/S3-backed path succeeds: destPath and cachePath both exist with identical content", async () => {
    const payload = Buffer.from("s".repeat(80_000));
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(payload);
    });
    const key = `f310-test-${Date.now()}-${Math.random().toString(36).slice(2)}/asset.mp4`;
    const cachePath = s3CachePath(key);
    fs.rmSync(cachePath, { force: true });
    mockedGetSignedUrl.mockResolvedValueOnce(`${baseUrl}/signed`);
    const asset = makeAsset({ storageUrl: "/manus-storage/asset.mp4", storageKey: key });

    try {
      await materializeArchiveAsset(asset, destPath);

      expect(mockedGetSignedUrl).toHaveBeenCalledWith(key);
      expect(fs.existsSync(destPath)).toBe(true);
      expect(fs.existsSync(cachePath)).toBe(true);
      expect(fs.readFileSync(destPath).equals(payload)).toBe(true);
      expect(fs.readFileSync(cachePath).equals(fs.readFileSync(destPath))).toBe(true);
    } finally {
      fs.rmSync(cachePath, { force: true });
    }
  });

  it("Test 3 — HTTP error response: materializeArchiveAsset rejects and leaves no output file", async () => {
    await startServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("server error");
    });
    const asset = makeAsset({ storageUrl: `${baseUrl}/clip.mp4` });

    await expect(materializeArchiveAsset(asset, destPath)).rejects.toThrow(/Archive asset download HTTP 500/);
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it("Test 4 — too-small download: rejects with the original message and removes the undersized file", async () => {
    await startServer((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(200, "v")); // under the 500-byte floor
    });
    const asset = makeAsset({ storageUrl: `${baseUrl}/clip.mp4` });

    await expect(materializeArchiveAsset(asset, destPath)).rejects.toThrow(/Archive asset download too small/);
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it("Test 5 — midstream failure: partial destPath is removed (direct HTTP), and no partial cachePath is left (R2/S3)", async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Length": "1000000" }); // promise more than is actually sent
      res.write(Buffer.alloc(50_000, "b"));
      setTimeout(() => res.destroy(), 20); // break the connection mid-stream
    });

    const directAsset = makeAsset({ storageUrl: `${baseUrl}/clip.mp4` });
    await expect(materializeArchiveAsset(directAsset, destPath)).rejects.toThrow();
    expect(fs.existsSync(destPath)).toBe(false);

    const key = `f310-midstream-${Date.now()}-${Math.random().toString(36).slice(2)}/asset.mp4`;
    const cachePath = s3CachePath(key);
    fs.rmSync(cachePath, { force: true });
    mockedGetSignedUrl.mockResolvedValueOnce(`${baseUrl}/signed`);
    const s3Asset = makeAsset({ storageUrl: "/manus-storage/asset.mp4", storageKey: key });

    try {
      await expect(materializeArchiveAsset(s3Asset, destPath)).rejects.toThrow();
      expect(fs.existsSync(destPath)).toBe(false);
      expect(fs.existsSync(cachePath)).toBe(false);
    } finally {
      fs.rmSync(cachePath, { force: true });
    }
  });

  it("Test 6 — streams the body instead of buffering it fully via response.arrayBuffer()", async () => {
    // A large payload sent in many small chunks — if the implementation ever regressed to
    // Buffer.from(await resp.arrayBuffer()), this would still pass functionally (just less
    // memory-efficient), so functional correctness alone can't distinguish the two. The real
    // proof is structural: node-fetch's Response.arrayBuffer() is spied on its prototype (a
    // plain, mutable method — unlike the module's default-export binding) and asserted to never
    // be called, while the download still completes with fully correct, byte-for-byte content.
    const { Response } = await import("node-fetch");
    const arrayBufferSpy = vi.spyOn(Response.prototype, "arrayBuffer");

    const size = 3_000_000;
    await startServer((_req, res) => {
      res.writeHead(200);
      const chunk = Buffer.alloc(16_384, "a");
      let sent = 0;
      const writeNext = () => {
        if (sent >= size) return res.end();
        const remaining = size - sent;
        const piece = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
        sent += piece.length;
        res.write(piece, writeNext);
      };
      writeNext();
    });
    const asset = makeAsset({ storageUrl: `${baseUrl}/large.mp4` });

    try {
      await materializeArchiveAsset(asset, destPath);

      expect(arrayBufferSpy).not.toHaveBeenCalled();
      expect(fs.statSync(destPath).size).toBe(size);
      const expected = Buffer.alloc(size, "a");
      expect(fs.readFileSync(destPath).equals(expected)).toBe(true);
    } finally {
      arrayBufferSpy.mockRestore();
    }
  });
});
