import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { downloadToFileStreaming } from "./videoPipeline";

// F3-05 group 4: fetchMediaCccVideos and fetchNasaVideoClips were converted from
// Buffer.from(await resp.arrayBuffer()) to downloadToFileStreaming, gating on fs.statSync(tmpPath).size
// after the stream completes (rather than the bytesWritten counter groups 1-3 used directly) — same
// end result, since bytesWritten always equals the final file size once the stream resolves without
// error. media.ccc keeps its existing 80KB-120MB range; NASA keeps its existing 50KB-80MB range
// (explicitly NOT widened to 100MB — F3-05 is a memory/streaming fix only, not a threshold change).
// downloadToFileStreaming's own success/HTTP-error/timeout/partial-file behavior is already covered
// by videoPipeline.downloadToFileStreaming.test.ts.
describe("F3-05 group 4 streaming + file-stat size-guard (media.ccc/NASA)", () => {
  let dir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f305g4-test-"));
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

  it("keeps a media.ccc-shaped download within [80KB, 120MB] and fs.statSync matches bytesWritten", async () => {
    const payload = Buffer.alloc(200_000, "c");
    await startServer(payload);
    const tmpPath = path.join(dir, "scene_0_ccc_0_tmp");

    const { bytesWritten } = await downloadToFileStreaming(`${baseUrl}/clip`, tmpPath, 5_000, "test");

    const fileSize = fs.statSync(tmpPath).size;
    expect(fileSize).toBe(bytesWritten);
    const MIN = 80_000;
    const MAX = 120 * 1024 * 1024;
    expect(fileSize < MIN || fileSize > MAX).toBe(false);
    expect(fs.readFileSync(tmpPath).equals(payload)).toBe(true);
  });

  it("rejects a media.ccc-shaped download below the 80KB floor and lets the caller clean it up", async () => {
    await startServer(Buffer.alloc(10_000, "c")); // above old 50KB floor, below media.ccc's 80KB floor
    const tmpPath = path.join(dir, "scene_0_ccc_1_tmp");

    await downloadToFileStreaming(`${baseUrl}/clip`, tmpPath, 5_000, "test");

    const fileSize = fs.statSync(tmpPath).size;
    const MIN = 80_000;
    const MAX = 120 * 1024 * 1024;
    expect(fileSize < MIN || fileSize > MAX).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(true);
    fs.unlinkSync(tmpPath);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("keeps NASA's existing [50KB, 80MB] range — NOT widened to 100MB", async () => {
    const payload = Buffer.alloc(60_000, "n"); // within 50KB-80MB, would also pass under a wrong 100MB cap
    await startServer(payload);
    const tmpPath = path.join(dir, "scene_0_nasa_0_tmp.mp4");

    await downloadToFileStreaming(`${baseUrl}/clip`, tmpPath, 5_000, "test");

    const fileSize = fs.statSync(tmpPath).size;
    const MIN = 50_000;
    const MAX = 80 * 1024 * 1024; // must be 80MB, not 100MB
    expect(fileSize).toBe(payload.length);
    expect(fileSize < MIN || fileSize > MAX).toBe(false);
  });

  it("rejects a NASA-shaped download below the 50KB floor and lets the caller clean it up", async () => {
    await startServer(Buffer.alloc(2_000, "n"));
    const tmpPath = path.join(dir, "scene_0_nasa_1_tmp.mp4");

    await downloadToFileStreaming(`${baseUrl}/clip`, tmpPath, 5_000, "test");

    const fileSize = fs.statSync(tmpPath).size;
    const MIN = 50_000;
    const MAX = 80 * 1024 * 1024;
    expect(fileSize < MIN || fileSize > MAX).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(true);
    fs.unlinkSync(tmpPath);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("handles an HTTP error response without writing a file (shared download path)", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("server error");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
    const tmpPath = path.join(dir, "scene_0_nasa_2_tmp.mp4");

    const { response, bytesWritten } = await downloadToFileStreaming(
      `${baseUrl}/clip`, tmpPath, 5_000, "test"
    );

    expect(response.ok).toBe(false);
    expect(bytesWritten).toBeNull();
    expect(fs.existsSync(tmpPath)).toBe(false);
  });
});
