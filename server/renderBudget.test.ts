import { describe, expect, it, afterEach } from "vitest";
import { computeRenderBudget } from "./renderBudget";
import { PIPELINE_UNLIMITED_MS } from "./sourcingPolicy";

describe("computeRenderBudget", () => {
  afterEach(() => {
    delete process.env.PIPELINE_WALL_CLOCK_LIMIT;
  });

  it("uses the formula total when the wall-clock limit is enabled", () => {
    process.env.PIPELINE_WALL_CLOCK_LIMIT = "true";
    const budget = computeRenderBudget(3, 90);
    expect(budget.totalMs).toBeLessThan(PIPELINE_UNLIMITED_MS);
    expect(budget.totalMs).toBeGreaterThan(0);
  });

  it("never lets the watchdog kill the render when the wall-clock limit is disabled", () => {
    process.env.PIPELINE_WALL_CLOCK_LIMIT = "false";
    const budget = computeRenderBudget(3, 90);
    expect(budget.totalMs).toBe(PIPELINE_UNLIMITED_MS);
  });

  it("keeps per-stage budgets finite even when the overall limit is disabled", () => {
    process.env.PIPELINE_WALL_CLOCK_LIMIT = "false";
    const budget = computeRenderBudget(3, 90);
    expect(budget.basePerSceneComposeMs).toBeLessThan(PIPELINE_UNLIMITED_MS);
    expect(budget.perSceneRetrieveMs).toBeLessThan(PIPELINE_UNLIMITED_MS);
    expect(budget.concatMs).toBeLessThan(PIPELINE_UNLIMITED_MS);
    expect(budget.uploadMs).toBeLessThan(PIPELINE_UNLIMITED_MS);
  });
});
