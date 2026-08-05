import { describe, expect, it, vi } from "vitest";
import { generateScript } from "./scriptGenerator";
import type { EngineOutput } from "../types";

vi.mock("../../scriptEngine", () => ({
  runScriptEngineV2: vi.fn(),
}));

describe("Script Generator stage", () => {
  it("returns the full structured EngineOutput on success", async () => {
    const { runScriptEngineV2 } = await import("../../scriptEngine");
    const fakeOutput: EngineOutput = {
      markdownScript: "## Scene 1\nHello world.",
      architecture: {
        centralQuestion: "q",
        conflict: "c",
        surprises: [],
        climax: "climax",
        emotionalArc: "arc",
        conclusion: "end",
        macroLoop: "loop",
        targetAudience: "general",
        toneStyle: "documentary",
      },
      scenes: [
        {
          index: 0,
          title: "Scene 1",
          narration: "Hello world.",
          goal: "hook",
          reveal: "reveal",
          emotion: "curiosity",
          visualIntent: "wide shot",
          searchKeywords: ["hello"],
          archiveIntent: "archival footage",
          transition: "cut",
          estimatedDuration: 5,
        },
      ],
      quality: {
        storyStructure: 8,
        retention: 8,
        emotionalArc: 8,
        visualRichness: 8,
        historicalAccuracy: 8,
        sceneFlow: 8,
        overall: 8,
        passesThreshold: true,
        weaknesses: [],
      },
      title: "Test Video",
    };
    vi.mocked(runScriptEngineV2).mockResolvedValue(fakeOutput);

    const result = await generateScript({
      topic: "a test topic",
      videoType: "documentary",
      videoLength: "1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The whole point of this stage vs. the legacy generateScriptOnly: scenes survive.
      expect(result.data.scenes).toHaveLength(1);
      expect(result.data.scenes[0]!.goal).toBe("hook");
      expect(result.data.title).toBe("Test Video");
    }
  });

  it("returns a structured, non-throwing StageResult when the engine call fails", async () => {
    const { runScriptEngineV2 } = await import("../../scriptEngine");
    vi.mocked(runScriptEngineV2).mockRejectedValue(new Error("LLM invoke failed"));

    const result = await generateScript({
      topic: "a test topic",
      videoType: "documentary",
      videoLength: "1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("LLM invoke failed");
      expect(result.retryable).toBe(true);
    }
  });
});
