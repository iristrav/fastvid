import { describe, expect, it } from "vitest";
import {
  clipVisionGateEnabled,
  shouldVisionCheckClip,
  minClipQualityScore,
} from "./visualQualityGate";
import {
  filenameLexicalBoost,
  localVisionEnabled,
  minLocalClipSimilarity,
} from "./localClipVision";

describe("visualQualityGate", () => {
  it("checks archival and stock filenames when critical review on", () => {
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_hist_archive_titanic.mp4")).toBe(true);
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_pexels_ocean.mp4")).toBe(true);
  });

  it("skips stock vision in fast mode unless ENABLE_CLIP_VISION_STOCK=true", () => {
    const prevStock = process.env.ENABLE_CLIP_VISION_STOCK;
    const prevReview = process.env.ENABLE_SCENE_CRITICAL_REVIEW;
    process.env.ENABLE_CLIP_VISION_STOCK = "false";
    process.env.ENABLE_SCENE_CRITICAL_REVIEW = "false";
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_pexels_ocean.mp4", true)).toBe(false);
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_hist_archive_titanic.mp4", true)).toBe(true);
    process.env.ENABLE_CLIP_VISION_STOCK = prevStock;
    process.env.ENABLE_SCENE_CRITICAL_REVIEW = prevReview;
  });

  it("clipVisionGateEnabled respects ENABLE_LOCAL_VISION=false", () => {
    const prev = process.env.ENABLE_LOCAL_VISION;
    process.env.ENABLE_LOCAL_VISION = "false";
    expect(clipVisionGateEnabled()).toBe(false);
    process.env.ENABLE_LOCAL_VISION = prev;
  });
});

describe("localClipVision helpers", () => {
  it("filenameLexicalBoost rewards matching tokens in clip path", () => {
    const boost = filenameLexicalBoost(
      "/tmp/scene_0_amsterdam_cycling_pexels.mp4",
      "Cyclists cross a bridge in Amsterdam during rush hour.",
      "Amsterdam documentary"
    );
    expect(boost).toBeGreaterThan(0);
  });

  it("minLocalClipSimilarity scales with min quality score", () => {
    expect(minLocalClipSimilarity(8)).toBeCloseTo(0.2, 2);
    expect(minLocalClipSimilarity(6)).toBeCloseTo(0.15, 2);
  });

  it("localVisionEnabled is on by default", () => {
    const prev = process.env.ENABLE_LOCAL_VISION;
    delete process.env.ENABLE_LOCAL_VISION;
    expect(localVisionEnabled()).toBe(true);
    expect(minClipQualityScore()).toBe(8);
    process.env.ENABLE_LOCAL_VISION = prev;
  });
});
