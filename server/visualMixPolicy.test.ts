import { describe, expect, it } from "vitest";
import { classifyClipMixKind } from "./visualMixPolicy";

describe("visualMixPolicy", () => {

  it("classifies clip paths", () => {
    expect(classifyClipMixKind("/tmp/scene_0_b0_hist_archive_titanic.mp4")).toBe("real_video");
    expect(classifyClipMixKind("/tmp/scene_1_force_serp_serp_0.mp4")).toBe("photo");
    expect(classifyClipMixKind("/tmp/scene_0_b0_pexels_vid123.mp4")).toBe("stock");
    expect(classifyClipMixKind("/tmp/scene_2_b1_scr_headline_0.mp4")).toBe("screenshot");
    expect(classifyClipMixKind("/tmp/scene_0_b0_ai_mgfx.mp4")).toBe("motion_graphics");
  });
});
