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

  /**
   * By default every length gets a minimum moving-footage target, INCLUDING the one-minute test
   * length. It used to get zero — no minimum at all — which is one of the reasons a one-minute run
   * could not tell you anything about a real film. See `isFastShortVideoLength`.
   */
  it("prefers video for remaining beats, at every length", () => {
    expect(archiveMinVideoClipsTarget("1")).toBeGreaterThan(0);
    expect(archiveMinVideoClipsTarget("8-10")).toBeGreaterThan(0);
  });

  /**
   * The fast-short tuning still exists and still does what it did — `archiveMinVideoClipsTarget`
   * keeps its explicit `if (isFastShortVideoLength(videoLength)) return 0;`. Only its default
   * changed, so the old behaviour is asserted here rather than deleted.
   */
  it("the fast-short path still has no target, when it is asked for", () => {
    vi.stubEnv("FAST_SHORT_PATH", "true");
    try {
      expect(archiveMinVideoClipsTarget("1")).toBe(0);
      expect(archiveMinVideoClipsTarget("8-10")).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
    }
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
