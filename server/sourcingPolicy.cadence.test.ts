import { describe, expect, it } from "vitest";
import {
  maxBeatCapForVisualCadence,
  minBeatsForVisualCadence,
  sceneBeatCapForCadence,
  sceneBeatCapForCadenceForVideo,
  curatedPerfBeatsFloor,
  curatedMaxStockBeatsPerVideo,
  curatedAiFallbackMaxClips,
  archiveMinVideoClipsTarget,
  archiveMaxImageClipsPerVideo,
  archiveOpeningVideoBeatsTarget,
} from "./sourcingPolicy";

describe("visual cadence (5–8s per clip)", () => {
  it("20s scene needs 3–4 beats", () => {
    expect(minBeatsForVisualCadence(20)).toBe(3);
    expect(maxBeatCapForVisualCadence(20)).toBe(4);
    expect(sceneBeatCapForCadence(20)).toBe(4);
  });

  it("27s scene keeps ~5–8s holds", () => {
    const cap = sceneBeatCapForCadence(27);
    expect(cap).toBeGreaterThanOrEqual(4);
    expect(cap).toBeLessThanOrEqual(6);
    expect(27 / cap).toBeGreaterThanOrEqual(4.5);
    expect(27 / cap).toBeLessThanOrEqual(8);
  });

  it("1-min video perf floor: one beat per ~20s scene (fast path)", () => {
    expect(sceneBeatCapForCadenceForVideo(20, 1, "1")).toBe(1);
    expect(curatedPerfBeatsFloor("1")).toBe(1);
  });

  it("long-form 20s scene still needs 3–4 beats", () => {
    expect(sceneBeatCapForCadenceForVideo(20, 1, "8-10")).toBe(4);
  });

  it("stock cap defaults very low per video length (strict visual focus)", () => {
    expect(curatedMaxStockBeatsPerVideo("1")).toBe(6);
    expect(curatedMaxStockBeatsPerVideo("8-10")).toBe(2);
    expect(curatedAiFallbackMaxClips("1")).toBe(0);
    expect(archiveMaxImageClipsPerVideo("1")).toBe(3);
    expect(archiveMinVideoClipsTarget("1")).toBe(1);
    expect(archiveOpeningVideoBeatsTarget("1")).toBe(1);
  });
});
