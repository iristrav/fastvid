import { describe, expect, it } from "vitest";
import { reviewRetention } from "./retentionReviewer";
import { makeDirectorDecision, makeDirectorOutput } from "./testFixtures";

describe("Retention Reviewer (Phase 6)", () => {
  it("scores well when no scenes are flagged at-risk and the opening is a hook segment", () => {
    const decisions = [
      makeDirectorDecision({ sceneIndex: 0, hookGuidance: { isHookSegment: true, recommendations: ["Increase energy."], reason: "test" } }),
      makeDirectorDecision({ sceneIndex: 1 }),
    ];
    const output = makeDirectorOutput(decisions, { highlightMoments: [{ sceneIndex: 0, reason: "test", suggestedFor: ["thumbnail"] }] });
    const result = reviewRetention(output);
    expect(result.score.score).toBeGreaterThan(85);
    expect(result.problems).toEqual([]);
    expect(result.score.feedback).toContain("1 high-engagement moment");
  });

  it("surfaces the AI Director's own at-risk scenes as long_static_section problems", () => {
    const decisions = [
      makeDirectorDecision({ sceneIndex: 0, hookGuidance: { isHookSegment: true, recommendations: [], reason: "test" } }),
      makeDirectorDecision({ sceneIndex: 1, retentionRisk: { isAtRisk: true, reason: "long, plain, repetitive", recommendations: ["Add variety."] } }),
    ];
    const output = makeDirectorOutput(decisions);
    const result = reviewRetention(output);
    const risk = result.problems.find((p) => p.type === "long_static_section");
    expect(risk).toBeDefined();
    expect(risk!.sceneIndex).toBe(1);
    expect(risk!.evidence).toContain("AI Director");
  });

  it("flags a weak opening when the first scene isn't a hook segment", () => {
    const decisions = [makeDirectorDecision({ sceneIndex: 0, hookGuidance: { isHookSegment: false, recommendations: [], reason: "starts too late" } })];
    const output = makeDirectorOutput(decisions);
    const result = reviewRetention(output);
    expect(result.problems.some((p) => p.type === "weak_opening")).toBe(true);
  });

  it("handles zero scenes gracefully", () => {
    const result = reviewRetention(makeDirectorOutput([]));
    expect(result.score.score).toBe(50);
  });
});
