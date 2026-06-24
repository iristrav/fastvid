import { describe, expect, it } from "vitest";
import {
  clipVisionGateEnabled,
  shouldVisionCheckClip,
  minClipQualityScore,
  clipVisionFrameCoverage,
  effectiveVisionSampleCount,
  cascadeVisionGateEnabled,
  cascadeVisionExpandBelow,
  effectiveMinClipQualityScore,
} from "./visualQualityGate";
import {
  filenameLexicalBoost,
  localVisionEnabled,
  minLocalClipSimilarity,
  buildBeatVisionQueryText,
} from "./localClipVision";

describe("visualQualityGate", () => {
  it("vision-checks all montage clips including openverse and stock", () => {
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_hist_archive_titanic.mp4")).toBe(true);
    expect(shouldVisionCheckClip("/tmp/scene_0_wiki2ov_openverse_0.mp4")).toBe(true);
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_pexels_ocean.mp4")).toBe(true);
    expect(shouldVisionCheckClip("/tmp/scene_0_b1_v1wiki_b2.mp4")).toBe(true);
  });

  it("skips guaranteed and motion-graphic fallbacks", () => {
    expect(shouldVisionCheckClip("/tmp/scene_0_slot3_guaranteed.mp4")).toBe(false);
    expect(shouldVisionCheckClip("/tmp/scene_0_mgfx_card.mp4")).toBe(false);
  });

  it("skips vision when ENABLE_LOCAL_VISION=false", () => {
    const prev = process.env.ENABLE_LOCAL_VISION;
    process.env.ENABLE_LOCAL_VISION = "false";
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_pexels_ocean.mp4")).toBe(false);
    process.env.ENABLE_LOCAL_VISION = prev;
  });

  it("clipVisionGateEnabled respects ENABLE_LOCAL_VISION=false", () => {
    const prev = process.env.ENABLE_LOCAL_VISION;
    process.env.ENABLE_LOCAL_VISION = "false";
    expect(clipVisionGateEnabled()).toBe(false);
    process.env.ENABLE_LOCAL_VISION = prev;
  });

  it("defaults to 80% vision frame coverage with same min score", () => {
    const prev = process.env.CLIP_VISION_COVERAGE;
    delete process.env.CLIP_VISION_COVERAGE;
    expect(clipVisionFrameCoverage()).toBe(0.8);
    expect(clipVisionFrameCoverage(true)).toBe(0.5);
    expect(effectiveVisionSampleCount(false)).toBe(3);
    expect(effectiveVisionSampleCount(true)).toBe(1);
    process.env.CLIP_VISION_COVERAGE = prev;
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

  it("cascadeVisionGateEnabled is on with local vision", () => {
    const prev = process.env.ENABLE_CASCADE_VISION_GATE;
    delete process.env.ENABLE_CASCADE_VISION_GATE;
    expect(cascadeVisionGateEnabled()).toBe(true);
    expect(cascadeVisionExpandBelow(8)).toBe(6);
    process.env.ENABLE_CASCADE_VISION_GATE = prev;
  });

  it("buildBeatVisionQueryText prefers visual description over narration", () => {
    const q = buildBeatVisionQueryText({
      beatText: "Something abstract about history.",
      visualDescription: "World War II soldiers marching in Berlin",
    });
    expect(q.indexOf("World War II")).toBeLessThan(q.indexOf("Something abstract"));
  });

  it("effectiveMinClipQualityScore stays at minClipQualityScore when strict voice visual match is on", () => {
    const prev = process.env.STRICT_VOICE_VISUAL_MATCH;
    process.env.STRICT_VOICE_VISUAL_MATCH = "true";
    expect(effectiveMinClipQualityScore(true, true)).toBe(minClipQualityScore());
    process.env.STRICT_VOICE_VISUAL_MATCH = prev;
  });
});
