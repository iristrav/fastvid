import { describe, expect, it } from "vitest";
import { classifyClipCategory, optimizeShotSequence } from "./shotSequenceOptimizer";

// classifyClipCategory falls through to beat-text keyword classification whenever no
// storyboard is cached for the given scene/beat — true by default in this test environment
// (nothing here ever populates editorialSequencePlanner's storyboard cache).
const CLOSE_UP_TEXT = "A close-up of her face, eyes wide with emotion.";
const ESTABLISHING_TEXT = "A wide aerial shot of the entire city skyline at dawn.";
const MEDIUM_TEXT = "A medium shot of two people talking in an office.";

describe("shotSequenceOptimizer", () => {
  describe("classifyClipCategory", () => {
    it("classifies from beat text when no storyboard is cached", () => {
      expect(classifyClipCategory("clip1.mp4", 0, CLOSE_UP_TEXT, 999)).toBe("close_up");
      expect(classifyClipCategory("clip2.mp4", 0, ESTABLISHING_TEXT, 999)).toBe("establishing");
    });
  });

  describe("optimizeShotSequence — cold open (Phase 9)", () => {
    it("opens the video's first scene (index 0) on the most striking shot instead of forcing an establishing shot", () => {
      const clips = ["establishing.mp4", "closeup.mp4", "medium.mp4"];
      const beats = [
        { index: 0, text: ESTABLISHING_TEXT },
        { index: 1, text: CLOSE_UP_TEXT },
        { index: 2, text: MEDIUM_TEXT },
      ];
      const result = optimizeShotSequence(0, clips, [4, 4, 4], [0, 1, 2], beats);
      expect(result.shotCategories[0]).toBe("close_up");
    });

    it("keeps the original establishing-shot-first convention for non-opening scenes", () => {
      const clips = ["establishing.mp4", "closeup.mp4", "medium.mp4"];
      const beats = [
        { index: 0, text: ESTABLISHING_TEXT },
        { index: 1, text: CLOSE_UP_TEXT },
        { index: 2, text: MEDIUM_TEXT },
      ];
      const result = optimizeShotSequence(1, clips, [4, 4, 4], [0, 1, 2], beats);
      expect(result.shotCategories[0]).not.toBe("close_up");
    });

    it("is a no-op for scenes with 0 or 1 clips regardless of scene index", () => {
      const single = optimizeShotSequence(0, ["only.mp4"], [4]);
      expect(single.optimized).toBe(false);
      expect(single.clips).toEqual(["only.mp4"]);
    });
  });
});
