/**
 * RONDE 171 — the recovery path was switched off by a clock, not by a budget.
 *
 * ── Three of nineteen beats, and why ─────────────────────────────────────────────────────────
 *
 * Render 555 ended with three of nineteen beats holding an approved picture of their own. Its own
 * report named the lever:
 *
 *     17 van 30 afgewezen beelden waren fout van soort (verkeerde periode, plaats of onderwerp)
 *     — die had een preciezere zoekvraag kunnen voorkomen
 *
 * Seventeen refusals that a better question fixes, and a pass that exists to ask one. It ran zero
 * times:
 *
 *     10:39:47  [Pipeline] Force-export mode (≥9 min) — finishing with archive+stock then compose
 *     10:41:52  [MismatchResearch] beat=s2b0 mismatch=UNRELATED blame=QUESTION
 *                                  action=NONE reason=BUDGET_EXCEEDED
 *               [MismatchResearch] attempts=0 produced=0 accepted=0 rejected=0 skipped=2
 *     ...       [Budget] video=555 concat  elapsed=15m 4s  remaining=6m 56s
 *
 * Force-export turned on nine minutes into a twenty-two minute budget. From that moment the call
 * site replaced the remaining time with a literal 0, so `decideResearch` refused every pass as
 * BUDGET_EXCEEDED — on a render that finished with nearly seven minutes unspent.
 *
 * ── The same shape RONDE 153 already removed ─────────────────────────────────────────────────
 *
 * One round earlier, `!fastStockMode` was doing exactly this: a blunt switch sitting on top of a
 * budget check that was better informed. RONDE 153's words apply verbatim — "Research is the
 * recovery path for a refused beat. Switching it off on the preset most likely to be short of
 * footage is backwards; the budget check is what should decide, and it already did." The preset
 * went; the clock stayed.
 *
 * ── Honoured, not deleted ────────────────────────────────────────────────────────────────────
 *
 * Force-export means something real: a render past its own pacing must not gamble. So it becomes a
 * MARGIN rather than a veto — the pass has to fit twice over before it starts — and when it truly
 * does not fit, `decideResearch` refuses it as BUDGET_EXCEEDED, which is then the honest reason
 * rather than a foregone one.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  FORCE_EXPORT_RESEARCH_MARGIN,
  RESEARCH_ESTIMATED_COST_MS,
  decideResearch,
} from "./mismatchResearch";
import type { VerifiedQueryContext } from "./searchQueryContract";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** Render 555's s2b0: an UNRELATED refusal on a beat the scene proves plenty about. */
const emptyCtx = (): VerifiedQueryContext => ({
  persons: [], places: [], countries: [], events: [],
  actions: [], objects: [], time: [], years: [], evidence: [],
});

const ctx: VerifiedQueryContext = {
  ...emptyCtx(),
  persons: ["Winston Churchill", "Joseph Stalin"],
  places: ["Tehran"],
  years: ["1943"],
  events: ["Tehran Conference"],
};

const ask = (remainingBudgetMs: number | undefined, estimatedCostMs?: number) =>
  decideResearch({
    kind: "UNRELATED",
    ctx,
    alreadyResearched: false,
    alreadyUsed: [],
    remainingBudgetMs,
    estimatedCostMs,
  });

/** What the call site passes once force-export is on. */
const forceExportCost = RESEARCH_ESTIMATED_COST_MS * FORCE_EXPORT_RESEARCH_MARGIN;

/**
 * The question this round is about, and only that one: was the pass refused BECAUSE OF THE BUDGET.
 *
 * `decideResearch` has other reasons to decline — NO_BETTER_QUERY when the beat proves nothing
 * more specific than what was already asked, ALREADY_RESEARCHED, UNCLEAR — and RONDE 134 §20 keeps
 * them distinct precisely because they lead to different work. Asserting on `action` would conflate
 * this round's change with all of them; asserting on the reason does not.
 */
const refusedOnBudget = (remaining: number | undefined, cost?: number): boolean =>
  ask(remaining, cost).reason === "BUDGET_EXCEEDED";

describe("RONDE 171 — a clock may not stand in for a budget", () => {
  it("the bug: a literal 0 refused every pass however much render was left", () => {
    // This is what the call site used to pass the moment force-export turned on.
    expect(ask(0).reason).toBe("BUDGET_EXCEEDED");
    expect(ask(0).action).toBe("NONE");
  });

  it("render 555's moment: seventeen minutes left, and the pass now runs", () => {
    // 10:41:52 was 4m 53s into a 22m budget. A 45s pass was plainly affordable.
    const remaining = (22 - 4.9) * 60_000;
    expect(refusedOnBudget(remaining, forceExportCost)).toBe(false);
  });

  it("force-export still refuses when the pass genuinely does not fit", () => {
    // The margin is the guard: past its own pacing, a render must afford the pass twice over.
    expect(refusedOnBudget(RESEARCH_ESTIMATED_COST_MS + 1_000, forceExportCost)).toBe(true);
    expect(refusedOnBudget(forceExportCost + 1_000, forceExportCost)).toBe(false);
  });

  it("a render NOT in force-export is unchanged — one pass has to fit, not two", () => {
    expect(refusedOnBudget(RESEARCH_ESTIMATED_COST_MS + 1_000)).toBe(false);
    expect(refusedOnBudget(RESEARCH_ESTIMATED_COST_MS - 1_000)).toBe(true);
  });

  it("the margin makes force-export stricter than normal, never looser", () => {
    /**
     * The property that keeps this a narrowing of a veto rather than a loosening of a guard: at
     * every remaining time, a force-export render is at least as reluctant as an ordinary one.
     */
    for (const remaining of [0, 10_000, 45_000, 46_000, 90_000, 91_000, 600_000]) {
      const ordinaryAllows = !refusedOnBudget(remaining);
      const forcedAllows = !refusedOnBudget(remaining, forceExportCost);
      expect(forcedAllows && !ordinaryAllows, `remaining=${remaining}`).toBe(false);
    }
  });

  it("a render with no tracker at all still behaves as before", () => {
    // `remainingMs` is optional chained at the call site; undefined must not become "no budget".
    expect(refusedOnBudget(undefined)).toBe(false);
    expect(refusedOnBudget(undefined, forceExportCost)).toBe(false);
  });

  it("the budget refusal is still distinguishable from having nothing to ask", () => {
    // BUDGET_EXCEEDED and NO_BETTER_QUERY lead to different work — RONDE 134 §20's whole point.
    const nothingToAsk = decideResearch({
      kind: "UNRELATED",
      ctx: emptyCtx(),
      alreadyResearched: false,
      alreadyUsed: [],
      remainingBudgetMs: 600_000,
    });
    expect(nothingToAsk.reason).not.toBe("BUDGET_EXCEEDED");
  });
});

describe("RONDE 171 — wired at the one call site", () => {
  it("the real remaining time is passed, not a literal", () => {
    const idx = PIPE.indexOf("const decision = decideResearch({");
    expect(idx).toBeGreaterThan(0);
    // Bounded by the call's own closing line, not a character count — this round's comment made
    // the block longer, which is exactly how a fixed +N window breaks on a change it should not.
    const block = PIPE.slice(idx, PIPE.indexOf("formatResearchDecision(beatLabel, decision)", idx));
    expect(block).toContain("remainingBudgetMs: get_activeBudgetTracker()?.remainingMs?.(),");
    expect(block).not.toContain("remainingBudgetMs: dedup.forceExportMode");
  });

  it("force-export is expressed as the margin and nothing else", () => {
    const idx = PIPE.indexOf("const decision = decideResearch({");
    const block = PIPE.slice(idx, PIPE.indexOf("formatResearchDecision(beatLabel, decision)", idx));
    expect(block).toContain("estimatedCostMs: dedup.forceExportMode");
    expect(block).toContain("RESEARCH_ESTIMATED_COST_MS * FORCE_EXPORT_RESEARCH_MARGIN");
    expect(block).toContain(": undefined,");
  });

  it("force-export itself is untouched — it still fires and still says so", () => {
    // The mode is a real signal about a real deadline. Only its effect on research changed.
    expect(PIPE).toContain("function ensurePipelineForceExport(");
    expect(PIPE).toContain("dedup.forceExportMode = true;");
    expect(PIPE).toContain("Force-export mode (≥");
    // And it still stops the polish pass and shortens the beat budget.
    expect(PIPE).toContain("Force-export — skipping polish");
    expect(PIPE).toContain("const beatBudgetMs = dedup.forceExportMode");
  });

  it("the once-per-beat rule and the marking-before-the-search rule still stand", () => {
    // RONDE 132: one extra look means one, however it ends.
    expect(PIPE).toContain("dedup.mismatchResearchedBeats.add(researchKey);");
    expect(PIPE).toContain("alreadyResearched: dedup.mismatchResearchedBeats.has(researchKey),");
  });
});
