import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { downloadToFileStreaming } from "./videoPipeline";

// F3-05 group 2: fetchWikimediaVideos, fetchEuropeanaVideos, and fetchInternetArchiveClips were
// converted from Buffer.from(await resp.arrayBuffer()) to downloadToFileStreaming. Unlike group
// 1 (Pexels/Pixabay/B-roll, which only reject a too-small download), these three also reject an
// oversized download (Wikimedia/Europeana: <50KB or >80MB; Internet Archive: >50MB) — and because
// streaming always writes to disk first, a rejected download now leaves a file on disk that must
// be cleaned up, unlike the old buffered path where a rejected buffer was simply never written.
// downloadToFileStreaming's own success/HTTP-error/timeout/partial-file behavior is already
// covered by videoPipeline.downloadToFileStreaming.test.ts; these tests exercise the specific
// min/max size-then-cleanup pattern all three group-2 call sites now rely on.
describe("F3-05 group 2 size-guard pattern (Wikimedia/Europeana/Internet Archive)", () => {
  let dir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f305g2-test-"));
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

  it("accepts a download within the Wikimedia/Europeana [50KB, 80MB] range and keeps the file", async () => {
    await startServer(Buffer.alloc(60_000, "x"));
    const tmpPath = path.join(dir, "scene_0_wikivid_0_tmp");

    const { bytesWritten } = await downloadToFileStreaming(`${baseUrl}/clip`, tmpPath, 5_000, "test");

    const MIN = 50_000;
    const MAX = 80 * 1024 * 1024;
    expect(bytesWritten).not.toBeNull();
    const rejected = bytesWritten! < MIN || bytesWritten! > MAX;
    expect(rejected).toBe(false);
    expect(fs.existsSync(tmpPath)).toBe(true);
  });

  it("matches the reject condition for a too-small clip so the caller cleans it up", async () => {
    await startServer(Buffer.alloc(1_000, "x")); // below the 50KB floor
    const tmpPath = path.join(dir, "scene_0_euro_0_tmp");

    const { bytesWritten } = await downloadToFileStreaming(`${baseUrl}/clip`, tmpPath, 5_000, "test");

    expect(bytesWritten).toBe(1_000);
    const MIN = 50_000;
    const MAX = 80 * 1024 * 1024;
    const rejected = bytesWritten! < MIN || bytesWritten! > MAX;
    expect(rejected).toBe(true);
    // The file exists after the write (streaming always writes first) — this is exactly why
    // fetchWikimediaVideos/fetchEuropeanaVideos now unlink it explicitly on this branch.
    expect(fs.existsSync(tmpPath)).toBe(true);
    fs.unlinkSync(tmpPath);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("matches the Internet Archive max-only reject condition (no minimum)", async () => {
    const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024;
    await startServer(Buffer.alloc(2_000, "x")); // tiny, but Internet Archive has no min floor
    const tmpPath = path.join(dir, "scene_0_archive_0_tmp");

    const { bytesWritten } = await downloadToFileStreaming(`${baseUrl}/clip`, tmpPath, 5_000, "test");

    expect(bytesWritten).toBe(2_000);
    expect(bytesWritten! > MAX_ARCHIVE_SIZE).toBe(false); // not rejected — no min check for this source
    expect(fs.existsSync(tmpPath)).toBe(true);
  });
});
