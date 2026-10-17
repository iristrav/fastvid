import { describe, expect, it } from "vitest";
import { CHAPTER_DIP_SEC, planTransition, type TransitionContext } from "./transitionPlanner";
import type { PacingProfile, VisualContinuityState } from "./types";

function ctx(shotType: TransitionContext["shotType"], subject = "subject", where: Partial<TransitionContext> = {}): TransitionContext {
  return { shotType, subject, ...where };
}

function pacing(tone: PacingProfile["tone"], cutSpeedMultiplier = 1): PacingProfile {
  return { tone, cutSpeedMultiplier, movementIntensity: 0.5, reason: "test" };
}

const after = (...recentTransitions: string[]): VisualContinuityState => ({ recentShotTypes: [], recentTransitions, establishedSubjects: [] });

/**
 * VIDEO 663 — dissolves where a documentary editor puts them: a dip through black between chapters,
 * a dissolve for a jump in time or place, a hard cut everywhere else inside a scene.
 */
describe("Transition Planner (Phase 4, VIDEO 663)", () => {
  it("cuts for the first shot of the film's first scene", () => {
    const t = planTransition(null, ctx("medium"), pacing("neutral"));
    expect(t.type).toBe("cut");
    expect(t.durationSec).toBe(0);
  });

  it("opens every later chapter with a short dip through black", () => {
    const t = planTransition(null, ctx("establishing"), pacing("neutral"), undefined, { chapterStart: true });
    expect(t.type).toBe("dip_to_black");
    expect(t.durationSec).toBe(CHAPTER_DIP_SEC);
    expect(CHAPTER_DIP_SEC).toBeLessThanOrEqual(0.5);
  });

  it("cuts inside a scene when time and place stay the same — even when the shot type changes", () => {
    for (const tone of ["neutral", "dramatic", "exciting", "educational"] as const) {
      const t = planTransition(ctx("medium", "a", { location: "Los Angeles" }), ctx("wide", "b", { location: "Los Angeles" }), pacing(tone, 1.5));
      expect(t.type, tone).toBe("cut");
    }
  });

  it("chooses match_cut for same shot type and same subject", () => {
    const t = planTransition(ctx("close_up", "Tim Cook"), ctx("close_up", "Tim Cook"), pacing("neutral"));
    expect(t.type).toBe("match_cut");
  });

  it("dissolves into and out of archival footage: a jump in time", () => {
    expect(planTransition(ctx("medium"), ctx("archive_footage"), pacing("neutral")).type).toBe("cross_dissolve");
    expect(planTransition(ctx("archive_footage"), ctx("medium"), pacing("neutral")).type).toBe("cross_dissolve");
  });

  it("dissolves for another named time", () => {
    const t = planTransition(ctx("medium", "a", { time: "1945" }), ctx("medium", "b", { time: "2024" }), pacing("neutral"));
    expect(t.type).toBe("cross_dissolve");
    expect(t.reason).toContain("1945");
  });

  it("dissolves for another named place; cuts there under exciting pacing", () => {
    const from = ctx("medium", "a", { location: "Los Angeles" });
    const to = ctx("wide", "b", { location: "Brussels" });
    expect(planTransition(from, to, pacing("neutral")).type).toBe("cross_dissolve");
    expect(planTransition(from, to, pacing("dramatic")).type).toBe("cross_dissolve");
    expect(planTransition(from, to, pacing("exciting")).type).toBe("cut");
  });

  it("an unnamed place or time is never a jump", () => {
    const t = planTransition(ctx("medium", "a", { location: "Los Angeles" }), ctx("wide", "b", { location: "" }), pacing("neutral"));
    expect(t.type).toBe("cut");
  });

  it("never two soft transitions in a row", () => {
    const t = planTransition(ctx("medium", "a", { location: "Los Angeles" }), ctx("wide", "b", { location: "Brussels" }), pacing("neutral"), after("cross_dissolve"));
    expect(t.type).toBe("cut");
    expect(planTransition(ctx("medium", "a", { location: "Los Angeles" }), ctx("wide", "b", { location: "Brussels" }), pacing("neutral"), after("cut")).type).toBe("cross_dissolve");
  });

  it("plans no whip, slide, film burn or plain fade any more", () => {
    const tones = ["neutral", "dramatic", "exciting", "educational"] as const;
    const shots = ["medium", "wide", "establishing", "archive_footage", "reaction", "cutaway", "close_up"] as const;
    for (const tone of tones)
      for (const a of shots)
        for (const b of shots) {
          const t = planTransition(ctx(a, "x", { location: "A" }), ctx(b, "y", { location: "B" }), pacing(tone, 1.5));
          expect(["cut", "match_cut", "cross_dissolve"]).toContain(t.type);
        }
  });
});
