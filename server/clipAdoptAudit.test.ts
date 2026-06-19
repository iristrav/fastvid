import { describe, expect, it } from "vitest";
import { summarizeAdoptAudit } from "./clipAdoptAudit";

describe("summarizeAdoptAudit", () => {
  it("counts sources and emits hints for stock-heavy runs", () => {
    const summary = summarizeAdoptAudit([
      {
        sceneIndex: 0,
        beatIndex: 0,
        beatText: "In 2024 growth hit 4%",
        basename: "scene_0_b0_pexels.mp4",
        source: "pexels",
      },
      {
        sceneIndex: 0,
        beatIndex: 1,
        beatText: "Singapore skyline",
        basename: "scene_0_b1_pexels.mp4",
        source: "pexels",
      },
      {
        sceneIndex: 0,
        beatIndex: 2,
        beatText: "Urban planning",
        basename: "scene_0_b2_kling.mp4",
        source: "kling",
      },
    ]);
    expect(summary.beatsFilled).toBe(3);
    expect(summary.stockBeats).toBe(2);
    expect(summary.klingBeats).toBe(1);
    expect(summary.hints.some((h) => h.includes("stock"))).toBe(true);
  });
});
