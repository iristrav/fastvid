import { describe, expect, it } from "vitest";
import { reviewPacing } from "./pacingReviewer";
import { flattenEDLs } from "./types";
import { makeDecision, makeEDL } from "./testFixtures";

function clip(startSec: number, endSec: number) {
  return { candidateId: "c", assetType: "video" as const, localPath: null, remoteUrl: null, trimStartSec: 0, trimEndSec: endSec - startSec, startSec, endSec, timingSource: "proportional_estimate" as const };
}

describe("Pacing Reviewer (Phase 6)", () => {
  it("scores well for varied durations and mixed camera movement", () => {
    const decisions = [
      makeDecision({ beatId: "b0", clip: clip(0, 3), camera: { movement: "slow_push", intensity: 0.5, reason: "test" } }),
      makeDecision({ beatId: "b1", clip: clip(3, 7.5), shot: { shotType: "close_up", reason: "test" }, camera: { movement: "zoom_in", intensity: 0.5, reason: "test" } }),
      makeDecision({ beatId: "b2", clip: clip(7.5, 9.5), shot: { shotType: "wide", reason: "test" }, camera: { movement: "pan_left", intensity: 0.5, reason: "test" } }),
      makeDecision({ beatId: "b3", clip: clip(9.5, 14), shot: { shotType: "reaction", reason: "test" }, camera: { movement: "camera_hold", intensity: 0, reason: "test" } }),
    ];
    const beats = flattenEDLs([makeEDL(0, decisions)]);
    const result = reviewPacing(beats);
    expect(result.score.score).toBeGreaterThan(70);
  });

  it("flags near-uniform clip durations as poor_timing", () => {
    const decisions = Array.from({ length: 6 }, (_, i) => makeDecision({ beatId: `b${i}`, clip: clip(i * 4, i * 4 + 4) }));
    const beats = flattenEDLs([makeEDL(0, decisions)]);
    const result = reviewPacing(beats);
    expect(result.problems.some((p) => p.type === "poor_timing")).toBe(true);
  });

  it("flags a long static section (same shot type + camera_hold repeated)", () => {
    const decisions = Array.from({ length: 4 }, (_, i) =>
      makeDecision({
        beatId: `b${i}`,
        clip: clip(i * 3, i * 3 + 2 + i * 0.3),
        shot: { shotType: "medium", reason: "test" },
        camera: { movement: "camera_hold", intensity: 0, reason: "test" },
      })
    );
    const beats = flattenEDLs([makeEDL(0, decisions)]);
    const result = reviewPacing(beats);
    expect(result.problems.some((p) => p.type === "long_static_section")).toBe(true);
  });

  it("does not flag a static run that spans two different scenes", () => {
    const decisions = [
      ...Array.from({ length: 2 }, (_, i) =>
        makeDecision({ beatId: `s0b${i}`, sceneIndex: 0, clip: clip(i * 3, i * 3 + 2), camera: { movement: "camera_hold", intensity: 0, reason: "test" } })
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeDecision({ beatId: `s1b${i}`, sceneIndex: 1, clip: clip(i * 3, i * 3 + 2.5), camera: { movement: "camera_hold", intensity: 0, reason: "test" } })
      ),
    ];
    const beats = flattenEDLs([makeEDL(0, decisions.slice(0, 2)), makeEDL(1, decisions.slice(2))]);
    const result = reviewPacing(beats);
    expect(result.problems.some((p) => p.type === "long_static_section")).toBe(false);
  });

  it("flags too_little_movement when nearly every beat is camera_hold", () => {
    const decisions = Array.from({ length: 8 }, (_, i) =>
      makeDecision({
        beatId: `b${i}`,
        clip: clip(i * 3, i * 3 + 2 + (i % 3)),
        shot: { shotType: i % 2 === 0 ? "medium" : "wide", reason: "test" },
        camera: { movement: "camera_hold", intensity: 0, reason: "test" },
      })
    );
    const beats = flattenEDLs([makeEDL(0, decisions)]);
    const result = reviewPacing(beats);
    expect(result.problems.some((p) => p.type === "too_little_movement")).toBe(true);
  });

  it("flags repeated_camera_movement for the same active movement 3+ times in a row", () => {
    const decisions = Array.from({ length: 4 }, (_, i) =>
      makeDecision({
        beatId: `b${i}`,
        clip: clip(i * 3, i * 3 + 2 + (i % 2)),
        shot: { shotType: i % 2 === 0 ? "medium" : "wide", reason: "test" },
        camera: { movement: "slow_push", intensity: 0.5, reason: "test" },
      })
    );
    const beats = flattenEDLs([makeEDL(0, decisions)]);
    const result = reviewPacing(beats);
    expect(result.problems.some((p) => p.type === "repeated_camera_movement")).toBe(true);
  });

  it("does not flag repeated camera_hold as repeated_camera_movement (that's too_little_movement's concern)", () => {
    const decisions = Array.from({ length: 4 }, (_, i) =>
      makeDecision({
        beatId: `b${i}`,
        clip: clip(i * 3, i * 3 + 2 + (i % 2)),
        shot: { shotType: i % 2 === 0 ? "medium" : "wide", reason: "test" },
        camera: { movement: "camera_hold", intensity: 0, reason: "test" },
      })
    );
    const beats = flattenEDLs([makeEDL(0, decisions)]);
    const result = reviewPacing(beats);
    expect(result.problems.some((p) => p.type === "repeated_camera_movement")).toBe(false);
  });

  it("handles zero beats gracefully", () => {
    const result = reviewPacing([]);
    expect(result.score.score).toBe(50);
  });
});
