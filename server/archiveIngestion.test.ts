import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// F3-26: self-learning archive ingestion — extended with structured web-sourcing provenance
// (sourceUrl/sourcePlatform/sourceCreator/licenseUrl/originalQuery/matchedQuery/entities/topics)
// and duplicate protection via sourceUrl so the same web asset is never archived twice. Storage/
// DB/embedding/search-memory are mocked at their module boundary (same convention as
// archiveDurationRepair.test.ts) — the real ingestExternalClipToArchive()/quality-gate/
// duplicate-check logic under test is exercised unmocked.
const createMediaArchiveAssetMock = vi.fn();
const getAllMediaArchivesMock = vi.fn();
const findMediaArchiveAssetBySourceUrlHashMock = vi.fn();
const storagePutMock = vi.fn();
const indexArchiveAssetEmbeddingMock = vi.fn().mockResolvedValue(undefined);
const recordVisualSearchMemoryMock = vi.fn().mockResolvedValue(undefined);

vi.mock("./db", () => ({
  createMediaArchiveAsset: (...args: unknown[]) => createMediaArchiveAssetMock(...args),
  getAllMediaArchives: (...args: unknown[]) => getAllMediaArchivesMock(...args),
  findMediaArchiveAssetBySourceUrlHash: (...args: unknown[]) => findMediaArchiveAssetBySourceUrlHashMock(...args),
}));
vi.mock("./storage", () => ({
  storagePut: (...args: unknown[]) => storagePutMock(...args),
}));
vi.mock("./archiveEmbeddingIndex", () => ({
  indexArchiveAssetEmbedding: (...args: unknown[]) => indexArchiveAssetEmbeddingMock(...args),
}));
vi.mock("./visualSearchMemory", () => ({
  recordVisualSearchMemory: (...args: unknown[]) => recordVisualSearchMemoryMock(...args),
}));

import { ingestExternalClipToArchive } from "./archiveIngestion";

describe("ingestExternalClipToArchive — F3-26 structured provenance + duplicate protection", () => {
  let tmpDir: string;
  let clipPath: string;

  beforeEach(() => {
    createMediaArchiveAssetMock.mockReset().mockResolvedValue(101);
    getAllMediaArchivesMock.mockReset().mockResolvedValue([{ id: 1, isActive: 1 }]);
    findMediaArchiveAssetBySourceUrlHashMock.mockReset().mockResolvedValue(null);
    storagePutMock.mockReset().mockResolvedValue({ key: "archive-ingested/1/test.mp4", url: "https://cdn.example.com/test.mp4" });
    indexArchiveAssetEmbeddingMock.mockClear();
    recordVisualSearchMemoryMock.mockClear();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "f326-ingest-test-"));
    clipPath = path.join(tmpDir, "clip.mp4");
    fs.writeFileSync(clipPath, Buffer.alloc(200_000, 1)); // > 50KB quality gate
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Test 3/4/5 — a web-found asset is ingested with its source URL, query, and entities persisted", async () => {
    const result = await ingestExternalClipToArchive(clipPath, {
      title: "Justin Bieber 2015 interview clip",
      tags: ["justin bieber", "interview"],
      sourceNote: "youtube_cc:vid123",
      mediaType: "video",
      mimeType: "video/mp4",
      durationSec: 10,
      sourceUrl: "https://youtube.com/watch?v=vid123",
      sourcePlatform: "youtube_cc",
      sourceCreator: "Some Channel",
      licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
      originalQuery: "Justin Bieber 2015 interview",
      matchedQuery: "Justin Bieber 2015 interview",
      entities: [{ type: "person", value: "Justin Bieber" }],
      topics: ["music"],
    });

    expect(result).not.toBeNull();
    expect(result!.assetId).toBe(101);
    expect(createMediaArchiveAssetMock).toHaveBeenCalledTimes(1);
    const inserted = createMediaArchiveAssetMock.mock.calls[0]![0];
    expect(inserted.sourceUrl).toBe("https://youtube.com/watch?v=vid123");
    expect(typeof inserted.sourceUrlHash).toBe("string");
    expect(inserted.sourceUrlHash).toHaveLength(64);
    expect(inserted.sourcePlatform).toBe("youtube_cc");
    expect(inserted.sourceCreator).toBe("Some Channel");
    expect(inserted.originalQuery).toBe("Justin Bieber 2015 interview");
    expect(inserted.entities).toEqual(["Justin Bieber"]);
    expect(inserted.topics).toEqual(["music"]);
    expect(inserted.downloadedAt).toBeInstanceOf(Date);

    // The learning loop records this query/entity/source/asset combination.
    expect(recordVisualSearchMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "Justin Bieber",
        entityType: "person",
        query: "Justin Bieber 2015 interview",
        source: "youtube_cc",
        assetId: 101,
        success: true,
      })
    );

    // Test 15 — the new asset is indexed via the existing embedding flow, same as before F3-26.
    expect(indexArchiveAssetEmbeddingMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101, title: "Justin Bieber 2015 interview clip" })
    );
  });

  it("Test 7 — a source URL already in the archive is reused, not re-downloaded/re-ingested", async () => {
    findMediaArchiveAssetBySourceUrlHashMock.mockResolvedValue({
      id: 999,
      storageKey: "archive-ingested/1/existing.mp4",
    });

    const result = await ingestExternalClipToArchive(clipPath, {
      title: "Duplicate clip",
      tags: [],
      sourceNote: "wikimedia:File_Foo.mp4",
      mediaType: "video",
      mimeType: "video/mp4",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Foo.mp4",
    });

    expect(result).toEqual({ assetId: 999, storageKey: "archive-ingested/1/existing.mp4", reused: true });
    // No new upload, no new DB insert.
    expect(storagePutMock).not.toHaveBeenCalled();
    expect(createMediaArchiveAssetMock).not.toHaveBeenCalled();
  });

  it("still admits a genuinely new asset when its source URL has never been seen before", async () => {
    findMediaArchiveAssetBySourceUrlHashMock.mockResolvedValue(null);
    const result = await ingestExternalClipToArchive(clipPath, {
      title: "Brand new clip",
      tags: [],
      // RONDE 9: fixtures moved off pexels — stock sources are now refused before this path.
      sourceNote: "internet_archive:item555",
      mediaType: "video",
      mimeType: "video/mp4",
      sourceUrl: "https://archive.org/details/item555",
    });
    expect(result?.reused).toBeUndefined();
    expect(storagePutMock).toHaveBeenCalledTimes(1);
    expect(createMediaArchiveAssetMock).toHaveBeenCalledTimes(1);
  });

  it("admin-uploaded assets without a sourceUrl skip the duplicate check entirely (backward compatible)", async () => {
    const result = await ingestExternalClipToArchive(clipPath, {
      title: "No source URL",
      tags: [],
      sourceNote: "wikimedia:File_Bar.mp4",
      mediaType: "video",
      mimeType: "video/mp4",
    });
    expect(findMediaArchiveAssetBySourceUrlHashMock).not.toHaveBeenCalled();
    expect(result?.assetId).toBe(101);
  });

  it("the existing quality gate (min file size) still rejects a too-small file, unaffected by the new fields", async () => {
    const tinyPath = path.join(tmpDir, "tiny.mp4");
    fs.writeFileSync(tinyPath, Buffer.alloc(100, 1));
    const result = await ingestExternalClipToArchive(tinyPath, {
      title: "Too small",
      tags: [],
      sourceNote: "wikimedia:File_Tiny.mp4",
      mediaType: "video",
      mimeType: "video/mp4",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Tiny.mp4",
    });
    expect(result).toBeNull();
    expect(findMediaArchiveAssetBySourceUrlHashMock).not.toHaveBeenCalled();
    expect(createMediaArchiveAssetMock).not.toHaveBeenCalled();
  });

  it("RONDE 9 — stock footage (Pexels/Pixabay) is refused outright, before any upload or insert", async () => {
    for (const sourceNote of ["pexels:555", "pixabay:777"]) {
      const result = await ingestExternalClipToArchive(clipPath, {
        title: "Stock clip that won a beat",
        tags: [],
        sourceNote,
        mediaType: "video",
        mimeType: "video/mp4",
        sourceUrl: `https://example.com/${sourceNote}`,
      });
      expect(result).toBeNull();
    }
    expect(storagePutMock).not.toHaveBeenCalled();
    expect(createMediaArchiveAssetMock).not.toHaveBeenCalled();
  });
});
