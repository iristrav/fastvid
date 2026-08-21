import { describe, expect, it } from "vitest";
import {
  reviewAssembledScenes,
  reviewPipelineBeforeExport,
  reviewSceneVisualAlignment,
  type SceneReviewInput,
} from "./pipelineReview";

describe("pipelineReview", () => {
  it("reviewSceneVisualAlignment flags empty clip list", async () => {
    const scene: SceneReviewInput = {
      index: 1,
      text: "Hitler sprak tot duizenden supporters in Berlijn.",
      duration: 8,
      clipPaths: [],
    };
    const issues = await reviewSceneVisualAlignment(scene, "Hitler in Berlijn");
    expect(issues.some((i) => i.code === "NO_CLIPS")).toBe(true);
  });

  it("reviewAssembledScenes flags missing assembly files", async () => {
    const scenes: SceneReviewInput[] = [
      { index: 0, text: "Test", duration: 6, clipPaths: ["/nope/clip.mp4"] },
    ];
    const result = await reviewAssembledScenes(scenes, ["/missing/assembly.mp4"]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "ASSEMBLY_MISSING")).toBe(true);
  });

  it("reviewPipelineBeforeExport flags missing composed output", async () => {
    const scenes: SceneReviewInput[] = [
      { index: 0, text: "Test", duration: 6, clipPaths: [] },
    ];
    const result = await reviewPipelineBeforeExport(scenes, ["/missing/composed.mp4"]);
    expect(result.ok).toBe(false);
    // RONDE 30: the summary was Dutch ("ontbreken") when this was written and is English now
    // ("Final review: N scene(s) missing"). Asserting the count and the subject rather than one
    // word, so a future rewording does not silently break the test again — what matters is that
    // the summary names how many scenes are missing.
    expect(result.summary).toMatch(/1 scene\(s\) missing/i);
  });
});
