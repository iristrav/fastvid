import { describe, expect, it } from "vitest";
import { clipVisionGateEnabled, shouldVisionCheckClip } from "./visualQualityGate";

describe("visualQualityGate", () => {
  it("checks archival and stock filenames for vision when critical review on", () => {
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_hist_archive_titanic.mp4")).toBe(true);
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_pexels_ocean.mp4")).toBe(true);
  });

  it("clipVisionGateEnabled respects ENABLE_CLIP_VISION=false", () => {
    const prev = process.env.ENABLE_CLIP_VISION;
    process.env.ENABLE_CLIP_VISION = "false";
    expect(clipVisionGateEnabled()).toBe(false);
    process.env.ENABLE_CLIP_VISION = prev;
  });
});
