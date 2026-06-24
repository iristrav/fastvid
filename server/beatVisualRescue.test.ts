import { describe, expect, it, afterEach } from "vitest";
import {
  allowDegradedVisualExport,
  beatVisualRescueEnabled,
  beatVisualRescueVisionFloor,
  blockExportOnVisualMismatch,
  maxFallbackBeatsPerVideo,
} from "./sourcingPolicy";

describe("beatVisualRescue", () => {
  afterEach(() => {
    delete process.env.BEAT_VISUAL_RESCUE;
    delete process.env.ALLOW_DEGRADED_VISUAL_EXPORT;
    delete process.env.BLOCK_EXPORT_ON_VISUAL_MISMATCH;
    delete process.env.BEAT_VISUAL_RESCUE_FLOOR;
    delete process.env.MAX_FALLBACK_BEATS_PER_VIDEO;
    delete process.env.STRICT_VOICE_VISUAL_MATCH;
  });

  it("enabled by default with rescue floor 5", () => {
    expect(beatVisualRescueEnabled()).toBe(true);
    expect(beatVisualRescueVisionFloor()).toBe(5);
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
});
