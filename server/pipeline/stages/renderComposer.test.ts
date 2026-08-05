import { describe, expect, it, vi } from "vitest";
import { composeScene } from "./renderComposer";
import type { Scene } from "../types";

vi.mock("../../videoPipeline", () => ({
  composeSceneVideoInner: vi.fn(),
}));

const scene: Scene = {
  index: 0,
  text: "A test scene.",
  visualCue: "",
  pexelsQuery: "",
  aiImagePrompt: "",
  duration: 5,
};

describe("Render Composer stage", () => {
  it("delegates to composeSceneVideoInner and returns the output path", async () => {
    const { composeSceneVideoInner } = await import("../../videoPipeline");
    vi.mocked(composeSceneVideoInner).mockResolvedValue("/tmp/fastvid_test/scene_0_composed.mp4");

    const result = await composeScene({
      scene,
      clips: ["clip1.mp4"],
      audioPath: "/tmp/fastvid_test/scene_0_audio.mp3",
      duration: 5,
      workDir: "/tmp/fastvid_test",
      totalScenes: 3,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.outputPath).toBe("/tmp/fastvid_test/scene_0_composed.mp4");
    }
  });

  it("returns a structured error instead of throwing when composing fails", async () => {
    const { composeSceneVideoInner } = await import("../../videoPipeline");
    vi.mocked(composeSceneVideoInner).mockRejectedValue(new Error("resource temporarily unavailable"));

    const result = await composeScene({
      scene,
      clips: [],
      audioPath: "a.mp3",
      duration: 5,
      workDir: "/tmp",
      totalScenes: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
    }
  });
});
