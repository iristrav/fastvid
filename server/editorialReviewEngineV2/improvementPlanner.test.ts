import { describe, expect, it } from "vitest";
import { planAutoFixes, planRecommendations } from "./improvementPlanner";
import type { Problem } from "./types";
import { makeDecision, makeEDL } from "./testFixtures";

describe("Improvement Planner (Phase 6) — Recommendations", () => {
  it("generates one recommendation per problem, matching the spec's example phrasing style", () => {
    const problems: Problem[] = [
      { type: "long_static_section", severity: "medium", sceneIndex: 3, description: "test", evidence: "test" },
      { type: "too_much_text", severity: "medium", sceneIndex: 2, description: "test", evidence: "test" },
      { type: "repeated_transition", severity: "low", sceneIndex: 1, description: "test", evidence: "test" },
    ];
    const recs = planRecommendations(problems);
    expect(recs).toHaveLength(3);
    expect(recs[0]!.recommendation).toBe("Increase pacing in Scene 3.");
    expect(recs[1]!.recommendation).toBe("Reduce text duration in Scene 2.");
    expect(recs[2]!.recommendation).toBe("Replace the repeated transition in Scene 1 with a simple cut.");
  });

  it("maps problem severity to recommendation priority", () => {
    const problems: Problem[] = [{ type: "off_topic_visual", severity: "high", description: "test", evidence: "test" }];
    const recs = planRecommendations(problems);
    expect(recs[0]!.priority).toBe("high");
  });

  it("returns an empty list for no problems", () => {
    expect(planRecommendations([])).toEqual([]);
  });
});

describe("Improvement Planner (Phase 6) — Auto Fixes", () => {
  it("generates a change_shot_type fix for a long_static_section problem", () => {
    const decision = makeDecision({ beatId: "b0", sceneIndex: 0, shot: { shotType: "medium", reason: "test" } });
    const edls = [makeEDL(0, [decision])];
    const problems: Problem[] = [{ type: "long_static_section", severity: "medium", sceneIndex: 0, beatId: "b0", description: "test", evidence: "test" }];
    const fixes = planAutoFixes(problems, edls);
    const fix = fixes.find((f) => f.type === "change_shot_type");
    expect(fix).toBeDefined();
    expect(fix!.before).toBe("medium");
    expect(fix!.reversible).toBe(true);
  });

  it("generates a change_camera_movement fix for a repeated_camera_movement problem", () => {
    const decision = makeDecision({ beatId: "b0", sceneIndex: 0, camera: { movement: "slow_push", intensity: 0.5, reason: "test" } });
    const edls = [makeEDL(0, [decision])];
    const problems: Problem[] = [{ type: "repeated_camera_movement", severity: "low", sceneIndex: 0, beatId: "b0", description: "test", evidence: "test" }];
    const fixes = planAutoFixes(problems, edls);
    expect(fixes.some((f) => f.type === "change_camera_movement" && f.before === "slow_push")).toBe(true);
  });

  it("generates a change_transition fix for a repeated_transition problem, always targeting cut", () => {
    const decision = makeDecision({ beatId: "b0", sceneIndex: 0, transitionIn: { type: "whip", durationSec: 0.25, reason: "test" } });
    const edls = [makeEDL(0, [decision])];
    const problems: Problem[] = [{ type: "repeated_transition", severity: "medium", sceneIndex: 0, beatId: "b0", description: "test", evidence: "test" }];
    const fixes = planAutoFixes(problems, edls);
    const fix = fixes.find((f) => f.type === "change_transition");
    expect(fix!.before).toBe("whip");
    expect(fix!.after).toBe("cut");
  });

  it("generates a reduce_text_duration fix for a too_much_text problem, halving the current duration", () => {
    const decision = makeDecision({
      beatId: "b0",
      sceneIndex: 0,
      captions: [{ captionType: "location", text: "x", startSec: 0, endSec: 6, animation: "fade", position: "bottom-left", reason: "test" }],
    });
    const edls = [makeEDL(0, [decision])];
    const problems: Problem[] = [{ type: "too_much_text", severity: "medium", sceneIndex: 0, beatId: "b0", description: "test", evidence: "test" }];
    const fixes = planAutoFixes(problems, edls);
    const fix = fixes.find((f) => f.type === "reduce_text_duration");
    expect(fix!.before).toBe(6);
    expect(fix!.after).toBe(3);
  });

  it("does not generate an AutoFix for problems that require new footage (repeated_footage, off_topic_visual)", () => {
    const problems: Problem[] = [
      { type: "repeated_footage", severity: "high", sceneIndex: 0, beatId: "b0", description: "test", evidence: "test" },
      { type: "off_topic_visual", severity: "medium", sceneIndex: 0, beatId: "b0", description: "test", evidence: "test" },
    ];
    const fixes = planAutoFixes(problems, [makeEDL(0, [makeDecision({ beatId: "b0", sceneIndex: 0 })])]);
    expect(fixes).toEqual([]);
  });

  it("skips generating a fix when the scene/beat can't be found in the EDL", () => {
    const problems: Problem[] = [{ type: "long_static_section", severity: "medium", sceneIndex: 9, beatId: "missing", description: "test", evidence: "test" }];
    const fixes = planAutoFixes(problems, [makeEDL(0, [makeDecision({ beatId: "b0", sceneIndex: 0 })])]);
    expect(fixes).toEqual([]);
  });

  it("every generated AutoFix is typed as reversible: true", () => {
    const decision = makeDecision({ beatId: "b0", sceneIndex: 0 });
    const problems: Problem[] = [{ type: "long_static_section", severity: "medium", sceneIndex: 0, beatId: "b0", description: "test", evidence: "test" }];
    const fixes = planAutoFixes(problems, [makeEDL(0, [decision])]);
    for (const f of fixes) expect(f.reversible).toBe(true);
  });
});
