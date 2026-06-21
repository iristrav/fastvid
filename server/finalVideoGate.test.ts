import { describe, expect, it } from "vitest";
import { expectedDurationBoundsSec } from "./finalVideoGate";
import { isInformationalSpotWarning } from "./postRenderSpotCheck";

describe("finalVideoGate", () => {
  it("expectedDurationBoundsSec covers all length buckets", () => {
    expect(expectedDurationBoundsSec("1")).toEqual({ min: 42, max: 95 });
    expect(expectedDurationBoundsSec("8-10").min).toBeLessThan(expectedDurationBoundsSec("8-10").max);
    expect(expectedDurationBoundsSec("10-15").min).toBeGreaterThanOrEqual(480);
    expect(expectedDurationBoundsSec("15-20").max).toBeGreaterThan(1000);
  });
});

describe("isInformationalSpotWarning", () => {
  it("treats dark archive spot-check and blackdetect as non-blocking", () => {
    expect(isInformationalSpotWarning("blackdetect: 1 dark/black segment(s) in final video")).toBe(true);
    expect(
      isInformationalSpotWarning("3/4 spot-check frames are dark (worst luma 4 — expected for dark archive footage)")
    ).toBe(true);
  });

  it("blocks only fully black renders", () => {
    expect(isInformationalSpotWarning("Final video appears fully black (worst luma 1)")).toBe(false);
  });
});
