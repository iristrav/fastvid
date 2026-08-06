import { describe, expect, it } from "vitest";
import { renderImageOverlayNode, renderMotionGraphicFragments, requiresImageAsset } from "./motionGraphicsRenderer";
import type { MotionGraphicInstruction, MotionGraphicType } from "./types";

const DIMS = { width: 1920, height: 1080 };

function instruction(graphicType: MotionGraphicType, data: Record<string, unknown> = {}): MotionGraphicInstruction {
  return { graphicType, data, startSec: 2, durationSec: 3, reason: `test-${graphicType}` };
}

describe("Motion Graphics Renderer (Phase 7)", () => {
  describe("requiresImageAsset", () => {
    it("map, timeline, and animated_icon require an image asset", () => {
      expect(requiresImageAsset("map")).toBe(true);
      expect(requiresImageAsset("timeline")).toBe(true);
      expect(requiresImageAsset("animated_icon")).toBe(true);
    });

    it("the other 6 types do not require an image asset", () => {
      const pure: MotionGraphicType[] = ["progress_bar", "statistic_counter", "chart", "comparison", "animated_icon" as never, "highlight_box", "arrow"].filter(
        (t) => t !== "animated_icon"
      ) as MotionGraphicType[];
      for (const t of pure) expect(requiresImageAsset(t)).toBe(false);
    });
  });

  describe("renderImageOverlayNode", () => {
    it("builds the proven overlay=0:0:enable=between(...) template", () => {
      const node = renderImageOverlayNode(instruction("map"), ["base", "png0"], "out");
      expect(node).toEqual({
        inputs: ["base", "png0"],
        filter: "overlay=0:0:enable='between(t,2.000,5.000)'",
        output: "out",
      });
    });
  });

  describe("renderMotionGraphicFragments", () => {
    it("returns an empty array for asset-based types — callers must use renderImageOverlayNode instead", () => {
      expect(renderMotionGraphicFragments(instruction("map"), DIMS)).toEqual([]);
      expect(renderMotionGraphicFragments(instruction("timeline"), DIMS)).toEqual([]);
      expect(renderMotionGraphicFragments(instruction("animated_icon"), DIMS)).toEqual([]);
    });

    it("progress_bar emits a track and a fill drawbox", () => {
      const frags = renderMotionGraphicFragments(instruction("progress_bar", { fromValue: 0, toValue: 1 }), DIMS);
      expect(frags).toHaveLength(2);
      expect(frags[0]!.filter).toContain("drawbox=");
      expect(frags[0]!.filter).toContain("color=0x00000099");
      expect(frags[1]!.filter).toContain("color=0xFFD54F");
      expect(frags[1]!.filter).toContain("w='672*(0+(1-0)*sin(");
    });

    it("highlight_box emits a single outline drawbox using normalized region data", () => {
      const frags = renderMotionGraphicFragments(
        instruction("highlight_box", { normX: 0.1, normY: 0.2, normW: 0.3, normH: 0.4 }),
        DIMS
      );
      expect(frags).toHaveLength(1);
      expect(frags[0]!.filter).toBe(
        "drawbox=x='w*0.1':y='h*0.2':w='w*0.3':h='h*0.4':color=0xFFD54F:t=4:enable='between(t,2.000,5.000)'"
      );
    });

    it("arrow renders the correct Unicode glyph per direction", () => {
      const right = renderMotionGraphicFragments(instruction("arrow", { direction: "right" }), DIMS)[0]!.filter;
      const up = renderMotionGraphicFragments(instruction("arrow", { direction: "up" }), DIMS)[0]!.filter;
      expect(right).toContain("text='→'");
      expect(up).toContain("text='↑'");
    });

    it("arrow defaults to 'right' for an unrecognized or missing direction", () => {
      const frag = renderMotionGraphicFragments(instruction("arrow", {}), DIMS)[0]!.filter;
      expect(frag).toContain("text='→'");
    });

    it("statistic_counter uses drawtext's %{eif:...:d} numeric text-expansion syntax", () => {
      const frag = renderMotionGraphicFragments(
        instruction("statistic_counter", { fromValue: 0, toValue: 500, suffix: "+" }),
        DIMS
      )[0]!.filter;
      expect(frag).toContain("text='%{eif\\:0+(500-0)*sin(");
      expect(frag).toContain("\\:d}+'");
    });

    it("comparison emits four drawtext fragments (two labels, two values)", () => {
      const frags = renderMotionGraphicFragments(
        instruction("comparison", { leftLabel: "1990", leftValue: "12%", rightLabel: "2020", rightValue: "68%" }),
        DIMS
      );
      expect(frags).toHaveLength(4);
      expect(frags.map((f) => f.filter).join("|")).toContain("text='12%'");
      expect(frags.map((f) => f.filter).join("|")).toContain("text='68%'");
    });

    it("chart emits one drawbox bar per series entry", () => {
      const frags = renderMotionGraphicFragments(
        instruction("chart", { series: [{ label: "A", value: 10 }, { label: "B", value: 20 }, { label: "C", value: 5 }] }),
        DIMS
      );
      expect(frags).toHaveLength(3);
      for (const f of frags) expect(f.filter).toContain("drawbox=");
    });

    it("chart returns an empty array when there is no series data", () => {
      expect(renderMotionGraphicFragments(instruction("chart", {}), DIMS)).toEqual([]);
    });

    it("every fragment carries the instruction's reason through unchanged", () => {
      const frags = renderMotionGraphicFragments(instruction("progress_bar"), DIMS);
      expect(frags.every((f) => f.reason === "test-progress_bar")).toBe(true);
    });
  });
});
