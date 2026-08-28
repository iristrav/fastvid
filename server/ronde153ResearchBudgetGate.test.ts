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

describe("RONDE 153 — the preset no longer decides whether research may run", () => {
  it("the fastStockMode gate is gone from the research condition", () => {
    expect(PIPE).toContain("if (!winner && beatMismatchKind) {");
    expect(PIPE).not.toContain("!winner && beatMismatchKind && !dedup.perf.fastStockMode");
  });

  it("the budget gate that remains is the one that was always better informed", () => {
    // decideResearch still receives the render's real remaining time.
    expect(PIPE).toContain("remainingBudgetMs: dedup.forceExportMode");
    expect(PIPE).toContain("get_activeBudgetTracker()?.remainingMs?.()");
  });

  it("and it genuinely refuses when the time is not there", () => {
    const decision = decideResearch({
      kind: "WRONG_PERIOD",
      ctx: ctxWithTime(),
      alreadyResearched: false,
      alreadyUsed: [],
      remainingBudgetMs: RESEARCH_ESTIMATED_COST_MS - 1,
    });
    expect(decision.action).toBe("NONE");
    expect(decision.reason).toBe("BUDGET_EXCEEDED");
  });

  it("...and allows it when there is room — video 550 had eleven minutes", () => {
    const decision = decideResearch({
      kind: "WRONG_PERIOD",
      ctx: ctxWithTime(),
      alreadyResearched: false,
      alreadyUsed: [],
      remainingBudgetMs: 11 * 60_000,
    });
    expect(decision.action).not.toBe("NONE");
  });

  it("forceExportMode still stops it — a render past its deadline starts no new cascade", () => {
    const decision = decideResearch({
      kind: "WRONG_PERIOD",
      ctx: ctxWithTime(),
      alreadyResearched: false,
      alreadyUsed: [],
      remainingBudgetMs: 0,
    });
    expect(decision.action).toBe("NONE");
  });

  it("one pass per beat is unchanged", () => {
    const decision = decideResearch({
      kind: "WRONG_PERIOD",
      ctx: ctxWithTime(),
      alreadyResearched: true,
      alreadyUsed: [],
      remainingBudgetMs: 11 * 60_000,
    });
    expect(decision.action).toBe("NONE");
    expect(decision.reason).toBe("ALREADY_RESEARCHED");
  });

  it("an unclassified refusal still buys nothing — 9 of 550's 18 were unclassified", () => {
    for (const kind of ["UNCLEAR", "LOW_INFORMATION"] as const) {
      const decision = decideResearch({
        kind,
        ctx: ctxWithTime(),
        alreadyResearched: false,
        alreadyUsed: [],
        remainingBudgetMs: 11 * 60_000,
      });
      expect(decision.action, kind).toBe("NONE");
    }
  });

  it("the research pass is still only reached when the beat has NO winner", () => {
    // Research is a recovery path, not an extra search on a beat that already found something.
    const idx = PIPE.indexOf("if (!winner && beatMismatchKind) {");
    expect(idx).toBeGreaterThan(-1);
    expect(PIPE.slice(idx, idx + 60)).toContain("!winner");
  });
});

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

describe("RONDE 153 — fastStockMode still does everything else it did", () => {
  it("the preset is unchanged as a performance profile", () => {
    // This round removed ONE use of the flag — the research gate. The timeouts, query caps and
    // provider switches it drives are deliberate and stay.
    expect(PIPE).toContain("const queryCap = historicalDoc ? 3 : dedup.perf.fastStockMode ? 2 : 4;");
    expect(PIPE).toContain("const trySerp = SERPAPI_KEY && (historicalDoc || !dedup.perf.fastStockMode);");
    expect(PIPE).toContain("fastStockMode: IS_RAILWAY,");
  });
});
