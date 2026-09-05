/**
 * RONDE 97 §10 — a beat may spend, and then it stops.
 *
 * RONDE 95 bounded the expensive half: `maxShortlistPerBeat()` limits how many candidates reach
 * the picture editor. The cheap-looking half was unbounded — render 568 spent 1667 provider
 * queries to fill twenty slots and downloaded 100 files to use ten. Each of those is individually
 * small, and collectively they are the reason a render takes hours.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUDGETS,
  beatSpend,
  budgetAllows,
  budgetExhaustedFor,
  createRetrievalBudgetState,
  formatRetrievalBudgets,
} from "./retrievalBudget";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const ENVS = ["MAX_BEAT_QUERIES", "MAX_BEAT_DOWNLOADS", "MAX_BEAT_PREPARATIONS", "MAX_BEAT_RESCUES"];
const saved = ENVS.map((e) => [e, process.env[e]] as const);
afterEach(() => {
  for (const [e, v] of saved) {
    if (v === undefined) delete process.env[e];
    else process.env[e] = v;
  }
});

describe("every budget is bounded and configurable", () => {
  it("has a finite default for each kind", () => {
    for (const kind of ["queries", "downloads", "preparations", "rescues"] as const) {
      const limit = BUDGETS[kind]();
      expect(Number.isFinite(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }
  });

  /** Generous against a healthy beat, tight against render 568's 83 queries per slot. */
  it("bounds a beat well below what render 568 spent", () => {
    expect(BUDGETS.queries()).toBeLessThan(83);
    expect(BUDGETS.downloads()).toBeLessThan(100);
  });

  it("is configurable and ignores nonsense", () => {
    process.env.MAX_BEAT_QUERIES = "5";
    expect(BUDGETS.queries()).toBe(5);
    process.env.MAX_BEAT_QUERIES = "0";
    expect(BUDGETS.queries()).toBe(24);
    process.env.MAX_BEAT_QUERIES = "banana";
    expect(BUDGETS.queries()).toBe(24);
  });
});

describe("a beat spends its own budget and no one else's", () => {
  it("allows up to the limit and then refuses", () => {
    process.env.MAX_BEAT_QUERIES = "3";
    const state = createRetrievalBudgetState();
    for (let i = 0; i < 3; i++) {
      expect(budgetAllows(state, 0, 0, "queries")).toBe(true);
    }
    expect(budgetAllows(state, 0, 0, "queries")).toBe(false);
    expect(beatSpend(state, 0, 0).queries).toBe(3);
  });

  /** A render-wide ceiling starves whichever beats happen to be last. This one cannot. */
  it("a spent beat does not starve its neighbour", () => {
    process.env.MAX_BEAT_QUERIES = "1";
    const state = createRetrievalBudgetState();
    expect(budgetAllows(state, 0, 0, "queries")).toBe(true);
    expect(budgetAllows(state, 0, 0, "queries")).toBe(false);
    expect(budgetAllows(state, 0, 1, "queries")).toBe(true);
    expect(budgetAllows(state, 1, 0, "queries")).toBe(true);
  });

  it("the four kinds are separate budgets", () => {
    process.env.MAX_BEAT_QUERIES = "1";
    const state = createRetrievalBudgetState();
    expect(budgetAllows(state, 0, 0, "queries")).toBe(true);
    expect(budgetAllows(state, 0, 0, "queries")).toBe(false);
    expect(budgetAllows(state, 0, 0, "downloads")).toBe(true);
    expect(budgetAllows(state, 0, 0, "preparations")).toBe(true);
    expect(budgetAllows(state, 0, 0, "rescues")).toBe(true);
  });

  /** The infinite-rescue case the brief names. */
  it("the rescue ladder cannot be entered indefinitely", () => {
    const state = createRetrievalBudgetState();
    let entered = 0;
    for (let i = 0; i < 500; i++) {
      if (budgetAllows(state, 0, 0, "rescues")) entered += 1;
    }
    expect(entered).toBe(BUDGETS.rescues());
  });

  /**
   * Charging and asking are one call on purpose: a caller that could ask without charging would
   * eventually ask twice and charge once, and the budget would drift from the work it bounds.
   */
  it("charges on the way in", () => {
    const state = createRetrievalBudgetState();
    budgetAllows(state, 0, 0, "downloads");
    budgetAllows(state, 0, 0, "downloads");
    expect(beatSpend(state, 0, 0).downloads).toBe(2);
  });

  it("is inert without a render state", () => {
    expect(budgetAllows(undefined, 0, 0, "queries")).toBe(true);
    expect(budgetExhaustedFor(undefined, 0, 0)).toEqual([]);
  });
});

describe("exhaustion is named, once", () => {
  it("records which budget stopped the beat", () => {
    process.env.MAX_BEAT_DOWNLOADS = "1";
    const state = createRetrievalBudgetState();
    budgetAllows(state, 1, 2, "downloads");
    budgetAllows(state, 1, 2, "downloads");
    expect(budgetExhaustedFor(state, 1, 2)).toEqual(["downloads"]);
  });

  /** A route that keeps asking after a refusal must not bury the render's other findings. */
  it("does not repeat the same refusal", () => {
    process.env.MAX_BEAT_DOWNLOADS = "1";
    const state = createRetrievalBudgetState();
    for (let i = 0; i < 30; i++) budgetAllows(state, 0, 0, "downloads");
    expect(state.exhausted.length).toBe(1);
  });

  it("distinguishes a spent budget from an empty search", () => {
    process.env.MAX_BEAT_QUERIES = "1";
    const state = createRetrievalBudgetState();
    budgetAllows(state, 0, 0, "queries");
    budgetAllows(state, 0, 0, "queries");
    const line = formatRetrievalBudgets(state).join(" ");
    expect(line).toContain("BUDGET_EXHAUSTED kind=queries");
    expect(line).toContain("it did not run out of candidates");
  });

  it("prints totals and the caps, and nothing at all for an unused render", () => {
    expect(formatRetrievalBudgets(createRetrievalBudgetState())).toEqual([]);
    expect(formatRetrievalBudgets(undefined)).toEqual([]);
    const state = createRetrievalBudgetState();
    budgetAllows(state, 0, 0, "queries");
    budgetAllows(state, 0, 1, "downloads");
    const lines = formatRetrievalBudgets(state);
    expect(lines[0]).toContain("beats=2 queries=1 downloads=1");
    expect(lines[0]).toContain("perBeat caps");
  });

  /** A healthy render says what it spent and adds no exhaustion lines. */
  it("a render inside its budget reports one line", () => {
    const state = createRetrievalBudgetState();
    budgetAllows(state, 0, 0, "queries");
    expect(formatRetrievalBudgets(state).length).toBe(1);
  });
});

describe("the budget is charged where the beat actually asks", () => {
  /** One charge at the beat's own query entry point covers every route that asks through it. */
  it("the beat's query entry point charges the query budget", () => {
    const at = PIPE.indexOf("function typedRetrievalQueriesForBeat(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).toContain('budgetAllows(dedup.beatBudget, scene.index, beat.index, "queries")');
    /** And a refused beat returns no queries rather than throwing. */
    expect(body).toContain("return [];");
  });

  it("the render reports the budgets", () => {
    expect(PIPE).toContain("formatRetrievalBudgets(visualDedup.beatBudget)");
  });

  it("the state is render-scoped", () => {
    expect(PIPE).toContain("beatBudget: createRetrievalBudgetState()");
  });
});
