import { describe, expect, it } from "vitest";
import {
  generationBudgetMinutes,
  getVideoLengthLabel,
  normalizeVideoLength,
  targetVideoDurationMinutes,
  VIDEO_LENGTH_VALUES,
  videoLengthSchema,
} from "../shared/videoLengths";

describe("videoLengths", () => {
  it("allows only 1, 8-10, 10-15, 15-20", () => {
    expect(VIDEO_LENGTH_VALUES).toEqual(["1", "8-10", "10-15", "15-20"]);
    expect(videoLengthSchema.safeParse("8-10").success).toBe(true);
    expect(videoLengthSchema.safeParse("5-8").success).toBe(false);
  });

  it("maps legacy stored lengths to current buckets", () => {
    expect(normalizeVideoLength("8-12")).toBe("8-10");
    expect(normalizeVideoLength("12-15")).toBe("10-15");
    expect(normalizeVideoLength("20+")).toBe("15-20");
    expect(normalizeVideoLength("2")).toBe("1");
  });

  it("labels legacy values for display", () => {
    expect(getVideoLengthLabel("8-12")).toBe("8–12 min");
    expect(getVideoLengthLabel("8-10")).toBe("8–10 min");
  });

  it("scales generation budget 10 minutes per video minute", () => {
    expect(targetVideoDurationMinutes("1")).toBe(1);
    expect(generationBudgetMinutes("1")).toBe(10);
    expect(generationBudgetMinutes("8-10")).toBe(100);
    expect(generationBudgetMinutes("10-15")).toBe(150);
    expect(generationBudgetMinutes("15-20")).toBe(200);
  });
});
