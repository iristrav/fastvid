import { describe, expect, it } from "vitest";
import { assembleSceneTimeline, type BeatRenderInput } from "./timelineRenderer";
import type { TransitionInstruction } from "./types";

function transition(type: TransitionInstruction["type"], durationSec = 0.5): TransitionInstruction {
  return { type, durationSec, reason: "test" };
}

function beat(overrides: Partial<BeatRenderInput> = {}): BeatRenderInput {
  return {
    beatId: "s0-b0",
    inputLabel: "0:v",
    fragments: [{ filter: "scale=1920:1080", reason: "clip" }],
    durationSec: 4,
    transitionIn: transition("cut"),
    ...overrides,
  };
}

describe("Timeline Renderer (Phase 7)", () => {
  it("returns an empty result for a scene with no beats", () => {
    expect(assembleSceneTimeline(0, [])).toEqual({ filterComplex: "", outputLabel: "", totalDurationSec: 0 });
  });

  it("a single beat with fragments produces one prep node and no join", () => {
    const result = assembleSceneTimeline(0, [beat({ beatId: "s0-b0" })]);
    expect(result.filterComplex).toBe("[0:v]scale=1920:1080[s0_prep_s0_b0]");
    expect(result.outputLabel).toBe("s0_prep_s0_b0");
    expect(result.totalDurationSec).toBe(4);
  });

  it("a single beat with no fragments produces no node at all — output is the raw input label", () => {
    const result = assembleSceneTimeline(0, [beat({ fragments: [] })]);
    expect(result.filterComplex).toBe("");
    expect(result.outputLabel).toBe("0:v");
  });

  it("two beats joined by a hard cut use plain concat, not xfade", () => {
    const result = assembleSceneTimeline(0, [
      beat({ beatId: "s0-b0", durationSec: 4 }),
      beat({ beatId: "s0-b1", inputLabel: "1:v", durationSec: 3, transitionIn: transition("cut") }),
    ]);
    expect(result.filterComplex).toContain("concat=n=2:v=1:a=0[scene_out_s0]");
    expect(result.outputLabel).toBe("scene_out_s0");
    // Hard cut: no overlap subtracted from the running duration.
    expect(result.totalDurationSec).toBe(7);
  });

  it("two beats joined by a crossfade use xfade with the correct offset and shortened total duration", () => {
    const result = assembleSceneTimeline(0, [
      beat({ beatId: "s0-b0", durationSec: 4 }),
      beat({
        beatId: "s0-b1",
        inputLabel: "1:v",
        durationSec: 3,
        transitionIn: transition("cross_dissolve", 0.6),
      }),
    ]);
    expect(result.filterComplex).toContain("xfade=transition=dissolve:duration=0.600:offset=3.390");
    // Crossfade: the 0.6s overlap is subtracted from the naive sum (4 + 3 - 0.6 = 6.4).
    expect(result.totalDurationSec).toBeCloseTo(6.4, 5);
  });

  it("three beats chain joins in order, each using the running accumulated duration as its offset", () => {
    const result = assembleSceneTimeline(0, [
      beat({ beatId: "s0-b0", inputLabel: "0:v", durationSec: 4 }),
      beat({ beatId: "s0-b1", inputLabel: "1:v", durationSec: 3, transitionIn: transition("fade", 0.5) }),
      beat({ beatId: "s0-b2", inputLabel: "2:v", durationSec: 5, transitionIn: transition("cut") }),
    ]);
    // First join: xfade at offset 3.49 (4 - 0.5 - 0.01), producing s0_join1.
    expect(result.filterComplex).toContain("[s0_prep_s0_b0][s0_prep_s0_b1]xfade=transition=fade:duration=0.500:offset=3.490[s0_join1]");
    // Second join reads from s0_join1, not from the raw beat output directly.
    expect(result.filterComplex).toContain("[s0_join1][s0_prep_s0_b2]concat=n=2:v=1:a=0[scene_out_s0]");
    expect(result.outputLabel).toBe("scene_out_s0");
    // 4 + 3 - 0.5 = 6.5, then 6.5 + 5 (hard cut, no subtraction) = 11.5.
    expect(result.totalDurationSec).toBeCloseTo(11.5, 5);
  });

  it("scene index is embedded in every generated label so scenes never collide", () => {
    const result = assembleSceneTimeline(2, [
      beat({ beatId: "s2-b0", durationSec: 4 }),
      beat({ beatId: "s2-b1", inputLabel: "1:v", durationSec: 3, transitionIn: transition("cut") }),
    ]);
    expect(result.outputLabel).toBe("scene_out_s2");
    expect(result.filterComplex).toContain("s2_prep_s2_b0");
    expect(result.filterComplex).toContain("s2_prep_s2_b1");
  });
});
