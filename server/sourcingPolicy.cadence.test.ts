import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one-minute length no longer takes the fast-short path by default — see
 * `isFastShortVideoLength`. That tuning still EXISTS and is what this file asserts, so the flag is
 * set here rather than the expectations being loosened: the behaviour is unchanged, only its
 * default is.
 */
beforeEach(() => { vi.stubEnv("FAST_SHORT_PATH", "true"); });
afterEach(() => { vi.unstubAllEnvs(); });

import {
  maxBeatCapForVisualCadence,
  minBeatsForVisualCadence,
  sceneBeatCapForCadence,
  
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
});
