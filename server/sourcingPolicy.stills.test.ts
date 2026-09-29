import { describe, expect, it, vi } from "vitest";
import {
  archiveMaxImageClipsPerVideo,
  archiveMinVideoClipsTarget,
  archiveStillsPerMinute,
  curatedArchiveOnlyVisuals,
  curatedMaxStockBeatsPerVideo,
  openverseStillsEnabled,
  wikimediaInternetStillsEnabled,
} from "./sourcingPolicy";

describe("documentary still/video mix", () => {
  it("targets ~2–3 stills per minute", () => {
    expect(archiveStillsPerMinute()).toBe(2.5);
    expect(archiveMaxImageClipsPerVideo("1")).toBe(3);
    expect(archiveMaxImageClipsPerVideo("8-10")).toBe(25);
  });


});
