import { describe, expect, it } from "vitest";
import {
  buildVoiceVisualMatchSummary,
  countGuaranteedClipsInPaths,
  isGuaranteedPipelineClip,
} from "./voiceVisualMatch";

describe("voiceVisualMatch", () => {
  it("detects guaranteed compose clips", () => {
    expect(isGuaranteedPipelineClip("/tmp/scene_0_slot3_guaranteed.mp4")).toBe(true);
    expect(isGuaranteedPipelineClip("/tmp/scene_0_pexels_vid123.mp4")).toBe(false);
  });

  it("fails summary when fallbacks or guaranteed clips present", () => {
    const summary = buildVoiceVisualMatchSummary(
      [
        {
          sceneIndex: 0,
          beatIndex: 0,
          beatText: "Hitler in the bunker.",
          basename: "scene_0_slot1_guaranteed.mp4",
          source: "fallback",
        },
      ],
      ["/tmp/scene_0_slot1_guaranteed.mp4", "/tmp/scene_0_pexels.mp4"],
      []
    );
    expect(summary.ok).toBe(false);
    expect(summary.fallbackBeats).toBe(1);
    expect(countGuaranteedClipsInPaths(["/tmp/scene_0_slot1_guaranteed.mp4"])).toBe(1);
    expect(summary.warnings.length).toBeGreaterThan(0);
  });

  it("passes when all beats have vision scores at threshold", () => {
    const summary = buildVoiceVisualMatchSummary(
      [
        {
          sceneIndex: 0,
          beatIndex: 0,
          beatText: "Berlin bunker.",
          basename: "scene_0_curated_a12.mp4",
          source: "archive",
          visionScore10: 9,
        },
      ],
      ["/tmp/scene_0_curated_a12.mp4"],
      []
    );
    expect(summary.ok).toBe(true);
  });

  /**
   * RONDE 64: rescue_similar is real footage that arrived on the second pass, not a degradation.
   * Counting it as one made `ok` false on every archive render — permanently false, and so
   * permanently uninformative. The split is asserted on both sides here.
   */
  it("reports a rescue-sourced beat without failing the render", () => {
    const summary = buildVoiceVisualMatchSummary(
      [
        {
          sceneIndex: 0,
          beatIndex: 1,
          beatText: "Amsterdam grachten.",
          basename: "scene_0_rescue.mp4",
          source: "rescue_similar",
          visionScore10: 9,
        },
      ],
      ["/tmp/scene_0_rescue.mp4"],
      []
    );
    expect(summary.rescueBeats).toBe(1);
    expect(summary.rescueSourcedBeats).toBe(1);
    expect(summary.degradedBeats).toBe(0);
    expect(summary.ok).toBe(true);
    expect(summary.warnings.some((w) => w.includes("echt beeld"))).toBe(true);
  });

  it("fails the render on a beat that genuinely has no picture of its own", () => {
    const summary = buildVoiceVisualMatchSummary(
      [
        {
          sceneIndex: 0,
          beatIndex: 1,
          beatText: "Amsterdam grachten.",
          basename: "extend_s0b1_123.mp4",
          source: "rescue_extend",
          visionScore10: 9,
        },
      ],
      ["/tmp/extend_s0b1_123.mp4"],
      []
    );
    expect(summary.degradedBeats).toBe(1);
    expect(summary.ok).toBe(false);
    expect(summary.warnings.some((w) => w.includes("zonder eigen beeld"))).toBe(true);
  });
});
