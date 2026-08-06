import { describe, expect, it } from "vitest";
import { reviewNarrative } from "./narrativeReviewer";
import { makeDirectorDecision } from "./testFixtures";

describe("Narrative Reviewer (Phase 6)", () => {
  it("scores well for a video with establish -> explain -> climax -> resolve arc and varied emotion", () => {
    const decisions = [
      makeDirectorDecision({ sceneIndex: 0, narrativeFunction: "establish", emotion: "curiosity" }),
      makeDirectorDecision({ sceneIndex: 1, narrativeFunction: "explain", emotion: "curiosity" }),
      makeDirectorDecision({ sceneIndex: 2, narrativeFunction: "climax", emotion: "triumph" }),
      makeDirectorDecision({ sceneIndex: 3, narrativeFunction: "resolve", emotion: "hope" }),
    ];
    const result = reviewNarrative(decisions);
    expect(result.scores.narrativeClarity.score).toBeGreaterThan(85);
    expect(result.scores.emotionalFlow.score).toBeGreaterThan(85);
    expect(result.problems).toEqual([]);
  });

  it("flags a weak opening when scene 0 isn't establish/transition", () => {
    const decisions = [
      makeDirectorDecision({ sceneIndex: 0, narrativeFunction: "explain" }),
      makeDirectorDecision({ sceneIndex: 1, narrativeFunction: "resolve" }),
    ];
    const result = reviewNarrative(decisions);
    expect(result.problems.some((p) => p.type === "weak_opening")).toBe(true);
  });

  it("flags a weak ending when the last scene isn't resolve", () => {
    const decisions = [
      makeDirectorDecision({ sceneIndex: 0, narrativeFunction: "establish" }),
      makeDirectorDecision({ sceneIndex: 1, narrativeFunction: "explain" }),
    ];
    const result = reviewNarrative(decisions);
    expect(result.problems.some((p) => p.type === "weak_ending")).toBe(true);
  });

  it("flags low emotional variation when every scene shares the same emotion", () => {
    const decisions = [
      makeDirectorDecision({ sceneIndex: 0, narrativeFunction: "establish", emotion: "neutral" }),
      makeDirectorDecision({ sceneIndex: 1, narrativeFunction: "explain", emotion: "neutral" }),
      makeDirectorDecision({ sceneIndex: 2, narrativeFunction: "resolve", emotion: "neutral" }),
    ];
    const result = reviewNarrative(decisions);
    expect(result.problems.some((p) => p.type === "low_emotional_variation")).toBe(true);
  });

  it("does not flag emotional flatness for short videos (fewer than 3 scenes)", () => {
    const decisions = [
      makeDirectorDecision({ sceneIndex: 0, narrativeFunction: "establish", emotion: "neutral" }),
      makeDirectorDecision({ sceneIndex: 1, narrativeFunction: "resolve", emotion: "neutral" }),
    ];
    const result = reviewNarrative(decisions);
    expect(result.problems.some((p) => p.type === "low_emotional_variation")).toBe(false);
  });

  it("handles zero scenes gracefully", () => {
    const result = reviewNarrative([]);
    expect(result.scores.narrativeClarity.score).toBe(50);
    expect(result.scores.emotionalFlow.score).toBe(50);
  });
});
