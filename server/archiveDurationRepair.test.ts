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

  it("re-probes a video stuck exactly at the 3s fallback placeholder", async () => {
    vi.mocked(getMediaArchiveAssets).mockResolvedValue([
      {
        id: 2,
        archiveId: 9,
        mediaType: "video",
        durationSec: 3,
        isActive: 1,
        mimeType: "video/mp4",
        storageUrl: "/boeing.mp4",
      },
    ] as never);
    vi.mocked(loadArchiveAssetFile).mockResolvedValue({
      ok: true,
      result: { localPath: "/tmp/boeing.mp4", cleanup: vi.fn() },
    } as never);

    const probeMocks = await import("./archiveVideoSplitter");
    vi.spyOn(probeMocks, "probeVideoDurationSec").mockResolvedValue(20);
    vi.spyOn(probeMocks, "archiveStoredDurationSec").mockImplementation((n: number) => n);

    const result = await repairArchiveAssetDurations({ archiveId: 9 });

    expect(result.updated).toBe(1);
    expect(updateMediaArchiveAsset).toHaveBeenCalledWith(2, { durationSec: 20 });
  });
});
