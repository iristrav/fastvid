import { describe, expect, it } from "vitest";
import { validateGeneratedClipPlan } from "./clipPlanValidation";

describe("validateGeneratedClipPlan", () => {
  const base = {
    sceneIndex: 2,
    beatIndex: 1,
    clipPath: "/tmp/scene_2_b1_archive.mp4",
    visualDescription: "Dutch cyclists on a city street",
    keywords: ["cycling", "amsterdam"],
    searchQuery: "amsterdam cyclists street",
    beatText: "In Amsterdam, 78% of trips are by bike.",
  };

  it("passes when all required fields are present", () => {
    const plan = validateGeneratedClipPlan(base);
    expect(plan.transition).toBe("crossfade");
    expect(plan.overlay_position).toBe("bottom_left");
    expect(plan.visual_description).toContain("cyclists");
    expect(plan.image_prompt).toBe("amsterdam cyclists street");
  });

  it("stops and throws when visual_description is missing", () => {
    expect(() =>
      validateGeneratedClipPlan({ ...base, visualDescription: "", visualIntent: undefined })
    ).toThrow(/missing visual_description/);
  });

  it("stops and throws when no keywords", () => {
    expect(() => validateGeneratedClipPlan({ ...base, keywords: [] })).toThrow(/missing keywords/);
  });

  it("stops and throws when image_prompt is missing", () => {
    expect(() =>
      validateGeneratedClipPlan({ ...base, searchQuery: "", visualIntent: undefined })
    ).toThrow(/missing image_prompt/);
  });
});
