import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./archiveAssetLoad", () => ({
  loadArchiveAssetFile: vi.fn(),
}));

vi.mock("./db", () => ({
  getMediaArchiveAssets: vi.fn(),
  updateMediaArchiveAsset: vi.fn(),
}));

import { loadArchiveAssetFile } from "./archiveAssetLoad";
import { getMediaArchiveAssets, updateMediaArchiveAsset } from "./db";
import { repairArchiveAssetDurations } from "./archiveDurationRepair";

describe("repairArchiveAssetDurations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets still images to 3s minimum", async () => {
    vi.mocked(getMediaArchiveAssets).mockResolvedValue([
      {
        id: 1,
        archiveId: 9,
        mediaType: "image",
        durationSec: 0,
        isActive: 1,
        mimeType: "image/jpeg",
        storageUrl: "/x.jpg",
      },
    ] as never);

    const result = await repairArchiveAssetDurations({ archiveId: 9 });

    expect(result.updated).toBe(1);
    expect(updateMediaArchiveAsset).toHaveBeenCalledWith(1, { durationSec: 3 });
    expect(loadArchiveAssetFile).not.toHaveBeenCalled();
  });
});
