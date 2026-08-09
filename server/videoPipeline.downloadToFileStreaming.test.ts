import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { downloadToFileStreaming } from "./videoPipeline";

// F3-05: fetchPexelsClips / fetchBrollClips / fetchPixabayClips used to buffer an entire download
// in memory (Buffer.from(await resp.arrayBuffer())) before writing it to disk. With many
// concurrent beat downloads on a long render, that multiplies peak memory for no reason since
// the destination is always a file. downloadToFileStreaming streams the response body straight
// to disk instead. These tests run against a real local HTTP server (not a mocked fetch) so the
// actual streaming path — not a stand-in — is what's being exercised.
describe("downloadToFileStreaming (F3-05)", () => {
  let dir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-streaming-dl-test-"));
  });

  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function startServer(handler: http.RequestListener): Promise<void> {
    server = http.createServer(handler);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  it("writes the correct data to disk on a successful download", async () => {
    const payload = Buffer.from("x".repeat(500_000));
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(payload);
    });

    const destPath = path.join(dir, "clip.mp4");
    const { response, bytesWritten } = await downloadToFileStreaming(
      `${baseUrl}/clip.mp4`,
      destPath,
      5_000,
      "test download"
    );

    expect(response.ok).toBe(true);
    expect(bytesWritten).toBe(payload.length);
    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.readFileSync(destPath).equals(payload)).toBe(true);
  });

  it("reports bytesWritten without ever materializing the full body as a Buffer", async () => {
    // A large-ish payload — the point isn't the exact size, it's that correctness holds when
    // streamed in chunks rather than read via arrayBuffer()/Buffer.from() in one shot.
    const size = 3_000_000;
    await startServer((_req, res) => {
      res.writeHead(200);
      // Write in many small chunks to force real streaming instead of one flush.
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

    const destPath = path.join(dir, "large.mp4");
    const { bytesWritten } = await downloadToFileStreaming(`${baseUrl}/large.mp4`, destPath, 5_000, "large dl");

    expect(bytesWritten).toBe(size);
    expect(fs.statSync(destPath).size).toBe(size);
  });

  it("handles an HTTP error response without writing a file", async () => {
    await startServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });

    const destPath = path.join(dir, "missing.mp4");
    const { response, bytesWritten } = await downloadToFileStreaming(
      `${baseUrl}/missing.mp4`,
      destPath,
      5_000,
      "404 test"
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
    expect(bytesWritten).toBeNull();
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it("still enforces the timeout for a hanging connection", async () => {
    await startServer((_req, res) => {
      // Never respond — keeps the connection open past the timeout.
      void res;
    });

    const destPath = path.join(dir, "hang.mp4");
    await expect(
      downloadToFileStreaming(`${baseUrl}/hang.mp4`, destPath, 200, "timeout test")
    ).rejects.toThrow(/Timeout/);
    expect(fs.existsSync(destPath)).toBe(false);
  }, 10_000);

  it("cleans up the partial file when the response stream errors mid-download", async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Length": "1000000" }); // promise more than we send
      res.write(Buffer.alloc(50_000, "b"));
      // Destroy the underlying socket mid-stream instead of ending cleanly.
      setTimeout(() => res.destroy(), 20);
    });

    const destPath = path.join(dir, "partial.mp4");
    await expect(
      downloadToFileStreaming(`${baseUrl}/partial.mp4`, destPath, 5_000, "partial test")
    ).rejects.toThrow();
    expect(fs.existsSync(destPath)).toBe(false);
  });
});
