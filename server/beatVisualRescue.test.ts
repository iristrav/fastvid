import { afterEach, describe, expect, it } from "vitest";

import { beatVisualRescueEnabled, beatVisualRescueVisionFloor, beatVisualRescueAiMaxClips, maxFallbackBeatsPerVideo } from "./sourcingPolicy";
import { pipelineWallClockLimitEnabled } from "./config";

describe("beatVisualRescue", () => {
  afterEach(() => {
    delete process.env.BEAT_VISUAL_RESCUE;
    delete process.env.ALLOW_DEGRADED_VISUAL_EXPORT;
    delete process.env.BLOCK_EXPORT_ON_VISUAL_MISMATCH;
    delete process.env.BEAT_VISUAL_RESCUE_FLOOR;
    delete process.env.MAX_FALLBACK_BEATS_PER_VIDEO;
    delete process.env.STRICT_VOICE_VISUAL_MATCH;
    delete process.env.PIPELINE_WALL_CLOCK_LIMIT;
  });

  it("enables the wall-clock limit by default", () => {
    // RONDE 30: this asserted `false` and had been failing for months. The flag is opt-OUT
    // (PIPELINE_WALL_CLOCK_LIMIT !== "false"), so the default is ON; only the doc comment in
    // sourcingPolicy.ts said otherwise, and that comment is now corrected.
    expect(pipelineWallClockLimitEnabled()).toBe(true);
    process.env.PIPELINE_WALL_CLOCK_LIMIT = "false";
    expect(pipelineWallClockLimitEnabled()).toBe(false);
    // The original left PIPELINE_WALL_CLOCK_LIMIT set for every later test in this process.
    delete process.env.PIPELINE_WALL_CLOCK_LIMIT;
  });
});
