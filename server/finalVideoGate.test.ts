import { describe, expect, it } from "vitest";
import {
  absoluteMinDurationSec,
  expectedDurationBoundsSec,
} from "./finalVideoGate";
import { isInformationalSpotWarning } from "./postRenderSpotCheck";

describe("finalVideoGate", () => {
  it("expectedDurationBoundsSec covers all length buckets", () => {
    expect(expectedDurationBoundsSec("1")).toEqual({ min: 35, max: 100 });
    expect(expectedDurationBoundsSec("8-10").min).toBeLessThan(expectedDurationBoundsSec("8-10").max);
    expect(absoluteMinDurationSec("1")).toBe(28);
  });
});

describe("isInformationalSpotWarning", () => {
  it("treats dark archive and detector warnings as non-blocking", () => {
    expect(isInformationalSpotWarning("blackdetect: 1 dark/black segment(s)")).toBe(true);
    expect(isInformationalSpotWarning("freezedetect: 4 frozen segment(s)")).toBe(true);
    expect(isInformationalSpotWarning("3/4 spot-check frames are dark (worst luma 2)")).toBe(true);
    expect(isInformationalSpotWarning("Final video appears fully black (worst luma 1)")).toBe(true);
  });

  it("blocks only missing file", () => {
    expect(isInformationalSpotWarning("Final video missing or too small")).toBe(false);
  });
});
