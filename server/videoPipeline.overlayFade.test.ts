import { describe, expect, it } from "vitest";
import { overlayFadeDurationSec } from "./videoPipeline";

describe("overlayFadeDurationSec (Phase 10)", () => {
  it("scales fade duration with the overlay's visible window, within [0.08, 0.35]", () => {
    expect(overlayFadeDurationSec(0, 10)).toBe(0.35);
    expect(overlayFadeDurationSec(0, 1)).toBeCloseTo(0.25, 5);
    expect(overlayFadeDurationSec(0, 0.1)).toBe(0.08);
  });

  it("never returns a negative or NaN duration for a degenerate window", () => {
    expect(overlayFadeDurationSec(5, 5)).toBe(0.08);
    expect(overlayFadeDurationSec(5, 4)).toBe(0.08);
  });
});
