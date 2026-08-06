import { describe, expect, it } from "vitest";
import { reviewShots } from "./shotReviewer";
import { flattenEDLs } from "./types";
import { beatsOfShotTypes, makeEDL } from "./testFixtures";

describe("Shot Reviewer (Phase 6)", () => {
  it("scores well for a varied shot sequence including close-up and wide", () => {
    const beats = flattenEDLs([
      makeEDL(0, beatsOfShotTypes(0, ["establishing", "medium", "close_up", "reaction", "detail"])),
    ]);
    const result = reviewShots(beats);
    expect(result.score.score).toBeGreaterThan(80);
    expect(result.problems).toEqual([]);
  });

  it("flags repeated shot types run as low_visual_variety", () => {
    const beats = flattenEDLs([makeEDL(0, beatsOfShotTypes(0, ["medium", "medium", "medium", "medium"]))]);
    const result = reviewShots(beats);
    expect(result.problems.some((p) => p.type === "low_visual_variety")).toBe(true);
    expect(result.score.issue).toContain("consecutive");
  });

  it("flags missing close-up shots", () => {
    const beats = flattenEDLs([makeEDL(0, beatsOfShotTypes(0, ["establishing", "wide", "medium", "b_roll"]))]);
    const result = reviewShots(beats);
    expect(result.problems.some((p) => p.description.includes("No close-up"))).toBe(true);
  });

  it("flags missing wide/establishing shots for a longer video", () => {
    const beats = flattenEDLs([makeEDL(0, beatsOfShotTypes(0, ["close_up", "detail", "close_up", "detail"]))]);
    const result = reviewShots(beats);
    expect(result.problems.some((p) => p.description.includes("No establishing"))).toBe(true);
  });

  it("handles zero beats gracefully", () => {
    const result = reviewShots([]);
    expect(result.score.score).toBe(50);
    expect(result.problems).toEqual([]);
  });

  it("every problem carries scene/beat localization and non-empty evidence", () => {
    const beats = flattenEDLs([makeEDL(2, beatsOfShotTypes(2, ["medium", "medium", "medium"]))]);
    const result = reviewShots(beats);
    const repeated = result.problems.find((p) => p.type === "low_visual_variety" && p.sceneIndex !== undefined);
    expect(repeated).toBeDefined();
    expect(repeated!.sceneIndex).toBe(2);
    expect(repeated!.evidence.length).toBeGreaterThan(0);
  });
});
