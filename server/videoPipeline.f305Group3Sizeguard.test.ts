import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { downloadToFileStreaming } from "./videoPipeline";

// F3-05 group 3: fetchFlickrCCVideos, fetchSepiaSearchVideos, and fetchVimeoCCVideos were
// converted from Buffer.from(await resp.arrayBuffer()) to downloadToFileStreaming, using the
// exact same [50KB, 80MB] min/max size-then-cleanup pattern as F3-05 group 2 (Wikimedia/
// Europeana). downloadToFileStreaming's own success/HTTP-error/timeout/partial-file behavior is
// already covered by videoPipeline.downloadToFileStreaming.test.ts; these tests confirm the
// shared streaming path a real download response goes through still produces byte-correct
// output and a clean reject-then-cleanup story at these three call sites' exact thresholds.
describe("F3-05 group 3 streaming + size-guard (Flickr/SepiaSearch/Vimeo)", () => {
  let dir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f305g3-test-"));
  });

  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function startServer(payload: Buffer): Promise<void> {
    server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end(payload);
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  const MIN = 50_000;
  const MAX = 80 * 1024 * 1024;

  it("streams a clip within [50KB, 80MB] to tmpPath with byte-correct content (Flickr-shaped)", async () => {
    const payload = Buffer.from("f".repeat(120_000));
    await startServer(payload);
    const tmpPath = path.join(dir, "scene_0_flickr_0_tmp");

    const { response, bytesWritten } = await downloadToFileStreaming(
      `${baseUrl}/clip`, tmpPath, 5_000, "Flickr video download scene 0"
    );

    expect(response.ok).toBe(true);
    expect(bytesWritten).toBe(payload.length);
    const rejected = bytesWritten! < MIN || bytesWritten! > MAX;
    expect(rejected).toBe(false);
    expect(fs.readFileSync(tmpPath).equals(payload)).toBe(true);
  });

  it("rejects and lets the caller clean up a too-small download (SepiaSearch-shaped)", async () => {
    await startServer(Buffer.alloc(500, "s")); // well below the 50KB floor
    const tmpPath = path.join(dir, "scene_0_septube_0_tmp");

    const { bytesWritten } = await downloadToFileStreaming(
      `${baseUrl}/clip`, tmpPath, 5_000, "SepiaSearch download scene 0"
    );

    expect(bytesWritten).toBe(500);
    const rejected = bytesWritten! < MIN || bytesWritten! > MAX;
    expect(rejected).toBe(true);
    // Streaming always writes first — this is exactly why fetchSepiaSearchVideos now unlinks
    // tmpPath explicitly on this branch (the old buffered path never wrote a file here at all).
    expect(fs.existsSync(tmpPath)).toBe(true);
    fs.unlinkSync(tmpPath);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("handles an HTTP error response without writing a file (Vimeo-shaped)", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
    const tmpPath = path.join(dir, "scene_0_vimeo_0_tmp");

    const { response, bytesWritten } = await downloadToFileStreaming(
      `${baseUrl}/clip`, tmpPath, 5_000, "Vimeo download scene 0"
    );

    expect(response.ok).toBe(false);
    expect(bytesWritten).toBeNull();
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("cleans up a partial file when the stream errors mid-download (shared by all three call sites)", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Length": "5000000" });
      res.write(Buffer.alloc(60_000, "v"));
      setTimeout(() => res.destroy(), 20);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
    const tmpPath = path.join(dir, "scene_0_vimeo_1_tmp");

    await expect(
      downloadToFileStreaming(`${baseUrl}/clip`, tmpPath, 5_000, "Vimeo download scene 0")
    ).rejects.toThrow();
    expect(fs.existsSync(tmpPath)).toBe(false);
  });
});
