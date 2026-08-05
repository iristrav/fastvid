import { describe, expect, it, vi } from "vitest";
import { planVisuals } from "./visualPlanner";
import type { VideoBlueprint } from "../types";

vi.mock("../../masterDocumentaryDirector", () => ({
  createVideoBlueprint: vi.fn(),
}));

describe("Visual Planner stage", () => {
  it("returns the blueprint produced by the underlying planner, no media downloaded", async () => {
    const { createVideoBlueprint } = await import("../../masterDocumentaryDirector");
    const fakeBlueprint: VideoBlueprint = {
      videoId: "42",
      videoTitle: "Test Video",
      narrativeSummary: "A test summary",
      actDirections: { intro: "", setup: "", conflict: "", climax: "", resolution: "" },
      visualBudget: {
        archive_video: 0.5,
        archive_photo: 0.2,
        map: 0.1,
        animation: 0.1,
        live_footage: 0.05,
        aerial: 0.025,
        close_up: 0.025,
        infographic: 0,
      },
      beatDirectives: new Map(),
      visualCallbacks: [],
      soundDesign: [],
      textOverlays: [],
      animations: [],
      createdAt: new Date().toISOString(),
    };
    vi.mocked(createVideoBlueprint).mockResolvedValue(fakeBlueprint);

    const result = await planVisuals({
      videoId: "42",
      videoTitle: "Test Video",
      videoLengthMin: 1,
      scenes: [{ index: 0, text: "Hello" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.blueprint.videoTitle).toBe("Test Video");
    }
    // The whole point of "no media downloading": only the planner is called, nothing else.
    expect(createVideoBlueprint).toHaveBeenCalledTimes(1);
  });

  it("returns a structured error instead of throwing when planning fails", async () => {
    const { createVideoBlueprint } = await import("../../masterDocumentaryDirector");
    vi.mocked(createVideoBlueprint).mockRejectedValue(new Error("blueprint LLM call failed"));

    const result = await planVisuals({
      videoId: "1",
      videoTitle: "T",
      videoLengthMin: 1,
      scenes: [],
    });

    expect(result.ok).toBe(false);
  });
});
