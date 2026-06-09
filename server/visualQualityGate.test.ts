import { describe, expect, it } from "vitest";
import { clipVisionGateEnabled, shouldVisionCheckClip } from "./visualQualityGate";

describe("visualQualityGate", () => {
  it("checks archival filenames for vision", () => {
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_hist_archive_titanic.mp4")).toBe(true);
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_pexels_ocean.mp4")).toBe(false);
  });

  it("clipVisionGateEnabled respects ENABLE_CLIP_VISION=false", () => {
    const prev = process.env.ENABLE_CLIP_VISION;
    process.env.ENABLE_CLIP_VISION = "false";
    expect(clipVisionGateEnabled()).toBe(false);
    process.env.ENABLE_CLIP_VISION = prev;
  });
});
