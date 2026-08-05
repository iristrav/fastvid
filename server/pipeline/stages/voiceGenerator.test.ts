import { describe, expect, it, vi } from "vitest";
import { generateVoice } from "./voiceGenerator";
import type { Scene } from "../types";

vi.mock("../../videoPipeline", () => ({
  generateBulkSceneVoiceovers: vi.fn(),
}));

function makeScene(index: number, text: string): Scene {
  return {
    index,
    text,
    visualCue: "",
    pexelsQuery: "",
    aiImagePrompt: "",
    duration: 5,
  };
}

describe("Voice Generator stage", () => {
  it("builds audioPaths using the legacy scene_N_audio.mp3 convention and returns durations", async () => {
    const { generateBulkSceneVoiceovers } = await import("../../videoPipeline");
    vi.mocked(generateBulkSceneVoiceovers).mockResolvedValue([4.2, 5.8]);

    const result = await generateVoice({
      scenes: [makeScene(0, "Hello"), makeScene(1, "World")],
      workDir: "/tmp/fastvid_test",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.audioPaths).toEqual([
        "/tmp/fastvid_test/scene_0_audio.mp3",
        "/tmp/fastvid_test/scene_1_audio.mp3",
      ]);
      expect(result.data.durations).toEqual([4.2, 5.8]);
    }
    expect(generateBulkSceneVoiceovers).toHaveBeenCalledWith(
      expect.any(Array),
      ["/tmp/fastvid_test/scene_0_audio.mp3", "/tmp/fastvid_test/scene_1_audio.mp3"],
      "/tmp/fastvid_test",
      undefined,
      undefined,
      undefined
    );
  });

  it("returns a structured error instead of throwing when synthesis fails", async () => {
    const { generateBulkSceneVoiceovers } = await import("../../videoPipeline");
    vi.mocked(generateBulkSceneVoiceovers).mockRejectedValue(new Error("ElevenLabs quota exceeded"));

    const result = await generateVoice({ scenes: [makeScene(0, "Hi")], workDir: "/tmp/fastvid_test" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("ElevenLabs quota exceeded");
      expect(result.retryable).toBe(true);
    }
  });
});
