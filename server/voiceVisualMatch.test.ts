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
});
