import { describe, expect, it } from "vitest";
import {
  maxBeatCapForVisualCadence,
  minBeatsForVisualCadence,
  sceneBeatCapForCadence,
  curatedPerfBeatsFloor,
  curatedMaxStockBeatsPerVideo,
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

  it("1-min video perf floor allows per-scene cadence", () => {
    expect(curatedPerfBeatsFloor("1")).toBeGreaterThanOrEqual(4);
    expect(curatedPerfBeatsFloor("1")).toBeLessThanOrEqual(6);
  });

  it("stock cap defaults very low per video length", () => {
    expect(curatedMaxStockBeatsPerVideo("1")).toBe(1);
    expect(curatedMaxStockBeatsPerVideo("8-10")).toBe(2);
  });
});
