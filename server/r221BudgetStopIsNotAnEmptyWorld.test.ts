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
