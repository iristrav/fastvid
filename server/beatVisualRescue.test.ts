import { describe, expect, it, afterEach } from "vitest";
import {
  allowDegradedVisualExport,
  beatVisualRescueEnabled,
  beatVisualRescueVisionFloor,
  beatVisualRescueAiMaxClips,
  blockExportOnVisualMismatch,
  maxFallbackBeatsPerVideo,
  fastShortArchivePoolMax,
  fastShortClipIndexPrewarmMax,
  isFastShortVideoLength,
  pipelineWallClockLimitEnabled,
} from "./sourcingPolicy";

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

  it("enabled by default with rescue floor 5", () => {
    expect(beatVisualRescueEnabled()).toBe(true);
    expect(beatVisualRescueVisionFloor()).toBe(5);
    expect(beatVisualRescueAiMaxClips("1")).toBe(2);
    expect(fastShortArchivePoolMax()).toBe(200);
    expect(fastShortClipIndexPrewarmMax()).toBe(48);
    expect(allowDegradedVisualExport()).toBe(true);
    expect(blockExportOnVisualMismatch()).toBe(false);
    expect(maxFallbackBeatsPerVideo()).toBe(20);
  });

  it("can disable rescue and restore strict export block", () => {
    process.env.BEAT_VISUAL_RESCUE = "false";
    process.env.STRICT_VOICE_VISUAL_MATCH = "true";
    expect(beatVisualRescueEnabled()).toBe(false);
    expect(allowDegradedVisualExport()).toBe(false);
    expect(blockExportOnVisualMismatch()).toBe(true);
    expect(maxFallbackBeatsPerVideo()).toBe(0);
  });

  it("enables the wall-clock limit by default and keeps the 1-min fast path", () => {
    // RONDE 30: this asserted `false` and had been failing for months. The flag is opt-OUT
    // (PIPELINE_WALL_CLOCK_LIMIT !== "false"), so the default is ON; only the doc comment in
    // sourcingPolicy.ts said otherwise, and that comment is now corrected.
    expect(pipelineWallClockLimitEnabled()).toBe(true);
    expect(isFastShortVideoLength("1")).toBe(true);
    process.env.PIPELINE_WALL_CLOCK_LIMIT = "false";
    expect(pipelineWallClockLimitEnabled()).toBe(false);
    expect(isFastShortVideoLength("1")).toBe(true);
    // The original left PIPELINE_WALL_CLOCK_LIMIT set for every later test in this process.
    delete process.env.PIPELINE_WALL_CLOCK_LIMIT;
  });
});
