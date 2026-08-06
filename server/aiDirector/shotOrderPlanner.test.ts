import { describe, expect, it } from "vitest";
import { planShotOrder } from "./shotOrderPlanner";

describe("Shot Order Planner (Phase 5)", () => {
  it("matches the Phase 5 spec's own climax example (wide/medium/close-up/reaction/detail)", () => {
    const order = planShotOrder("climax", "b_roll", 5);
    expect(order.map((o) => o.shotType)).toEqual(["wide", "medium", "close_up", "reaction", "detail"]);
    expect(order.map((o) => o.order)).toEqual([1, 2, 3, 4, 5]);
  });

  it("sizes the progression down for a scene with fewer beats", () => {
    const order = planShotOrder("explain", "b_roll", 2);
    expect(order).toHaveLength(2);
    expect(order.map((o) => o.shotType)).toEqual(["medium", "close_up"]);
  });

  it("cycles the progression for a scene with more beats than the template", () => {
    const order = planShotOrder("establish", "b_roll", 7);
    expect(order).toHaveLength(7);
    expect(order.map((o) => o.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("works into archive_footage for an archive-strategy scene", () => {
    const order = planShotOrder("explain", "archive_footage", 5);
    expect(order.some((o) => o.shotType === "archive_footage")).toBe(true);
  });

  it("works in an overlay_shot for a map/chart/timeline strategy scene", () => {
    const order = planShotOrder("explain", "map", 5);
    expect(order.some((o) => o.shotType === "overlay_shot")).toBe(true);
  });

  it("works in a reaction shot for an interview/keynote scene without one", () => {
    const order = planShotOrder("explain", "interview", 5);
    expect(order.some((o) => o.shotType === "reaction")).toBe(true);
  });

  it("returns an empty list for a scene with zero beats", () => {
    expect(planShotOrder("explain", "b_roll", 0)).toEqual([]);
  });

  it("every entry carries a non-empty reason (NO RANDOMNESS requirement)", () => {
    const order = planShotOrder("climax", "map", 5);
    for (const item of order) expect(item.reason.length).toBeGreaterThan(0);
  });
});
