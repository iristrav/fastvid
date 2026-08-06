import { describe, expect, it } from "vitest";
import { reviewTransitions } from "./transitionReviewer";
import { flattenEDLs } from "./types";
import { beatsOfTransitions, makeEDL } from "./testFixtures";

describe("Transition Reviewer (Phase 6)", () => {
  it("scores well for a healthy mix of cuts and occasional stylized transitions", () => {
    const beats = flattenEDLs([makeEDL(0, beatsOfTransitions(0, ["cut", "cut", "cross_dissolve", "cut", "cut", "whip"]))]);
    const result = reviewTransitions(beats);
    expect(result.score.score).toBeGreaterThan(80);
    expect(result.problems).toEqual([]);
  });

  it("flags 3+ consecutive identical non-cut transitions as repeated_transition", () => {
    const beats = flattenEDLs([makeEDL(0, beatsOfTransitions(0, ["cut", "whip", "whip", "whip", "cut"]))]);
    const result = reviewTransitions(beats);
    expect(result.problems.some((p) => p.type === "repeated_transition")).toBe(true);
  });

  it("does not flag consecutive plain cuts as repeated (cut is the safe default)", () => {
    const beats = flattenEDLs([makeEDL(0, beatsOfTransitions(0, ["cut", "cut", "cut", "cut", "cut"]))]);
    const result = reviewTransitions(beats);
    expect(result.problems.some((p) => p.type === "repeated_transition")).toBe(false);
  });

  it("flags near-total plain-cut monotony in a longer video", () => {
    const beats = flattenEDLs([
      makeEDL(0, beatsOfTransitions(0, ["cut", "cut", "cut", "cut", "cut", "cut", "cut", "cross_dissolve"])),
    ]);
    const result = reviewTransitions(beats);
    expect(result.score.issue).toContain("no transition variety");
  });

  it("flags transition overuse when plain cuts are rare", () => {
    const beats = flattenEDLs([makeEDL(0, beatsOfTransitions(0, ["fade", "whip", "cross_dissolve", "slide", "film_burn"]))]);
    const result = reviewTransitions(beats);
    expect(result.score.issue).toContain("overused");
  });

  it("handles zero beats gracefully", () => {
    const result = reviewTransitions([]);
    expect(result.score.score).toBe(50);
  });
});
