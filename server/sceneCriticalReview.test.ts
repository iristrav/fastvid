import { describe, expect, it, vi } from "vitest";
import { reviewClipCritical, isLikelyStillClip } from "./sceneCriticalReview";

vi.mock("./visualQualityGate", () => ({
  sceneCriticalReviewEnabled: () => false,
  minClipQualityScore: () => 8,
  scoreAdoptedClipQuality: vi.fn(),
}));

describe("sceneCriticalReview", () => {
  it("detects archive still clips", () => {
    expect(isLikelyStillClip("/tmp/scene_0_b1_curated_a42_still.mp4")).toBe(true);
    expect(isLikelyStillClip("/tmp/scene_0_pexels_1.mp4")).toBe(false);
  });

  it("passes when metadata and layout rules are satisfied", async () => {
    const result = await reviewClipCritical({
      sceneIndex: 1,
      beatIndex: 0,
      clipIndex: 0,
      clipPath: "/tmp/scene_1_b0_pexels.mp4",
      beatText: "Amsterdam has more bikes than people.",
      visualDescription: "Cyclists crossing a bridge in Amsterdam",
      keywords: ["amsterdam", "cycling"],
      searchQuery: "amsterdam cyclists bridge",
      powerWord: "Amsterdam",
      workDir: "/tmp",
    });
    expect(result.pass).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("uses beatText when visual_description is omitted", async () => {
    const result = await reviewClipCritical({
      sceneIndex: 2,
      beatIndex: 1,
      clipIndex: 0,
      clipPath: "/tmp/clip.mp4",
      beatText: "Test narration.",
      keywords: ["test"],
      searchQuery: "test broll",
      workDir: "/tmp",
    });
    expect(result.pass).toBe(true);
    expect(result.issues.some((i) => i.includes("visual_description"))).toBe(false);
  });

  it("fails when beat text and visual_description are both missing", async () => {
    const result = await reviewClipCritical({
      sceneIndex: 2,
      beatIndex: 1,
      clipIndex: 0,
      clipPath: "/tmp/clip.mp4",
      beatText: "",
      keywords: [],
      searchQuery: "",
      workDir: "/tmp",
    });
    expect(result.pass).toBe(false);
  });
});
