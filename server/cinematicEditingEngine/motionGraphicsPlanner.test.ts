import { describe, expect, it } from "vitest";
import { planMotionGraphics } from "./motionGraphicsPlanner";
import type { VisualIntent } from "../visualMatchingV2/types";
import type { Scene } from "../pipeline/types";

function makeIntent(overrides: Partial<VisualIntent> = {}): VisualIntent {
  return {
    beatId: "b0",
    spokenText: "Apple introduced the Vision Pro.",
    visualSubject: "Apple",
    visualAction: "",
    visualLocation: "",
    visualTime: "present day",
    historicalContext: "",
    emotion: "",
    visualDescription: "",
    primaryKeyword: "Apple Vision Pro",
    secondaryKeyword: "",
    negativeKeywords: [],
    secondaryVisualSubjects: [],
    objects: [],
    brands: [],
    companies: [],
    people: [],
    countries: [],
    events: [],
    intentHash: "hash",
    cacheHit: false,
    ...overrides,
  };
}

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return { index: 0, text: "text", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 5, ...overrides };
}

describe("Motion Graphics Planner (Phase 4)", () => {
  it("emits a progress_bar for a percentage stat callout", () => {
    const graphics = planMotionGraphics(makeIntent(), makeScene({ statCallout: "87%" }), 0, 4);
    const pb = graphics.find((g) => g.graphicType === "progress_bar");
    expect(pb).toBeDefined();
    expect(pb!.data.toValue).toBe(87);
  });

  it("emits a statistic_counter for a non-percentage numeric stat callout", () => {
    const graphics = planMotionGraphics(makeIntent(), makeScene({ statCallout: "$3,499" }), 0, 4);
    const counter = graphics.find((g) => g.graphicType === "statistic_counter");
    expect(counter).toBeDefined();
    expect(counter!.data.toValue).toBe(3499);
  });

  it("emits a map graphic for a recognized location", () => {
    const graphics = planMotionGraphics(makeIntent({ visualLocation: "Paris, France" }), undefined, 0, 4);
    const map = graphics.find((g) => g.graphicType === "map");
    expect(map).toBeDefined();
    expect(map!.data.locationName).toBe("Paris, France");
  });

  it("emits a timeline graphic for a dated historical event", () => {
    const graphics = planMotionGraphics(
      makeIntent({ visualTime: "1969", historicalContext: "Moon landing era", events: ["Apollo 11 landing"] }),
      undefined,
      0,
      4
    );
    expect(graphics.some((g) => g.graphicType === "timeline")).toBe(true);
  });

  it("emits a comparison graphic when the narration draws an explicit comparison", () => {
    const graphics = planMotionGraphics(
      makeIntent({ spokenText: "Sales this year versus sales last year tell a different story." }),
      undefined,
      0,
      4
    );
    const comparison = graphics.find((g) => g.graphicType === "comparison");
    expect(comparison).toBeDefined();
  });

  it("emits a chart graphic when the narration references a trend/data concept", () => {
    const graphics = planMotionGraphics(makeIntent({ spokenText: "Revenue growth accelerated sharply." }), undefined, 0, 4);
    expect(graphics.some((g) => g.graphicType === "chart")).toBe(true);
  });

  it("emits a highlight_box for a named object", () => {
    const graphics = planMotionGraphics(makeIntent({ objects: ["headset"] }), undefined, 0, 4);
    const box = graphics.find((g) => g.graphicType === "highlight_box");
    expect(box?.data.label).toBe("headset");
  });

  it("emits an arrow when the action language points something out", () => {
    const graphics = planMotionGraphics(makeIntent({ visualAction: "the chart shows a sharp rise" }), undefined, 0, 4);
    expect(graphics.some((g) => g.graphicType === "arrow")).toBe(true);
  });

  it("emits an animated_icon for a named brand or company", () => {
    const graphics = planMotionGraphics(makeIntent({ companies: ["Apple"] }), undefined, 0, 4);
    const icon = graphics.find((g) => g.graphicType === "animated_icon");
    expect(icon?.data.label).toBe("Apple");
  });

  it("returns an empty array for a beat with no motion-graphic-worthy signal", () => {
    const graphics = planMotionGraphics(makeIntent({ spokenText: "It was a normal day." }), undefined, 0, 4);
    expect(graphics).toEqual([]);
  });

  it("every emitted graphic carries a non-empty reason (NO RANDOMNESS requirement)", () => {
    const graphics = planMotionGraphics(makeIntent({ objects: ["headset"], companies: ["Apple"] }), undefined, 0, 4);
    expect(graphics.length).toBeGreaterThan(0);
    for (const g of graphics) expect(g.reason.length).toBeGreaterThan(0);
  });
});
