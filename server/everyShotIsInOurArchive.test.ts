/**
 * EVERY SHOT IS IN OUR OWN ARCHIVE — STOCK IN ITS OWN — RONDE 647.
 *
 * Video 604 rendered cleanly and was not delivered:
 *
 *   [DeliveryGate] CLIP_WITHOUT_ARCHIVE_ASSET — clip=vc_e3bcfe6285 provider=pexels
 *                  providerAssetId=8382393 has no archive asset
 *
 * The gate requires an archive asset for every shot; the push gate exempted stock from being
 * stored; the ingestion refused stock outright. Three rules, never all satisfiable.
 *
 *   §1  stock is stored, in the separate "Stockbeelden" archive, marked as stock
 *   §2  RONDE 9 still holds: without that flag stock is refused, and the stock archive is never a
 *       default target and never searched as archive footage
 *   §3  the push gate asks for it
 *
 * The ingestion runs for real on a real clip; the database and storage are faked at their module
 * boundary, the same convention as `archiveIngestion.test.ts`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { execSync } from "child_process";
import os from "os";
import path from "path";
import { readFileSync } from "fs";
import { join } from "path";

const createMediaArchiveAssetMock = vi.fn();
const getAllMediaArchivesMock = vi.fn();
const findBySourceUrlHashMock = vi.fn();
const ensureStockMediaArchiveMock = vi.fn();
const ensureAutoMediaArchiveMock = vi.fn();
const storagePutMock = vi.fn();

vi.mock("./db", () => ({
  createMediaArchiveAsset: (...a: unknown[]) => createMediaArchiveAssetMock(...a),
  getAllMediaArchives: (...a: unknown[]) => getAllMediaArchivesMock(...a),
  findMediaArchiveAssetBySourceUrlHash: (...a: unknown[]) => findBySourceUrlHashMock(...a),
  ensureStockMediaArchive: (...a: unknown[]) => ensureStockMediaArchiveMock(...a),
  ensureAutoMediaArchive: (...a: unknown[]) => ensureAutoMediaArchiveMock(...a),
}));
vi.mock("./storage", () => ({ storagePut: (...a: unknown[]) => storagePutMock(...a) }));
vi.mock("./archiveEmbeddingIndex", () => ({ indexArchiveAssetEmbedding: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./visualSearchMemory", () => ({ recordVisualSearchMemory: vi.fn().mockResolvedValue(undefined) }));

import { ingestExternalClipToArchiveWithReason } from "./archiveIngestion";
import { AUTO_ARCHIVES, STOCK_ARCHIVE_SLUG, autoArchiveKind } from "./stockArchive";

const pexels = {
  title: "Soldiers marching",
  tags: ["soldiers"],
  sourceNote: "pexels:8382393",
  sourcePlatform: "pexels",
  sourceUrl: "https://www.pexels.com/video/8382393/",
  mediaType: "video" as const,
  mimeType: "video/mp4",
  durationSec: 4,
};

let dir = "";
let clip = "";

beforeEach(() => {
  createMediaArchiveAssetMock.mockReset().mockResolvedValue(9001);
  getAllMediaArchivesMock.mockReset().mockResolvedValue([
    { id: 77, slug: STOCK_ARCHIVE_SLUG, isActive: 1 },
    { id: 1, slug: "ww2", isActive: 1 },
  ]);
  findBySourceUrlHashMock.mockReset().mockResolvedValue(null);
  ensureStockMediaArchiveMock.mockReset().mockResolvedValue(77);
  /** RONDE 648 — the YouTube archive is 5, Overig is 6; the stock archive is never an automatic default. */
  ensureAutoMediaArchiveMock.mockReset().mockImplementation(async (kind: string) => ({ youtube: 5, other: 6 })[kind] ?? null);
  storagePutMock.mockReset().mockImplementation(async (key: string) => ({ key, url: `https://cdn.example/${key}` }));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "r647-stock-"));
  clip = path.join(dir, "clip.mp4");
  execSync(
    `ffmpeg -y -f lavfi -i "testsrc=size=640x480:rate=25:duration=4" ` +
      `-c:v libx264 -pix_fmt yuv420p -b:v 1200k "${clip}" 2>/dev/null`
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("§1 — stock is stored, in the Stockbeelden archive", () => {
  it("a Pexels shot for the film lands in the stock archive, marked stock", async () => {
    const out = await ingestExternalClipToArchiveWithReason(clip, { ...pexels, stockArchive: true });
    expect(out.status).toBe("ingested");
    expect(createMediaArchiveAssetMock).toHaveBeenCalledTimes(1);
    const row = createMediaArchiveAssetMock.mock.calls[0]![0] as { archiveId: number; mixKind: string; storageKey: string };
    expect(row.archiveId).toBe(77);
    expect(row.mixKind).toBe("stock");
    expect(row.storageKey).toContain("archive-ingested/77/");
  });

  it("no stock archive to be had is a named refusal, not a silent curated fallback", async () => {
    ensureStockMediaArchiveMock.mockResolvedValue(null);
    const out = await ingestExternalClipToArchiveWithReason(clip, { ...pexels, stockArchive: true });
    expect(out.status).toBe("refused");
    expect((out as { reasonCode: string }).reasonCode).toBe("STOCK_ARCHIVE_UNAVAILABLE");
    expect(createMediaArchiveAssetMock).not.toHaveBeenCalled();
  });
});

describe("§2 — RONDE 9 still holds", () => {
  it("stock WITHOUT the flag is refused, exactly as before", async () => {
    const out = await ingestExternalClipToArchiveWithReason(clip, pexels);
    expect(out.status).toBe("refused");
    expect((out as { reasonCode: string }).reasonCode).toBe("EXEMPT_SOURCE");
    expect(createMediaArchiveAssetMock).not.toHaveBeenCalled();
  });

  it("the stock archive is never the default target: a YouTube segment goes to the YouTube archive", async () => {
    const out = await ingestExternalClipToArchiveWithReason(clip, {
      title: "Berlin 1945",
      tags: ["berlin"],
      sourceNote: "youtube_cc:abc@13s",
      sourcePlatform: "youtube_cc",
      mediaType: "video",
      mimeType: "video/mp4",
      durationSec: 4,
    });
    expect(out.status).toBe("ingested");
    const row = createMediaArchiveAssetMock.mock.calls[0]![0] as { archiveId: number; mixKind: string };
    expect(row.archiveId).toBe(5);
    expect(row.mixKind).toBe("real_video");
    expect(ensureAutoMediaArchiveMock).toHaveBeenCalledWith("youtube");
    expect(ensureStockMediaArchiveMock).not.toHaveBeenCalled();
  });

  it("the flag on a non-stock clip changes nothing: a Wikimedia clip goes to Overig", async () => {
    const out = await ingestExternalClipToArchiveWithReason(clip, {
      title: "Berlin 1945",
      tags: ["berlin"],
      sourceNote: "wikimedia:File:Berlin.webm",
      sourcePlatform: "wikimedia",
      mediaType: "video",
      mimeType: "video/mp4",
      durationSec: 4,
      stockArchive: true,
    });
    expect(out.status).toBe("ingested");
    expect((createMediaArchiveAssetMock.mock.calls[0]![0] as { archiveId: number }).archiveId).toBe(6);
    expect(ensureAutoMediaArchiveMock).toHaveBeenCalledWith("other");
    expect(ensureStockMediaArchiveMock).not.toHaveBeenCalled();
  });

  it("curated sourcing never searches the stock archive — every archive list excludes it by name", () => {
    const CURATED = readFileSync(join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    const lists = CURATED.match(/getAllMediaArchives\(\)\)\.filter\([^\n]+/g) ?? [];
    expect(lists.length).toBe(3);
    for (const l of lists) {
      expect(l).toContain("a.isActive === 1");
      expect(l).toContain("a.slug !== STOCK_ARCHIVE_SLUG");
    }
  });

  it("the stock archive is created INACTIVE, under its own slug", () => {
    expect(AUTO_ARCHIVES.stock).toMatchObject({ name: "Stockbeelden", slug: STOCK_ARCHIVE_SLUG, isActive: 0 });
    const DB = readFileSync(join(__dirname, "db.ts"), "utf8");
    const at = DB.indexOf("export async function ensureStockMediaArchive(");
    const body = DB.slice(at, DB.indexOf("\n}\n", at));
    expect(body).toContain('return ensureAutoMediaArchive("stock")');
  });

  it("RONDE 648 — the kind of an automatic ingest is read from its own source", () => {
    expect(autoArchiveKind({ sourcePlatform: "pexels", sourceNote: "pexels:1" })).toBe("stock");
    expect(autoArchiveKind({ sourceNote: "pixabay:2" })).toBe("stock");
    expect(autoArchiveKind({ sourcePlatform: "youtube_cc", sourceNote: "youtube_cc:abc@13s" })).toBe("youtube");
    expect(autoArchiveKind({ sourceNote: "youtube_cc:youtube_cc:FDUFqdMOeMg" })).toBe("youtube");
    expect(autoArchiveKind({ sourcePlatform: "wikimedia", sourceNote: "wikimedia:File:Klara_Hitler.jpg" })).toBe("other");
    expect(autoArchiveKind({ sourceNote: "internet_archive:item555" })).toBe("other");
  });
});

describe("§3 — the push gate stores stock instead of exempting it", () => {
  it("stock providers are named in one place", async () => {
    const { isStockProvider, sourceMayEnterCuratedArchive } = await import("./videoPipeline");
    expect(isStockProvider("pexels")).toBe(true);
    expect(isStockProvider(" Pixabay ")).toBe(true);
    expect(isStockProvider("wikimedia")).toBe(false);
    expect(sourceMayEnterCuratedArchive("pexels")).toBe(false);
  });
});
