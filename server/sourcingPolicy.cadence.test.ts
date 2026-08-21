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

  it("1-min video uses the same cadence as every other length — no fast-path shortcut", () => {
    // RONDE 30: this asserted 1 beat per 20s scene on the 1-min fast path. That shortcut was
    // deliberately removed (see sceneBeatCapForCadenceForVideo — beat count now scales with the
    // real voiceover duration regardless of target length), but the test was never updated and
    // sat in the known-failing baseline. A 20s scene gets 4 beats at the standard 6s cadence,
    // the same answer the "8-10" case below already expects — which is the point of the change.
    expect(sceneBeatCapForCadenceForVideo(20, 1, "1")).toBe(4);
    expect(curatedPerfBeatsFloor("1")).toBe(4);
  });

  it("long-form 20s scene still needs 3–4 beats", () => {
    expect(sceneBeatCapForCadenceForVideo(20, 1, "8-10")).toBe(4);
  });

  it("stock cap defaults very low per video length (strict visual focus)", () => {
    expect(curatedMaxStockBeatsPerVideo("1")).toBe(12);
    expect(curatedMaxStockBeatsPerVideo("8-10")).toBe(2);
    expect(curatedAiFallbackMaxClips("1")).toBe(0);
    expect(archiveMaxImageClipsPerVideo("1")).toBe(3);
    expect(archiveMinVideoClipsTarget("1")).toBe(0);
    expect(archiveOpeningVideoBeatsTarget("1")).toBe(0);
  });
});
