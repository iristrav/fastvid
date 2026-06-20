import { describe, expect, it } from "vitest";
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

  it("prefers video for remaining beats", () => {
    expect(archiveMinVideoClipsTarget("1")).toBe(7);
  });

  it("caps Pexels/Pixabay as last resort", () => {
    expect(curatedMaxStockBeatsPerVideo("1")).toBe(1);
    expect(curatedMaxStockBeatsPerVideo("8-10")).toBe(2);
  });
});

describe("internet photo stills policy", () => {
  it("disables Openverse in archive-first mode", () => {
    const prevCurated = process.env.CURATED_ARCHIVE_ONLY;
    process.env.CURATED_ARCHIVE_ONLY = "true";
    expect(curatedArchiveOnlyVisuals()).toBe(true);
    expect(openverseStillsEnabled()).toBe(false);
    expect(wikimediaInternetStillsEnabled()).toBe(true);
    process.env.CURATED_ARCHIVE_ONLY = prevCurated;
  });
});
