import { describe, expect, it, afterEach } from "vitest";
import {
  pipelineProgressStallRecoveryEnabled,
  pipelineProgressStallThresholdMs,
  pipelineMaxStallRecoveries,
  pipelineWallClockLimitEnabled,
} from "./sourcingPolicy";

describe("pipelineProgressStall", () => {
  afterEach(() => {
    delete process.env.PIPELINE_PROGRESS_STALL_RECOVERY;
    delete process.env.PIPELINE_PROGRESS_STALL_MIN;
    delete process.env.PIPELINE_MAX_STALL_RECOVERIES;
    delete process.env.PIPELINE_WALL_CLOCK_LIMIT;
  });

  it("recovery enabled by default with sensible thresholds", () => {
    expect(pipelineProgressStallRecoveryEnabled()).toBe(true);
    expect(pipelineMaxStallRecoveries()).toBe(3);
    // RONDE 30: was `false`; the flag is opt-out so the real default is ON. See the note on
    // pipelineWallClockLimitEnabled in sourcingPolicy.ts.
    expect(pipelineWallClockLimitEnabled()).toBe(true);
    expect(pipelineProgressStallThresholdMs("1", "generating_script")).toBe(10 * 60_000);
    expect(pipelineProgressStallThresholdMs("1", "generating_visuals")).toBe(25 * 60_000);
    expect(pipelineProgressStallThresholdMs("1", "generating_effects")).toBe(20 * 60_000);
  });

  it("honors PIPELINE_PROGRESS_STALL_MIN override", () => {
    process.env.PIPELINE_PROGRESS_STALL_MIN = "12";
    expect(pipelineProgressStallThresholdMs("1", "generating_script")).toBe(12 * 60_000);
  });
});
