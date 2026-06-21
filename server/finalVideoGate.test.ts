import { describe, expect, it } from "vitest";
import { expectedDurationBoundsSec } from "./finalVideoGate";

describe("finalVideoGate", () => {
  it("expectedDurationBoundsSec covers all length buckets", () => {
    expect(expectedDurationBoundsSec("1")).toEqual({ min: 42, max: 95 });
    expect(expectedDurationBoundsSec("8-10").min).toBeLessThan(expectedDurationBoundsSec("8-10").max);
    expect(expectedDurationBoundsSec("10-15").min).toBeGreaterThanOrEqual(480);
    expect(expectedDurationBoundsSec("15-20").max).toBeGreaterThan(1000);
  });
});
