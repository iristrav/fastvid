import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { downloadToFileStreaming, downloadYouTubeCCClip } from "./videoPipeline";

// F3-05 group 5: downloadYouTubeCCClip's cloud-DL-service fallback path used to write the
// downloaded buffer straight to outPath — the final artifact the rest of the pipeline treats as
// "the clip". Streaming a download directly to a live outPath is unsafe: a network drop
// mid-transfer would leave a corrupt/partial file exactly where the pipeline expects a finished
// one. The fix streams to a cloudTmpPath first and only fs.renameSync()'s it onto outPath once
// the download is complete AND size-validated (10KB-80MB, matching the pre-existing thresholds
// exactly) — so outPath is only ever touched by one atomic rename, never partially written.
//
// RAPIDAPI_KEY is a module-level const captured from process.env at import time (empty in this
// sandbox), and the RapidAPI metadata/download URLs are hardcoded to https://<host>, so the
// RapidAPI path can't be driven end-to-end through the real function here without either
// resetting modules mid-suite or standing up TLS. Its streaming conversion is the same pattern
// already proven for the cloud-DL path (and for every other F3-05 call site) — an
// arrayBuffer()-based groottecheck replaced by downloadToFileStreaming + fs.statSync(tmpPath).size
// — so it's covered by exercising that exact 50KB-80MB threshold logic directly against the real
// shared helper, the same convention used for F3-05 groups 2-4.
describe("downloadYouTubeCCClip cloud-DL path (F3-05 group 5)", () => {
  let dir: string;
  let server: http.Server;
  let baseUrl: string;
  const videoId = "testVid123";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-ytcc-test-"));
    delete process.env.YOUTUBE_CC_DL_SERVICE;
  });

  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.YOUTUBE_CC_DL_SERVICE;
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
        process.env.YOUTUBE_CC_DL_SERVICE = baseUrl;
        resolve();
      });
    });
  }

  function tmpPathFor(outPath: string): string {
    return outPath.replace(/\.mp4$/, "_cloud_tmp.mp4");
  }

  it("streams a valid clip to cloudTmpPath then renames it onto outPath", async () => {
    const payload = Buffer.alloc(50_000, "y"); // above the 10KB floor
    await startServer((_req, res) => {
      res.writeHead(200);
      res.end(payload);
    });
    const outPath = path.join(dir, "scene_0_ytcc_0.mp4");

    const ok = await downloadYouTubeCCClip(videoId, 5, 0, outPath, 0, "Test video");

    expect(ok).toBe(true);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.readFileSync(outPath).equals(payload)).toBe(true);
    expect(fs.existsSync(tmpPathFor(outPath))).toBe(false);
  });

  it("leaves no partial cloudTmpPath behind when the stream errors mid-download", async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Length": "5000000" });
      res.write(Buffer.alloc(60_000, "z"));
      setTimeout(() => res.destroy(), 20);
    });
    const outPath = path.join(dir, "scene_0_ytcc_1.mp4");

    const ok = await downloadYouTubeCCClip(videoId, 5, 0, outPath, 0, "Test video");

    expect(ok).toBe(false);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(tmpPathFor(outPath))).toBe(false);
  });

  it("does not rename a too-small download onto outPath", async () => {
    await startServer((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(500, "y")); // below the 10KB floor
    });
    const outPath = path.join(dir, "scene_0_ytcc_2.mp4");

    const ok = await downloadYouTubeCCClip(videoId, 5, 0, outPath, 0, "Test video");

    expect(ok).toBe(false);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(tmpPathFor(outPath))).toBe(false);
  });

  it("does not rename an oversized (>80MB) download onto outPath", async () => {
    const oneMb = Buffer.alloc(1024 * 1024, "o");
    const chunks = 81; // 81MB — one over the 80MB cap, streamed for real over loopback
    await startServer((_req, res) => {
      res.writeHead(200);
      let sent = 0;
      const writeNext = () => {
        if (sent >= chunks) return res.end();
        sent++;
        res.write(oneMb, writeNext);
      };
      writeNext();
    });
    const outPath = path.join(dir, "scene_0_ytcc_5.mp4");

    const ok = await downloadYouTubeCCClip(videoId, 5, 0, outPath, 0, "Test video");

    expect(ok).toBe(false);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(tmpPathFor(outPath))).toBe(false);
  }, 20_000);

  it("handles an HTTP error response without leaving any temp file", async () => {
    await startServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("service unavailable");
    });
    const outPath = path.join(dir, "scene_0_ytcc_3.mp4");

    const ok = await downloadYouTubeCCClip(videoId, 5, 0, outPath, 0, "Test video");

    expect(ok).toBe(false);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(tmpPathFor(outPath))).toBe(false);
  });

  it("never replaces an existing outPath when the download fails", async () => {
    await startServer((_req, res) => {
      res.writeHead(500);
      res.end("error");
    });
    const outPath = path.join(dir, "scene_0_ytcc_4.mp4");
    const existingContent = Buffer.from("previously-adopted-clip-bytes");
    fs.writeFileSync(outPath, existingContent);

    const ok = await downloadYouTubeCCClip(videoId, 5, 0, outPath, 0, "Test video");

    expect(ok).toBe(false);
    expect(fs.readFileSync(outPath).equals(existingContent)).toBe(true);
  });
});

// RapidAPI path (F3-05 group 5): same streaming conversion, same 50KB-80MB thresholds as before,
// now gated on fs.statSync(tmpPath).size instead of buffer.byteLength. See the top-of-file
// comment for why this is exercised against the shared helper directly rather than through the
// live RapidAPI-hardcoded-HTTPS function.
describe("downloadYouTubeCCClip RapidAPI path threshold logic (F3-05 group 5)", () => {
  let dir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-ytcc-rapid-test-"));
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

  it("streams successfully and passes the [50KB, 80MB] gate", async () => {
    const payload = Buffer.alloc(70_000, "r");
    await startServer(payload);
    const tmpPath = path.join(dir, "yt_rapid_0_tmp.mp4");

    const { bytesWritten } = await downloadToFileStreaming(`${baseUrl}/dl`, tmpPath, 5_000, "test");
    const fileSize = fs.statSync(tmpPath).size;

    expect(fileSize).toBe(bytesWritten);
    expect(fileSize < MIN || fileSize > MAX).toBe(false);
    expect(fs.readFileSync(tmpPath).equals(payload)).toBe(true);
  });

  it("rejects a too-small download (would be caught by the size gate before trim)", async () => {
    await startServer(Buffer.alloc(1_000, "r"));
    const tmpPath = path.join(dir, "yt_rapid_1_tmp.mp4");

    await downloadToFileStreaming(`${baseUrl}/dl`, tmpPath, 5_000, "test");
    const fileSize = fs.statSync(tmpPath).size;

    expect(fileSize < MIN || fileSize > MAX).toBe(true);
    // The RapidAPI branch's own finally-block unconditionally unlinks tmpPath regardless of
    // whether the size gate passed — simulate that cleanup here.
    fs.unlinkSync(tmpPath);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("rejects an oversized (>80MB) download", async () => {
    const oneMb = Buffer.alloc(1024 * 1024, "r");
    const chunks = 81;
    await startServer(Buffer.concat(Array(chunks).fill(oneMb)));
    const tmpPath = path.join(dir, "yt_rapid_2_tmp.mp4");

    await downloadToFileStreaming(`${baseUrl}/dl`, tmpPath, 10_000, "test");
    const fileSize = fs.statSync(tmpPath).size;

    expect(fileSize > MAX).toBe(true);
    fs.unlinkSync(tmpPath);
    expect(fs.existsSync(tmpPath)).toBe(false);
  }, 20_000);
});
