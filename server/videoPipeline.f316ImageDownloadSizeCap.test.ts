import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { downloadToFileStreaming } from "./videoPipeline";

// F3-16 finding 3.5: fetchWikimediaImages/fetchWikimediaImagesV1/fetchSerpAPIImages used to
// buffer their entire "original" image download in memory via Buffer.from(await
// resp.arrayBuffer()) before any size check happened, with no upper bound. All three now call
// the shared downloadToFileStreaming() helper (F3-05) with an explicit maxBytes cap
// (MAX_IMAGE_DOWNLOAD_BYTES = 25MB) instead of buffering + writeFileSync. These tests exercise
// downloadToFileStreaming's new, optional maxBytes parameter directly against a real local
// http.createServer — the exact mechanism all three F3-16 call sites now share — using a small
// cap so the tests stay fast; the mechanism itself is independent of the specific 25MB
// production value.
describe("downloadToFileStreaming maxBytes cap (F3-16 finding 3.5)", () => {
  let dir: string;
  let destPath: string;
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

  it("Test A — a normal download under the cap succeeds: file exists with correct content", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f316-test-"));
    destPath = path.join(dir, "image.jpg");
    const payload = Buffer.from("x".repeat(500));
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(payload.length) });
      res.end(payload);
    });

    const { response, bytesWritten } = await downloadToFileStreaming(
      `${baseUrl}/image.jpg`, destPath, 5_000, "F3-16 test A", {}, 1_000
    );

    expect(response.ok).toBe(true);
    expect(bytesWritten).toBe(payload.length);
    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.readFileSync(destPath).equals(payload)).toBe(true);
  });

  it("Test B — an oversized Content-Length is rejected before any body is downloaded: no partial file", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f316-test-"));
    destPath = path.join(dir, "image.jpg");
    const bigPayload = Buffer.alloc(5_000, "y");
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(bigPayload.length) });
      res.end(bigPayload);
    });

    await expect(
      downloadToFileStreaming(`${baseUrl}/image.jpg`, destPath, 5_000, "F3-16 test B", {}, 1_000)
    ).rejects.toThrow(/exceeds maximum size/);

    expect(fs.existsSync(destPath)).toBe(false);
  });

  it("Test C — a chunked response with no Content-Length that exceeds the cap while streaming is aborted: no partial file", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f316-test-"));
    destPath = path.join(dir, "image.jpg");
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/jpeg" }); // no Content-Length -> chunked
      res.write(Buffer.alloc(600, "a"));
      setTimeout(() => {
        res.write(Buffer.alloc(600, "b")); // pushes cumulative total over the 1000-byte cap
        res.end();
      }, 100);
    });

    await expect(
      downloadToFileStreaming(`${baseUrl}/image.jpg`, destPath, 5_000, "F3-16 test C", {}, 1_000)
    ).rejects.toThrow(/exceeded maximum size/);

    expect(fs.existsSync(destPath)).toBe(false);
  });

  it("Test D — an existing non-OK response is still handled correctly (unaffected by the cap)", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f316-test-"));
    destPath = path.join(dir, "image.jpg");
    await startServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });

    const { response, bytesWritten } = await downloadToFileStreaming(
      `${baseUrl}/missing.jpg`, destPath, 5_000, "F3-16 test D", {}, 1_000
    );

    expect(response.ok).toBe(false);
    expect(bytesWritten).toBeNull();
    expect(fs.existsSync(destPath)).toBe(false);
  });
});
