/**
 * RONDE 153 — the beats that had nothing, and the recovery that never ran.
 *
 * ── What video 550 measured ──────────────────────────────────────────────────────────────────
 *
 *     [MismatchFeedback] 18 refusal(s) — search-preventable=8 material=1 unclassified=9
 *     research attempts=0
 *     [VisualCoverageFinal] TOTAL beats=15 adopted=2 placeholder=6 noCandidates=4
 *     [Quality] 4 kleur-fallback beat(s) — sourcing faalde op die zinnen
 *     [BudgetSummary] estimated=22m 0s  actual=10m 45s  used=49%  total_remaining=11m 15s
 *
 * Eighteen refusals — RONDE 142's registration is working, up from five on video 548 — of which
 * the feedback chain had already classified eight as fixable by asking a better question. Eleven
 * minutes of unused budget. Zero corrected searches. Six beats fell through to placeholders and
 * four to colour cards.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────────────────────
 *
 * The research pass carried a second gate on top of its budget check:
 *
 *     if (!winner && beatMismatchKind && !dedup.perf.fastStockMode)
 *
 * `fastStockMode` is `IS_RAILWAY` on the one-minute preset, so in production research was switched
 * off entirely for exactly the renders most likely to be short of footage. And it fired regardless
 * of how much time was actually left — `decideResearch` already takes `remainingBudgetMs` and
 * refuses as BUDGET_EXCEEDED when a pass would not fit, which is the better-informed check and was
 * being pre-empted by the cruder one.
 *
 * This round removes the preset gate and leaves the budget gate. It does not make research
 * unconditional: every other guard is untouched.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { decideResearch, RESEARCH_ESTIMATED_COST_MS } from "./mismatchResearch";
import { emptyQueryContext, provenToken } from "./searchQueryContract";
import { getPipelinePerfProfile } from "./videoPipeline";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** A context with enough proven tokens for a period correction to be possible. */
function ctxWithTime() {
  const ctx = emptyQueryContext("Hermann Göring in Berlin, 1945.");
  ctx.persons.push(provenToken("Hermann Göring", "person", "beat_text"));
  ctx.years.push(provenToken("1945", "year", "beat_text"));
  ctx.places.push(provenToken("Berlin", "place", "beat_text"));
  return ctx;
}


describe("RONDE 153 — a short render gets more than one topical query", () => {
  it("the one-minute profile asks two topical queries, not one", () => {
    const prev = process.env.RAILWAY_ENVIRONMENT;
    try {
      // The profile is read at call time, so the Railway branch can be exercised directly.
      const profile = getPipelinePerfProfile("1");
      expect(profile.maxTopicQueries).toBeGreaterThanOrEqual(2);
    } finally {
      if (prev === undefined) delete process.env.RAILWAY_ENVIRONMENT;
      else process.env.RAILWAY_ENVIRONMENT = prev;
    }
  });

  it("it stays below the off-Railway value, keeping a margin", () => {
    // Two rather than three: measured room exists (49% of budget used) but the parallelism
    // comment above this setting is about real peak-memory pressure, so the step is deliberate.
    expect(PIPE).toContain("maxTopicQueries: IS_RAILWAY ? 2 : 3,");
  });

  it("longer presets are untouched", () => {
    // 8-10 falls to the default profile (4); the two long presets share their own (3).
    expect(getPipelinePerfProfile("8-10").maxTopicQueries).toBe(4);
    expect(getPipelinePerfProfile("10-15").maxTopicQueries).toBe(3);
    expect(getPipelinePerfProfile("15-20").maxTopicQueries).toBe(3);
  });
});

describe("one route for every length", () => {
  it("there is no fast-stock profile left to choose a different route", () => {
    expect(PIPE).not.toContain("fastStockMode");
  });
});
