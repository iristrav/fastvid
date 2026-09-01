/**
 * RONDE 160 — the recovery ran, and nobody could tell whether it worked.
 *
 * ── What the audit was asked to check ────────────────────────────────────────────────────────
 *
 * "Controleer of een rejection daadwerkelijk leidt tot een nieuwe, betere zoekactie. Log per
 * recovery: reason → strategy → query → results → eligible → adopted. Een recovery die alleen
 * opnieuw dezelfde slechte query uitvoert is NIET opgelost."
 *
 * The first half already held. decideResearch maps each refusal to a correction, and refuses with
 * NO_BETTER_QUERY when the "correction" would only repeat a question this beat has already been
 * asked. §1 below pins both, because neither was covered by a test that said so out loud.
 *
 * The second half did not. The outcome line printed `newCandidates=0|1` — a boolean wearing a
 * number's clothes — and it cannot distinguish three failures that need opposite fixes: the query
 * found nothing, the query found things that failed validation, or the gate refused everything it
 * found. §2 is that line, with counts read off the lineage ledger.
 *
 * ── One thing tried and backed out ───────────────────────────────────────────────────────────
 *
 *     video 551   10 refusals,  7 unclassified   6 placeholder beats
 *     video 552   13 refusals,  8 unclassified   4 placeholder beats
 *
 * Mapping UNCLEAR to a correction would turn those dead ends into searches. It was implemented and
 * reverted: five guards from four earlier rounds failed, and they were right. See §1.
 */
import { describe, expect, it } from "vitest";

import {
  buildResearchContext,
  correctionStrategyFor,
  decideResearch,
  formatResearchOutcome,
} from "./mismatchResearch";
import { classifyMismatch, mismatchFault } from "./visualMismatchFeedback";
import type { VerifiedQueryContext } from "./searchQueryContract";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";

/**
 * The real extractor, not a hand-made stub.
 *
 * decideResearch reads typed, verified tokens with evidence offsets. A stub that satisfies the
 * type says nothing about production — RONDE 134 learned that the hard way — so the context here
 * is built from real sentences by the same function the render uses.
 */
const SCENE_TEXT =
  "In 1933 Adolf Hitler was appointed Chancellor in Berlin. " +
  "The Nazi Party had grown out of Munich over the previous decade.";

const ctx = (): VerifiedQueryContext => {
  const beat = buildVerifiedQueryContextForBeat(
    "Adolf Hitler addressed the crowd in Munich.",
    { sceneText: SCENE_TEXT }
  );
  return buildResearchContext({
    beat,
    scene: buildVerifiedQueryContextForBeat(SCENE_TEXT, { sceneText: SCENE_TEXT }),
  });
};

describe("RONDE 160 §1 — the unreadable refusal stays a dead end, deliberately", () => {
  /**
   * This round tried the other way and backed it out.
   *
   * The attempt: map UNCLEAR to MOST_SPECIFIC, on the argument that the alternative outcome is a
   * placeholder card and that MOST_SPECIFIC invents no dimension. Five guards from four earlier
   * rounds (132, 134, 135, 153) failed, and they were right to.
   *
   * A research pass is budgeted. Giving one to a beat whose refusal nobody could read spends it
   * against beats that have a diagnosed fault and a correction that follows from it. And the real
   * defect is that the refusal was unreadable — RONDE 159 fixed the largest instance of that
   * properly, by reading production prose and adding the wording the gate actually uses. Acting on
   * an unreadable refusal would remove the symptom that leads to the evidence.
   *
   * These assertions keep the decision visible so the next round does not spend another day on it.
   */
  it("an unreadable refusal starts no search", () => {
    expect(correctionStrategyFor("UNCLEAR")).toBeNull();
    const decision = decideResearch({
      kind: "UNCLEAR",
      ctx: ctx(),
      alreadyResearched: false,
      remainingBudgetMs: 15 * 60_000,
    });
    expect(decision.action).toBe("NONE");
    expect(decision.blame).toBe("UNKNOWN");
  });

  it("the way out is the classifier, and it is the one RONDE 159 took", () => {
    /**
     * The same beat, refused in the wording production actually uses. RONDE 159 taught the
     * classifier this form; before it, this was an UNCLEAR and this beat got a card.
     */
    const kind = classifyMismatch({
      reason: "The clip shows a wedding ceremony, which does not relate to the narrative.",
    });
    expect(kind).toBe("UNRELATED");
    expect(mismatchFault(kind)).toBe("QUESTION");
    expect(correctionStrategyFor(kind)).toBe("MOST_SPECIFIC");
    const decision = decideResearch({
      kind,
      ctx: ctx(),
      alreadyResearched: false,
      remainingBudgetMs: 15 * 60_000,
    });
    expect(decision.action).toBe("RESEARCH");
  });

  it("a corrected search is never the question the beat was already asked", () => {
    // The brief's rule: a recovery that only re-runs the same bad query is not a recovery.
    const open = decideResearch({
      kind: "UNRELATED",
      ctx: ctx(),
      alreadyResearched: false,
      remainingBudgetMs: 15 * 60_000,
    });
    expect(open.action).toBe("RESEARCH");
    const blocked = decideResearch({
      kind: "UNRELATED",
      ctx: ctx(),
      alreadyResearched: false,
      remainingBudgetMs: 15 * 60_000,
      alreadyUsed: open.correctedQueries,
    });
    if (blocked.action === "RESEARCH") {
      for (const q of blocked.correctedQueries ?? []) {
        expect(open.correctedQueries ?? []).not.toContain(q);
      }
    } else {
      expect(blocked.reason).toBe("NO_BETTER_QUERY");
    }
  });

  it("one pass per beat, and none at all when the render is out of time", () => {
    expect(
      decideResearch({
        kind: "UNRELATED", ctx: ctx(), alreadyResearched: true, remainingBudgetMs: 15 * 60_000,
      }).reason
    ).toBe("ALREADY_RESEARCHED");
    expect(
      decideResearch({
        kind: "UNRELATED", ctx: ctx(), alreadyResearched: false, remainingBudgetMs: 0,
      }).reason
    ).toBe("BUDGET_EXCEEDED");
  });

  it("every kind that has a correction still has it", () => {
    expect(correctionStrategyFor("WRONG_PERIOD")).toBe("ADD_TIME");
    expect(correctionStrategyFor("MODERN_FOOTAGE")).toBe("ADD_TIME");
    expect(correctionStrategyFor("WRONG_SUBJECT")).toBe("ADD_PERSON");
    expect(correctionStrategyFor("WRONG_PLACE")).toBe("ADD_PLACE");
    expect(correctionStrategyFor("WRONG_EVENT")).toBe("ADD_EVENT");
    expect(correctionStrategyFor("UNRELATED")).toBe("MOST_SPECIFIC");
    expect(correctionStrategyFor("TITLE_CARD")).toBe("ADD_ARCHIVAL_INTENT");
    // A material fault is still not answered by changing the question's subject.
    expect(correctionStrategyFor("LOW_INFORMATION")).toBeNull();
  });
});

describe("RONDE 160 §2 — one recovery line that says what happened", () => {
  const base = {
    beatLabel: "s1b2",
    kind: "UNRELATED" as const,
    strategy: "MOST_SPECIFIC" as const,
    query: "Adolf Hitler Munich 1933",
    gateFits: 0,
    gateRejected: 0,
  };

  it("it reads reason → strategy → query → results → eligible → adopted", () => {
    const line = formatResearchOutcome({ ...base, results: 12, eligible: 9, adopted: 1 });
    const order = ["reason=", "strategy=", "query=", "results=", "eligible=", "adopted="];
    let at = -1;
    for (const token of order) {
      const idx = line.indexOf(token);
      expect(idx, token).toBeGreaterThan(at);
      at = idx;
    }
  });

  it("the three failures it must tell apart are now distinguishable", () => {
    const foundNothing = formatResearchOutcome({ ...base, results: 0, eligible: 0, adopted: 0 });
    const noneSurvived = formatResearchOutcome({ ...base, results: 12, eligible: 0, adopted: 0 });
    const gateRefused = formatResearchOutcome({
      ...base, results: 12, eligible: 9, adopted: 0, gateRejected: 9,
    });
    expect(foundNothing).toContain("results=0");
    expect(noneSurvived).toContain("results=12 eligible=0");
    expect(gateRefused).toContain("eligible=9 adopted=0");
    expect(new Set([foundNothing, noneSurvived, gateRefused]).size).toBe(3);
  });

  it("an uncounted pass says so rather than claiming zero", () => {
    // "found nothing" is a finding; "nobody counted" is not, and they must not look the same.
    const line = formatResearchOutcome({ ...base, results: -1, eligible: 0, adopted: 0 });
    expect(line).toContain("results=NOT_MEASURED");
    expect(line).not.toContain("results=0");
  });

  it("a long corrected query cannot flood the log", () => {
    const line = formatResearchOutcome({
      ...base,
      query: "x".repeat(500),
      results: 1,
      eligible: 1,
      adopted: 1,
    });
    expect(line.length).toBeLessThan(400);
  });
});

describe("RONDE 160 §2 — the render feeds it real numbers", () => {
  const PIPE = require("fs").readFileSync(
    require("path").join(__dirname, "videoPipeline.ts"),
    "utf8"
  ) as string;

  it("results is counted from the ledger, not from the return value", () => {
    expect(PIPE).toContain("const recordsBefore = ledgerForResearch?.allRecords().length ?? null;");
    expect(PIPE).toContain("const recordsAfter = ledgerForResearch?.allRecords().length ?? null;");
  });

  it("the refusal, the strategy and the question all reach the line", () => {
    const idx = PIPE.indexOf("formatResearchOutcome({");
    const block = PIPE.slice(idx, idx + 700);
    expect(block).toContain("kind: beatMismatchKind,");
    expect(block).toContain("strategy: decision.strategy,");
    expect(block).toContain("query: decision.correctedQuery,");
  });

  it("no ledger means unmeasured, never zero", () => {
    const idx = PIPE.indexOf("formatResearchOutcome({");
    const block = PIPE.slice(idx, idx + 700);
    expect(block).toContain("recordsBefore != null && recordsAfter != null");
    expect(block).toContain(": -1,");
  });
});
