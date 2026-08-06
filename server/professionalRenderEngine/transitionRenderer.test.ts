import { describe, expect, it } from "vitest";
import { computeXfadeOffset, isHardCut, renderTransition } from "./transitionRenderer";
import type { TransitionInstruction, TransitionType } from "./types";

function instruction(type: TransitionType, durationSec = 0.5): TransitionInstruction {
  return { type, durationSec, reason: `test-${type}` };
}

describe("Transition Renderer (Phase 7)", () => {
  describe("isHardCut", () => {
    it("cut and match_cut are hard cuts", () => {
      expect(isHardCut("cut")).toBe(true);
      expect(isHardCut("match_cut")).toBe(true);
    });

    it("everything else is not a hard cut", () => {
      expect(isHardCut("fade")).toBe(false);
      expect(isHardCut("cross_dissolve")).toBe(false);
    });
  });

  describe("computeXfadeOffset", () => {
    it("computes prevDuration - transitionDuration when there's plenty of room", () => {
      expect(computeXfadeOffset(5, 1)).toBeCloseTo(3.99, 5);
    });

    it("clamps to 0 when the transition is longer than the previous clip", () => {
      expect(computeXfadeOffset(0.5, 2)).toBe(0);
    });
  });

  describe("renderTransition", () => {
    it("returns null for cut — no filter, caller falls back to concat", () => {
      expect(renderTransition(instruction("cut"), ["v0", "v1"], 4, "out")).toBeNull();
    });

    it("returns null for match_cut — same as a hard cut", () => {
      expect(renderTransition(instruction("match_cut"), ["v0", "v1"], 4, "out")).toBeNull();
    });

    it("cross_dissolve maps to the native 'dissolve' xfade name", () => {
      const node = renderTransition(instruction("cross_dissolve", 0.6), ["v0", "v1"], 4, "out");
      expect(node).toEqual({
        inputs: ["v0", "v1"],
        filter: "xfade=transition=dissolve:duration=0.600:offset=3.390",
        output: "out",
      });
    });

    it("fade maps to the native 'fade' xfade name", () => {
      const node = renderTransition(instruction("fade", 0.5), ["v0", "v1"], 4, "out");
      expect(node?.filter).toBe("xfade=transition=fade:duration=0.500:offset=3.490");
    });

    it("dip_to_black and dip_to_white map to fadeblack/fadewhite", () => {
      expect(renderTransition(instruction("dip_to_black", 0.4), ["v0", "v1"], 4, "out")?.filter).toContain(
        "transition=fadeblack"
      );
      expect(renderTransition(instruction("dip_to_white", 0.4), ["v0", "v1"], 4, "out")?.filter).toContain(
        "transition=fadewhite"
      );
    });

    it("blur and motion_blur both use the single native hblur primitive", () => {
      const blur = renderTransition(instruction("blur", 0.3), ["v0", "v1"], 4, "out");
      const motionBlur = renderTransition(instruction("motion_blur", 0.3), ["v0", "v1"], 4, "out");
      expect(blur?.filter).toContain("transition=hblur");
      expect(motionBlur?.filter).toContain("transition=hblur");
    });

    it("flash reuses fadewhite but caps duration at 0.15s even when the instruction asks for longer", () => {
      const node = renderTransition(instruction("flash", 1.2), ["v0", "v1"], 4, "out");
      expect(node?.filter).toBe("xfade=transition=fadewhite:duration=0.150:offset=3.840");
    });

    it("flash keeps a shorter requested duration as-is", () => {
      const node = renderTransition(instruction("flash", 0.05), ["v0", "v1"], 4, "out");
      expect(node?.filter).toContain("duration=0.050");
    });

    it("light_leak and film_burn map to distance/radial placeholders", () => {
      expect(renderTransition(instruction("light_leak", 0.4), ["v0", "v1"], 4, "out")?.filter).toContain(
        "transition=distance"
      );
      expect(renderTransition(instruction("film_burn", 0.4), ["v0", "v1"], 4, "out")?.filter).toContain(
        "transition=radial"
      );
    });

    it("whip maps to the directional wind-smear primitive", () => {
      expect(renderTransition(instruction("whip", 0.3), ["v0", "v1"], 4, "out")?.filter).toContain(
        "transition=hrwind"
      );
    });

    it("slide and push map to slideleft/coverleft", () => {
      expect(renderTransition(instruction("slide", 0.4), ["v0", "v1"], 4, "out")?.filter).toContain(
        "transition=slideleft"
      );
      expect(renderTransition(instruction("push", 0.4), ["v0", "v1"], 4, "out")?.filter).toContain(
        "transition=coverleft"
      );
    });

    it("passes inputs and output labels through unchanged", () => {
      const node = renderTransition(instruction("fade", 0.5), ["clip_a", "clip_b"], 4, "merged_out");
      expect(node?.inputs).toEqual(["clip_a", "clip_b"]);
      expect(node?.output).toBe("merged_out");
    });
  });
});
