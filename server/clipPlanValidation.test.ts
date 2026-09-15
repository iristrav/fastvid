import { describe, expect, it } from "vitest";
import { validateGeneratedClipPlan } from "./clipPlanValidation";
import { readFileSync } from "fs";
import { join } from "path";

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
    expect(plan.overlay_position).toBe("center");
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

/**
 * RONDE 242 — A CHECK THAT CANNOT FAIL IS WORSE THAN NO CHECK.
 *
 * Three of the five checks compared a constant with its own definition:
 *
 *     const transition = STANDARD_TRANSITION;                 // …which IS "crossfade"
 *     if (transition !== "crossfade") errors.push(…);
 *
 * and the third called `extractMotionOverlayCandidates`, threw the answer away with
 * `.map(() => ({ position: overlay_position }))`, and validated the constant it had just
 * substituted — reading, to anyone skimming, as a check over real overlay data.
 *
 * `MotionOverlayPlan.position` is typed `"center"`: a literal with one inhabitant. There was no
 * real check to restore, only a pretence to remove. The cost was not the wasted call; it was the
 * success line claiming five things were verified when three of them were definitions.
 */
describe("RONDE 242 — the validator only claims what it checks", () => {
  const SRC = readFileSync(join(__dirname, "clipPlanValidation.ts"), "utf8");
  /** The function body, so the round's own comment quoting the old code does not match. */
  const body = (): string => {
    const at = SRC.indexOf("export function validateGeneratedClipPlan(");
    expect(at).toBeGreaterThan(0);
    return SRC.slice(at, SRC.indexOf("\n}\n", at));
  };

  it("no longer compares a constant with itself", () => {
    expect(body()).not.toMatch(/if \(transition !== "crossfade"\)/);
    expect(body()).not.toMatch(/if \(overlay_position !== "center"\)/);
  });

  it("and no longer computes overlay candidates in order to ignore them", () => {
    expect(body()).not.toContain("extractMotionOverlayCandidates");
    expect(SRC, "the import went with it").not.toMatch(/^\s+extractMotionOverlayCandidates,$/m);
  });

  /** The three that CAN fail are untouched — this round removed pretence, not validation. */
  it("the real checks are all still there", () => {
    const src = body();
    expect(src).toContain('errors.push("missing visual_description")');
    expect(src).toContain('errors.push("missing keywords (need at least 1)")');
    expect(src).toContain('errors.push("missing image_prompt")');
  });

  /**
   * The failure said NO_SCENES — "the script produced no scenes". It produced scenes; one clip's
   * metadata was incomplete, and a reader was sent to the wrong end of the pipeline.
   */
  it("a metadata failure is reported as a quality gate, not as a missing script", () => {
    expect(body()).toContain("PIPELINE_ERROR.QUALITY_GATE");
    expect(body()).not.toContain("PIPELINE_ERROR.NO_SCENES");
  });

  /** And the success line no longer claims the two constants were findings. */
  it("the OK line does not claim crossfade and center were verified", () => {
    const ok = body().slice(body().indexOf("[ClipValidation] OK"));
    expect(ok).toContain("image_prompt present");
    expect(ok).not.toContain("crossfade");
  });

  /** The returned shape is unchanged: callers still read both constants. */
  it("callers still get the constants in the result", () => {
    const out = validateGeneratedClipPlan({
      sceneIndex: 0, beatIndex: 0, clipPath: "/tmp/a.mp4",
      visualDescription: "a street", keywords: ["street"], searchQuery: "street",
    });
    expect(out.transition).toBe("crossfade");
    expect(out.overlay_position).toBe("center");
  });
});
