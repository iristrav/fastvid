/**
 * One route for every length.
 *
 * The one-minute length used to select a different product — a turbo route (`fastStockMode`), a
 * looser script anchor (`scriptOnlyVisuals: false`) and a fast-short rollback (`FAST_SHORT_PATH`).
 * All three are gone. A length may change how MUCH work a render does (scenes, budgets, timeouts);
 * it may not change WHICH route that work takes.
 */
import { describe, expect, it } from "vitest";
import { maxVisualCandidatesPerBeatTry } from "./sourcingPolicy";
import { postRenderSpotCheckEnabled } from "./postRenderSpotCheck";
import { getPipelinePerfProfile } from "./videoPipeline";

const LENGTHS = ["1", "8-10", "10-15", "15-20"] as const;

describe("one minute takes the same path as ten", () => {
  it("every length has the same profile shape — no field picks a route", () => {
    const keys = (len: string) => Object.keys(getPipelinePerfProfile(len)).sort();
    for (const len of LENGTHS) {
      expect(keys(len), len).toEqual(keys("8-10"));
      expect(getPipelinePerfProfile(len), len).not.toHaveProperty("fastStockMode");
      expect(getPipelinePerfProfile(len), len).not.toHaveProperty("scriptOnlyVisuals");
    }
  });

  it("the delivered file gets its content check at every length", () => {
    expect(postRenderSpotCheckEnabled()).toBe(true);
  });

  it("gets the same candidate depth per beat", () => {
    expect(maxVisualCandidatesPerBeatTry()).toBeGreaterThan(0);
  });
});
