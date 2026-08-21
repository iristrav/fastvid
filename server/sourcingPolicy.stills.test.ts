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

  it("prefers video for remaining beats — except on the 1-min fast path, which has no target", () => {
    // RONDE 30: asserted 7. archiveMinVideoClipsTarget has an explicit
    // `if (isFastShortVideoLength(videoLength)) return 0;` — a deliberate line, so the "1" case
    // is 0 by design and the real target only applies to longer videos. Both are now covered.
    expect(archiveMinVideoClipsTarget("1")).toBe(0);
    expect(archiveMinVideoClipsTarget("8-10")).toBeGreaterThan(0);
  });

  it("caps Pexels/Pixabay as last resort (strict visual focus)", () => {
    // RONDE 30: asserted 6 for "1". It is 12 — and sourcingPolicy.cadence.test.ts already
    // asserted 12 correctly, so these two files have been contradicting each other on the same
    // function while one of them sat red. Aligned with the passing one.
    expect(curatedMaxStockBeatsPerVideo("1")).toBe(12);
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
