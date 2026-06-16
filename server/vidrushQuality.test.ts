import { describe, expect, it } from "vitest";
import {
  clampVidrushClipDuration,
  enforceMontageDurationFloors,
  maxDirectorBeatsForSceneDuration,
  vidrushMinClipSec,
  vidrushOpeningClipSec,
} from "./vidrushQuality";
import { mergeDirectorScenesForPacing } from "./visualDirector";

describe("vidrushQuality", () => {
  it("enforces 3.5s opening and 3.5s minimum clip floor", () => {
    expect(vidrushOpeningClipSec()).toBeGreaterThanOrEqual(3.5);
    expect(vidrushMinClipSec()).toBeGreaterThanOrEqual(3.5);
    const durs = enforceMontageDurationFloors([0.4, 1.2, 2.0], 0);
    expect(durs[0]).toBeGreaterThanOrEqual(vidrushOpeningClipSec());
    expect(durs[1]).toBeGreaterThanOrEqual(vidrushMinClipSec());
  });

  it("caps director beats to scene duration", () => {
    expect(maxDirectorBeatsForSceneDuration(23)).toBe(6);
    expect(maxDirectorBeatsForSceneDuration(8)).toBe(2);
  });

  it("never returns below floor when scaling down", () => {
    expect(clampVidrushClipDuration(0.2, 0, 0)).toBeGreaterThanOrEqual(vidrushOpeningClipSec());
    expect(clampVidrushClipDuration(0.2, 2, 1)).toBeGreaterThanOrEqual(vidrushMinClipSec());
  });
});

describe("mergeDirectorScenesForPacing", () => {
  it("merges excess director scenes to fit max beats", () => {
    const scenes = Array.from({ length: 8 }, (_, i) => ({
      source_sentence_index: i,
      spoken_text: `Line ${i}`,
      visual_description: `Visual ${i}`,
      camera_shot: "wide shot",
      emotion: "calm",
      search_query: `query ${i}`,
    }));
    const merged = mergeDirectorScenesForPacing(scenes, 4);
    expect(merged.length).toBeLessThanOrEqual(4);
    expect(merged[0]?.spoken_text).toContain("Line 0");
  });
});
