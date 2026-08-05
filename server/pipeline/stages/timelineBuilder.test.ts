import { describe, expect, it } from "vitest";
import { buildTimeline, buildTimelineStage } from "./timelineBuilder";

describe("Timeline Builder stage", () => {
  it("computes cumulative start/end seconds from planned scene durations only", () => {
    const timeline = buildTimeline([
      { index: 0, duration: 5 },
      { index: 1, duration: 7.5 },
      { index: 2, duration: 3 },
    ]);

    expect(timeline.entries).toEqual([
      { sceneIndex: 0, startSec: 0, endSec: 5 },
      { sceneIndex: 1, startSec: 5, endSec: 12.5 },
      { sceneIndex: 2, startSec: 12.5, endSec: 15.5 },
    ]);
    expect(timeline.totalDurationSec).toBe(15.5);
  });

  it("returns an empty timeline for no scenes", () => {
    expect(buildTimeline([])).toEqual({ entries: [], totalDurationSec: 0 });
  });

  it("is a no-op restructuring for the 1-minute (3-scene) case, matching the chunking work's regression test", () => {
    const timeline = buildTimeline([
      { index: 0, duration: 20 },
      { index: 1, duration: 19 },
      { index: 2, duration: 19 },
    ]);
    expect(timeline.totalDurationSec).toBe(58);
  });

  it("StageResult wrapper never fails for valid input", async () => {
    const result = await buildTimelineStage([{ index: 0, duration: 4 }]);
    expect(result.ok).toBe(true);
  });
});
