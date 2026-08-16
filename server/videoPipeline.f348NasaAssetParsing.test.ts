import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";

// F3-48: images-api.nasa.gov/asset/{id} returns the same collection.items envelope the
// sibling /search endpoint uses, with each item shaped as { href: string } — NOT a bare
// array of URL strings. Treating the raw response as string[] made every NASA candidate
// throw "assets.find is not a function" instead of being parsed (see the F3-48 fix in
// fetchNasaVideoClips). This test proves a realistically-shaped NASA response no longer
// throws and that the real href gets extracted and used for the download.
//
// videoPipeline.ts imports `fetch` from "node-fetch" (not the global fetch), so the two
// NASA endpoints are intercepted here via vi.mock("node-fetch", ...); every other URL
// (the local download server below) passes through to the real node-fetch implementation.
let nasaAssetHref = "";

vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  const mockFetch = vi.fn(async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.startsWith("https://images-api.nasa.gov/search")) {
      return new actual.Response(
        JSON.stringify({
          collection: { items: [{ data: [{ nasa_id: "F348TEST", title: "F3-48 test asset" }] }] },
        }),
        { status: 200 }
      );
    }
    if (u.startsWith("https://images-api.nasa.gov/asset/")) {
      // Real shape: collection.items[].href, not a bare string[].
      return new actual.Response(
        JSON.stringify({ collection: { items: [{ href: nasaAssetHref }] } }),
        { status: 200 }
      );
    }
    return (actual.default as typeof actual.default)(url as never, init as never);
  });
  return { ...actual, default: mockFetch };
});

const { fetchNasaVideoClips } = await import("./videoPipeline");

describe("F3-48 NASA asset-manifest response parsing", () => {
  let dir: string;
  let server: http.Server;
  let downloadRequests = 0;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f348-test-"));
    downloadRequests = 0;
  });

  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function startClipServer(payload: Buffer): Promise<string> {
    server = http.createServer((_req, res) => {
      downloadRequests++;
      res.writeHead(200);
      res.end(payload);
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  it("does not throw on a real NASA asset-manifest shape and downloads the extracted href", async () => {
    // Below NASA's existing 50KB floor on purpose — lets the function reach and reject via
    // its own existing size gate deterministically, without needing a real playable video.
    const baseUrl = await startClipServer(Buffer.alloc(2_000, "n"));
    nasaAssetHref = `${baseUrl}/F348TEST~orig.mp4`;

    await expect(
      fetchNasaVideoClips("F3-48 test query", 5, dir, 0, 1)
    ).resolves.toEqual([]); // [] because the payload is deliberately under the 50KB floor

    expect(downloadRequests).toBe(1); // proves the correctly-extracted href was actually fetched
  });
});
