/**
 * VIDEO 619 — the archive intake stores single shots, never the long download they came from.
 * Database, storage and embedding are replaced at their module boundary, as in archiveIngestion.test.ts;
 * the intake itself, its gates and a real video file are exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";

const created: Array<Record<string, unknown>> = [];
vi.mock("./db", () => ({
  createMediaArchiveAsset: async (row: Record<string, unknown>) => (created.push(row), 500 + created.length),
  ensureAutoMediaArchive: async () => 7,
  ensureStockMediaArchive: async () => 9,
  findMediaArchiveAssetBySourceUrlHash: async () => null,
}));
vi.mock("./storage", () => ({ storagePut: async (key: string) => ({ key, url: `https://cdn.example/${key}` }) }));
vi.mock("./archiveEmbeddingIndex", () => ({ indexArchiveAssetEmbedding: async () => undefined }));
vi.mock("./visualSearchMemory", () => ({ recordVisualSearchMemory: async () => undefined }));
vi.mock("./archiveClipFilter", () => ({
  cachedClipBakedEditTextVerdict: async () => ({ verdict: "clean" }),
}));

import { ingestExternalClipToArchiveWithReason, setIngestShotCutterForTests } from "./archiveIngestion";

describe("Video 619 — cut first, then store", () => {
  let dir: string;
  let clip: string;
  beforeEach(() => {
    created.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-shots-"));
    clip = path.join(dir, "download.mp4");
    execSync(`ffmpeg -y -f lavfi -i "testsrc=size=640x480:rate=25:duration=4" -c:v libx264 -pix_fmt yuv420p -b:v 1200k "${clip}" 2>/dev/null`);
    /** Pretends the download is 30 s with cuts at 4 and 18; each "shot" is a copy of a real clip. */
    setIngestShotCutterForTests({
      detect: async () => ({ durationSec: 30, cutsSec: [4, 18] }),
      extract: async (input, out) => fs.copyFileSync(input, out),
    });
  }, 30_000);
  afterEach(() => {
    setIngestShotCutterForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const meta = (over: Record<string, unknown> = {}) => ({
    title: "Kylie Jenner interview",
    tags: ["kylie jenner", "interview"],
    sourceNote: "youtube_cc:abc@10",
    sourceUrl: "https://www.youtube.com/watch?v=abc&t=10",
    mediaType: "video" as const,
    mimeType: "video/mp4",
    durationSec: 30,
    ...over,
  });

  it("stores each shot as its own asset and never the 30-second original", async () => {
    const out = await ingestExternalClipToArchiveWithReason(clip, meta());
    expect(out.status).toBe("ingested");
    expect(created.length).toBe(5);
    for (const row of created) {
      expect(String(row.title)).toMatch(/· shot \d$/);
      expect(String(row.sourceUrl)).toContain("#shot=");
      expect(Number(row.durationSec)).toBeLessThanOrEqual(11);
      expect(row.shotCutsSec).toEqual([]);
      expect(row.isActive).toBe(1);
    }
  }, 60_000);

  it("a clip a film is made with is also kept as the film's record, switched off", async () => {
    const out = await ingestExternalClipToArchiveWithReason(clip, meta({ usedInFilm: true }));
    expect(out.status).toBe("ingested");
    expect(created.length).toBe(6);
    const record = created[created.length - 1]!;
    expect(record.isActive).toBe(0);
    expect(String(record.title)).not.toContain("· shot");
  }, 60_000);

  it("stock is not cut here; it goes to its own archive as before", async () => {
    const out = await ingestExternalClipToArchiveWithReason(
      clip,
      meta({ sourceNote: "pexels:1", sourcePlatform: "pexels", stockArchive: true, sourceUrl: "https://pexels.com/v/1" })
    );
    expect(out.status).toBe("ingested");
    expect(created.length).toBe(1);
  }, 60_000);
});
