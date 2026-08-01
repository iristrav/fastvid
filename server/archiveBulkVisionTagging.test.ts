import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./archiveAssetLoad", () => ({
  loadArchiveAssetFile: vi.fn(),
}));

vi.mock("./archiveEmbeddingIndex", () => ({
  indexArchiveAssetEmbedding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./archiveAssetTagging", () => ({
  archiveAiTaggingEnabled: vi.fn().mockReturnValue(true),
  generateArchiveAssetAiMetadataFromPath: vi.fn(),
  applySharedAiToClipFields: vi.fn((opts: {
    baseTitle: string;
    userTags: string[];
    ai: { title: string; tags: string[] };
    replaceTags?: boolean;
  }) => ({
    title: opts.ai.title,
    tags: opts.replaceTags
      ? [...new Set(opts.ai.tags)]
      : [...new Set([...opts.userTags, ...opts.ai.tags])],
    sourceNote: null,
  })),
}));

vi.mock("./db", () => ({
  getMediaArchiveById: vi.fn().mockResolvedValue({ id: 9, nicheTags: [] }),
  getMediaArchiveAssetById: vi.fn(),
  getMediaArchiveAssets: vi.fn(),
  filterMediaArchiveAssets: vi.fn(),
  updateMediaArchiveAsset: vi.fn().mockResolvedValue(undefined),
  normalizeMediaTags: (tags: string[]) =>
    [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))],
}));

import { loadArchiveAssetFile } from "./archiveAssetLoad";
import {
  generateArchiveAssetAiMetadataFromPath,
  applySharedAiToClipFields,
} from "./archiveAssetTagging";
import { getMediaArchiveAssetById, updateMediaArchiveAsset } from "./db";
import { autoTitleArchiveAssets, resolveAutoTitleAssetIds } from "./archiveBulkVisionTagging";

describe("archiveBulkVisionTagging", () => {
  it("resolveAutoTitleAssetIds is exported", () => {
    expect(typeof resolveAutoTitleAssetIds).toBe("function");
  });

  describe("autoTitleArchiveAssets", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(loadArchiveAssetFile).mockResolvedValue({
        ok: true,
        result: { localPath: "/tmp/clip.mp4", mimeType: "video/mp4", cleanup: vi.fn() },
      } as never);
      vi.mocked(generateArchiveAssetAiMetadataFromPath).mockResolvedValue({
        frameCount: 1,
        metadata: { title: "Berlin Street Fighting 1945", tags: ["world war 2", "berlin 1945"] },
      } as never);
    });

    it("skips a clip that already has 4+ tags", async () => {
      vi.mocked(getMediaArchiveAssetById).mockResolvedValue({
        id: 1,
        archiveId: 9,
        tags: ["a", "b", "c", "d"],
        sourceNote: null,
      } as never);

      const result = await autoTitleArchiveAssets({ archiveId: 9, ids: [1] });

      expect(result.updated).toBe(0);
      expect(result.skipReasons.hasTags).toBe(1);
      expect(updateMediaArchiveAsset).not.toHaveBeenCalled();
    });

    it("tops up (merges) a clip with fewer than 4 tags instead of skipping or replacing", async () => {
      vi.mocked(getMediaArchiveAssetById).mockResolvedValue({
        id: 2,
        archiveId: 9,
        tags: ["winston churchill"],
        sourceNote: null,
      } as never);

      const result = await autoTitleArchiveAssets({ archiveId: 9, ids: [2] });

      expect(result.updated).toBe(1);
      expect(applySharedAiToClipFields).toHaveBeenCalledWith(
        expect.objectContaining({ userTags: ["winston churchill"], replaceTags: false })
      );
      const savedTags = vi.mocked(updateMediaArchiveAsset).mock.calls[0]?.[1]?.tags as string[];
      expect(savedTags).toContain("winston churchill");
      expect(savedTags).toContain("world war 2");
    });
  });
});
