import { describe, expect, it, vi } from "vitest";
import { planEffects } from "./effectsPlanner";

vi.mock("../../editorialReorder", () => ({ editorialReorderScene: vi.fn() }));
vi.mock("../../shotSequenceOptimizer", () => ({ optimizeShotSequence: vi.fn() }));
vi.mock("../../visualRhythmEngine", () => ({ applyVisualRhythm: vi.fn() }));

describe("Effects Planner stage", () => {
  it("sequences reorder -> shot-sequence -> rhythm and returns a combined plan, no rendering", async () => {
    const { editorialReorderScene } = await import("../../editorialReorder");
    const { optimizeShotSequence } = await import("../../shotSequenceOptimizer");
    const { applyVisualRhythm } = await import("../../visualRhythmEngine");

    vi.mocked(editorialReorderScene).mockResolvedValue({
      clips: ["b.mp4", "a.mp4"],
      beatDurations: [3, 2],
      clipBeatIndices: [1, 0],
      changesSummary: "swapped order",
    });
    vi.mocked(optimizeShotSequence).mockReturnValue({
      clips: ["b.mp4", "a.mp4"],
      beatDurations: [3, 2],
      clipBeatIndices: [1, 0],
      optimized: true,
      changes: 1,
      shotCategories: ["wide", "close-up"],
    });
    vi.mocked(applyVisualRhythm).mockReturnValue({
      beatDurations: [3.2, 1.8],
      profile: { energy: "high" } as never,
    });

    const result = await planEffects({
      sceneIndex: 0,
      sceneText: "A battle scene.",
      videoTitle: "War Documentary",
      sceneDuration: 5,
      clips: ["a.mp4", "b.mp4"],
      beatDurations: [2, 3],
      beats: [
        { index: 0, text: "First beat", holdSec: 2 },
        { index: 1, text: "Second beat", holdSec: 3 },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.clips).toEqual(["b.mp4", "a.mp4"]);
      expect(result.data.beatDurations).toEqual([3.2, 1.8]);
      expect(result.data.reorder.changesSummary).toBe("swapped order");
    }
    // Input arrays must not be mutated in place — only copies flow through the chain.
    expect(editorialReorderScene).toHaveBeenCalledTimes(1);
    expect(optimizeShotSequence).toHaveBeenCalledTimes(1);
    expect(applyVisualRhythm).toHaveBeenCalledTimes(1);
  });

  it("returns a structured error instead of throwing when reorder fails", async () => {
    const { editorialReorderScene } = await import("../../editorialReorder");
    vi.mocked(editorialReorderScene).mockRejectedValue(new Error("reorder LLM call failed"));

    const result = await planEffects({
      sceneIndex: 0,
      sceneText: "x",
      videoTitle: "T",
      sceneDuration: 1,
      clips: [],
      beatDurations: [],
    });

    expect(result.ok).toBe(false);
  });
});
