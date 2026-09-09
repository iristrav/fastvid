/**
 * RONDE 221 — THE THIRD ANSWER THE COVERAGE LINE COULD NOT GIVE.
 *
 * When a beat ends with a colour card, `[VisualCoverage]` says why. It had two answers:
 *
 *     REAL_ASSET_REJECTED (…)                           something was offered and refused
 *     ALL_SOURCING_EXHAUSTED (nothing was offered…)      nothing was ever offered
 *
 * There is a third, and it is the one that misleads. `budgetAllows` sits at the beat's own query
 * entry point; when a ceiling is reached it returns false and records which one. The beat then
 * reaches the coverage line with nothing offered — and is reported as though the world holds no
 * footage for that sentence, when the truth is that the pipeline stopped asking.
 *
 * Two facts, opposite fixes: one points at the providers, the other at the budget. Render 575 is
 * the case in point — a render that spent 4127 seconds and was stopped by the watchdog is exactly
 * the render where "nothing was offered" is most likely to mean "we ran out of allowance".
 *
 * `budgetExhaustedFor` was written for this question. Its own comment reads "Was this beat stopped
 * by a budget rather than by a lack of candidates?" It had no caller.
 *
 * ── Checked for an existing equivalent first ────────────────────────────────────────────────
 *
 * `formatRetrievalBudgets` reads the same `exhausted` array and IS wired — but it totals the
 * ceilings render-wide, in its own report. It cannot correct this per-beat line, which is the one
 * a reader reaches for when asking why one specific sentence got a colour card. This round adds a
 * reader for a fact already recorded; it records nothing new and changes no threshold.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  BUDGETS,
  budgetAllows,
  budgetExhaustedFor,
  createRetrievalBudgetState,
} from "./retrievalBudget";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════ 1. the fact is recorded, and now read ═══════════ */

describe("R221 §1 — a budget stop is distinguishable from an empty world", () => {
  it("THE READER HAS A CALLER NOW", () => {
    const callers = [...PIPE.matchAll(/budgetExhaustedFor\(/g)];
    expect(callers.length, "the question still has no asker").toBeGreaterThan(0);
  });

  it("the coverage line offers all three answers, in the right precedence", () => {
    const at = PIPE.indexOf("const budgetStops = budgetExhaustedFor(");
    expect(at).toBeGreaterThan(0);
    const block = PIPE.slice(at, at + 600);
    expect(block).toContain("REAL_ASSET_REJECTED");
    expect(block).toContain("BUDGET_EXHAUSTED");
    expect(block).toContain("ALL_SOURCING_EXHAUSTED");
    // A refusal is an answer no budget explains, so it must be tested first.
    expect(block.indexOf("REAL_ASSET_REJECTED")).toBeLessThan(block.indexOf("BUDGET_EXHAUSTED"));
  });

  it("and it names WHICH ceiling, not merely that there was one", () => {
    const at = PIPE.indexOf("BUDGET_EXHAUSTED (${budgetStops.join");
    expect(at, "the reason does not say which budget stopped the beat").toBeGreaterThan(0);
  });

  it("THE MISLEADING SENTENCE IS NO LONGER REACHED WHEN A BUDGET STOPPED THE BEAT", () => {
    const at = PIPE.indexOf("const budgetStops = budgetExhaustedFor(");
    const block = PIPE.slice(at, at + 600);
    expect(block).toContain("budgetStops.length > 0");
  });
});

/* ═══════════ 2. the underlying fact behaves as the line now claims ═══════════ */

describe("R221 §2 — measured on the budget itself", () => {
  it("A BEAT THAT HIT A CEILING SAYS SO; ONE THAT DID NOT SAYS NOTHING", () => {
    const state = createRetrievalBudgetState();
    // Spend the query allowance for one beat.
    for (let i = 0; i < BUDGETS.queries() + 2; i++) budgetAllows(state, 0, 0, "queries");
    expect(budgetExhaustedFor(state, 0, 0)).toContain("queries");
    expect(budgetExhaustedFor(state, 0, 1), "an untouched beat claims a ceiling").toEqual([]);
  });

  it("a beat well under its allowance reports nothing", () => {
    const state = createRetrievalBudgetState();
    expect(budgetAllows(state, 1, 0, "queries")).toBe(true);
    expect(budgetExhaustedFor(state, 1, 0)).toEqual([]);
  });

  it("the answer is per beat, never leaked from a neighbour", () => {
    const state = createRetrievalBudgetState();
    for (let i = 0; i < BUDGETS.queries() + 2; i++) budgetAllows(state, 2, 5, "queries");
    expect(budgetExhaustedFor(state, 2, 5)).toContain("queries");
    expect(budgetExhaustedFor(state, 2, 6)).toEqual([]);
    expect(budgetExhaustedFor(state, 3, 5)).toEqual([]);
  });

  it("no state at all is not an assertion that a budget was hit", () => {
    expect(budgetExhaustedFor(undefined, 0, 0)).toEqual([]);
  });
});

/* ═══════════ 3. what this round did NOT do ═══════════ */

describe("R221 §3 — a reader was added, nothing else", () => {
  it("NO BUDGET WAS RAISED", () => {
    const src = fs.readFileSync(path.join(__dirname, "retrievalBudget.ts"), "utf8");
    const declared = src.slice(src.indexOf("export const BUDGETS"), src.indexOf("export const BUDGETS") + 400);
    // The numbers are whatever they were; this asserts the round did not touch the shape.
    expect(declared).toContain("queries");
    expect(PIPE, "the round changed a budget instead of reading one").not.toContain(
      "BUDGETS.queries ="
    );
  });

  it("nothing new is recorded — the exhausted list is written where it always was", () => {
    const src = fs.readFileSync(path.join(__dirname, "retrievalBudget.ts"), "utf8");
    const writes = [...src.matchAll(/state\.exhausted\.push\(/g)];
    expect(writes.length, "a second writer appeared").toBe(1);
    expect(PIPE, "the pipeline started writing the ledger itself").not.toContain(
      "exhausted.push("
    );
  });

  it("the render-wide report still stands beside it", () => {
    expect(PIPE).toContain("formatRetrievalBudgets");
  });
});
