import { describe, expect, it } from "vitest";
import {
  allocateMixCounts,
  buildInterleavedMixPlan,
  classifyClipMixKind,
  DEFAULT_VISUAL_MIX_PERCENT,
  planVisualMixForBeats,
} from "./visualMixPolicy";

describe("visualMixPolicy", () => {
  it("allocates default mix for 10 beats", () => {
    const counts = allocateMixCounts(10, DEFAULT_VISUAL_MIX_PERCENT);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(10);
    expect(counts.real_video).toBe(1);
    expect(counts.photo).toBe(4);
    expect(counts.stock).toBe(2);
    expect(counts.screenshot).toBe(2);
    expect(counts.motion_graphics).toBe(1);
  });

  it("interleaves without adjacent duplicates when possible", () => {
    const plan = buildInterleavedMixPlan({
      real_video: 1,
      photo: 4,
      stock: 2,
      screenshot: 2,
      motion_graphics: 1,
    });
    expect(plan.length).toBe(10);
    for (let i = 1; i < plan.length; i++) {
      if (plan[i] === plan[i - 1]) {
        const onlyOneKindLeft = plan.filter((k) => k === plan[i]).length > 1;
        expect(onlyOneKindLeft).toBe(true);
      }
    }
  });

  it("plans full video mix", () => {
    const plan = planVisualMixForBeats(12);
    expect(plan.length).toBe(12);
    const photoSlots = plan.filter((k) => k === "photo").length;
    expect(photoSlots).toBeGreaterThanOrEqual(4);
  });

  it("classifies clip paths", () => {
    expect(classifyClipMixKind("/tmp/scene_0_b0_hist_archive_titanic.mp4")).toBe("real_video");
    expect(classifyClipMixKind("/tmp/scene_1_force_serp_serp_0.mp4")).toBe("photo");
    expect(classifyClipMixKind("/tmp/scene_0_b0_pexels_vid123.mp4")).toBe("stock");
    expect(classifyClipMixKind("/tmp/scene_2_b1_scr_headline_0.mp4")).toBe("screenshot");
    expect(classifyClipMixKind("/tmp/scene_0_b0_ai_mgfx.mp4")).toBe("motion_graphics");
  });
});
