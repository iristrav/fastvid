import { describe, expect, it } from "vitest";
import { planTransition, type TransitionContext } from "./transitionPlanner";
import type { PacingProfile, VisualContinuityState } from "./types";

function ctx(shotType: TransitionContext["shotType"], subject = "subject"): TransitionContext {
  return { shotType, subject };
}

function pacing(tone: PacingProfile["tone"], cutSpeedMultiplier = 1): PacingProfile {
  return { tone, cutSpeedMultiplier, movementIntensity: 0.5, reason: "test" };
}

describe("Transition Planner (Phase 4)", () => {
  it("always cuts for the first shot in a scene", () => {
    const t = planTransition(null, ctx("medium"), pacing("neutral"));
    expect(t.type).toBe("cut");
    expect(t.durationSec).toBe(0);
  });

  it("forces a cut after two consecutive stylized transitions (overuse guard)", () => {
    const continuity: VisualContinuityState = {
      recentShotTypes: [],
      recentTransitions: ["cross_dissolve", "whip"],
      establishedSubjects: [],
    };
    const t = planTransition(ctx("medium"), ctx("wide"), pacing("exciting", 1.5), continuity);
    expect(t.type).toBe("cut");
    expect(t.reason).toContain("transition fatigue");
  });

  it("chooses match_cut for same shot type and same subject", () => {
    const t = planTransition(ctx("close_up", "Tim Cook"), ctx("close_up", "Tim Cook"), pacing("neutral"));
    expect(t.type).toBe("match_cut");
  });

  it("chooses film_burn entering archive footage from modern footage", () => {
    const t = planTransition(ctx("medium"), ctx("archive_footage"), pacing("neutral"));
    expect(t.type).toBe("film_burn");
  });

  it("chooses dip_to_black leaving archive footage back to modern footage", () => {
    const t = planTransition(ctx("archive_footage"), ctx("medium"), pacing("neutral"));
    expect(t.type).toBe("dip_to_black");
  });

  it("chooses dip_to_black entering an establishing shot under dramatic pacing", () => {
    const t = planTransition(ctx("medium"), ctx("establishing"), pacing("dramatic"));
    expect(t.type).toBe("dip_to_black");
  });

  it("chooses cut entering an establishing shot under exciting pacing", () => {
    const t = planTransition(ctx("medium"), ctx("establishing"), pacing("exciting"));
    expect(t.type).toBe("cut");
  });

  it("chooses fade entering an establishing shot under neutral pacing", () => {
    const t = planTransition(ctx("medium"), ctx("establishing"), pacing("neutral"));
    expect(t.type).toBe("fade");
  });

  it("chooses whip for a shot-type change under fast, exciting pacing", () => {
    const t = planTransition(ctx("wide"), ctx("close_up"), pacing("exciting", 1.5));
    expect(t.type).toBe("whip");
  });

  it("chooses cross_dissolve for a shot-type change under dramatic pacing", () => {
    const t = planTransition(ctx("wide"), ctx("close_up"), pacing("dramatic"));
    expect(t.type).toBe("cross_dissolve");
  });

  it("chooses cut (not a fancy transition) for a shot-type change under educational pacing", () => {
    const t = planTransition(ctx("wide"), ctx("close_up"), pacing("educational"));
    expect(t.type).toBe("cut");
  });

  it("chooses cut when the shot type doesn't change and it's not a match cut", () => {
    const t = planTransition(ctx("medium", "A"), ctx("medium", "B"), pacing("neutral"));
    expect(t.type).toBe("cut");
  });

  it("every decision carries a non-empty reason (NO RANDOMNESS requirement)", () => {
    const t = planTransition(ctx("wide"), ctx("close_up"), pacing("neutral"));
    expect(t.reason.length).toBeGreaterThan(0);
  });
});
