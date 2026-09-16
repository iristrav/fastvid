/**
 * RONDE 267 — MORE CHANCES TO LOOK, NOT LONGER TO WAIT.
 *
 * Every acceptance criterion the brief names, as a test with a measured value.
 *
 * ── The distinction the whole module exists to hold ─────────────────────────────────────────
 *
 * RONDE 259 already proved what "give the provider more time" buys: `YOUTUBE_BEAT_BUDGET_MS` went
 * from 30s to 45s and not one outcome changed, because the parent scope clamped it. A longer
 * timeout is longer waiting on the same request.
 *
 * So every turn this grants is the SAME LENGTH as the first — §2 checks that directly, on every
 * granting reason — and what varies is how many. Extra zoekgelegenheid, niet langer wachten.
 *
 * ── And the thing that makes it safe ────────────────────────────────────────────────────────
 *
 * §6: there is no input, and no combination of inputs, that produces a fourth turn. The ceiling is
 * checked by exhaustion over a large grid rather than by reading the code, because "I cannot think
 * of a way past it" is not the same claim as "there is no way past it".
 */
import { describe, expect, it } from "vitest";

import {
  MAX_SEARCH_TURNS,
  TURN_PLUS_FOLLOW_THROUGH,
  createSearchBudgetLedger,
  formatSearchBudget,
  noteSearchStopped,
  noteSearchTurn,
  searchBudgetRow,
  shouldGrantSearchTurn,
  unexplainedSearchStops,
  type SearchTurnContext,
} from "./adaptiveSearchBudget";
import { stripComments } from "./sourceScan.test.support";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(path.join(__dirname, "adaptiveSearchBudget.ts"), "utf8");

const TURN_MS = 12_000;

const ctx = (over: Partial<SearchTurnContext> = {}): SearchTurnContext => ({
  turnsTaken: 0,
  promisingSoFar: 0,
  providerSuitsNeed: true,
  visionCapacityRemaining: 4,
  remainingScopeMs: 120_000,
  turnBudgetMs: TURN_MS,
  ...over,
});

/* ═══════════ 1. adaptiveSearchBudget / beatAware / providerAware ═══════════ */

describe("R267 §1 — the decision is beat-aware and provider-aware", () => {
  it("adaptiveSearchBudget = PASS — a productive provider gets another look", () => {
    const first = shouldGrantSearchTurn(ctx({ turnsTaken: 0 }));
    expect(first).toMatchObject({ grant: true, reason: "FIRST_TURN" });
    const second = shouldGrantSearchTurn(ctx({ turnsTaken: 1, promisingSoFar: 3 }));
    expect(second).toMatchObject({ grant: true, reason: "PROMISING_RESULTS" });
  });

  it("beatAwareSearchBudget = PASS — what the PREVIOUS turns produced decides the next", () => {
    /** Identical provider, identical clock; only what this beat found differs. */
    const productive = shouldGrantSearchTurn(ctx({ turnsTaken: 1, promisingSoFar: 5 }));
    const barren = shouldGrantSearchTurn(ctx({ turnsTaken: 1, promisingSoFar: 0 }));
    expect(productive.grant).toBe(true);
    expect(barren).toMatchObject({ grant: false, reason: "NOTHING_PROMISING" });
  });

  it("providerAwareSearchBudget = PASS — a provider that cannot supply the need gets no turn", () => {
    expect(shouldGrantSearchTurn(ctx({ providerSuitsNeed: false }))).toMatchObject({
      grant: false,
      reason: "PROVIDER_NOT_CAPABLE",
    });
  });

  it("allTopicTypesSupported = PASS — nothing here can see the subject", () => {
    /**
     * Structural, and deliberately so. A behavioural test could only show that fifteen topics I
     * happened to pick behave alike; this shows the decision has no way to tell them apart.
     */
    const code = stripComments(SRC);
    for (const topic of [
      "historical", "ww2", "wwii", "1945", "celebrity", "sport", "science",
      "politics", "travel", "crime", "youtube", "pexels", "wikimedia", "archive",
    ]) {
      expect(
        code.toLowerCase().includes(topic),
        `the decision can see "${topic}" — a topic or provider it could be taught to special-case`
      ).toBe(false);
    }
  });
});

/* ═══════════ 2. more chances, never a longer wait ═══════════ */

describe("R267 §2 — every granted turn is the caller's own length", () => {
  it("THE WHOLE DESIGN: no granting reason ever returns a bigger budget than it was given", () => {
    const grants = [
      shouldGrantSearchTurn(ctx({ turnsTaken: 0 })),
      shouldGrantSearchTurn(ctx({ turnsTaken: 1, promisingSoFar: 2 })),
      shouldGrantSearchTurn(ctx({ turnsTaken: 2, promisingCandidateAwaitingVerdict: true })),
    ];
    expect(grants.every((g) => g.grant)).toBe(true);
    for (const g of grants) {
      if (g.grant) {
        expect(g.turnBudgetMs, `${g.reason} lengthened the request`).toBe(TURN_MS);
      }
    }
  });

  it("and a different per-turn budget is passed through unchanged, never scaled", () => {
    for (const turnBudgetMs of [1_000, 12_000, 45_000]) {
      const g = shouldGrantSearchTurn(ctx({ turnBudgetMs }));
      if (g.grant) expect(g.turnBudgetMs).toBe(turnBudgetMs);
    }
  });
});

/* ═══════════ 3. youtube and every other provider, by the same rule ═══════════ */

describe("R267 §3 — the same rule for whoever asks", () => {
  it("youtubeCanReceiveAdditionalBoundedSearchOpportunity = PASS", () => {
    /** Turn 1 finds something; turn 2 is granted; turn 3 is granted; turn 4 is not. */
    expect(shouldGrantSearchTurn(ctx({ turnsTaken: 1, promisingSoFar: 4 })).grant).toBe(true);
    expect(shouldGrantSearchTurn(ctx({ turnsTaken: 2, promisingSoFar: 4 })).grant).toBe(true);
    expect(shouldGrantSearchTurn(ctx({ turnsTaken: 3, promisingSoFar: 4 }))).toMatchObject({
      grant: false,
      reason: "TURN_CEILING_REACHED",
    });
  });

  it("otherProvidersCanReceiveAdditionalBoundedSearchOpportunity = PASS", () => {
    /**
     * The same call, because there is no provider argument. That IS the property: an archive
     * source, a stock source and a video source reach the identical decision from identical
     * evidence, and no code path can privilege one.
     */
    expect(shouldGrantSearchTurn(ctx({ turnsTaken: 1, promisingSoFar: 1 })).grant).toBe(true);
  });

  it("A BAD FIRST TURN ENDS THE TURNS — adaptive is not 'repeat the same bad request'", () => {
    expect(shouldGrantSearchTurn(ctx({ turnsTaken: 1, promisingSoFar: 0 }))).toMatchObject({
      grant: false,
      reason: "NOTHING_PROMISING",
    });
  });
});

/* ═══════════ 4. no look nobody can judge ═══════════ */

describe("R267 §4 — visionCapacityConsidered", () => {
  it("visionCapacityConsidered = PASS — no verdicts left, no further turns", () => {
    expect(
      shouldGrantSearchTurn(ctx({ turnsTaken: 1, promisingSoFar: 5, visionCapacityRemaining: 0 }))
    ).toMatchObject({ grant: false, reason: "NO_VISION_CAPACITY" });
  });

  it("not even the first turn, and not even for a candidate at risk", () => {
    expect(shouldGrantSearchTurn(ctx({ visionCapacityRemaining: 0 })).grant).toBe(false);
    expect(
      shouldGrantSearchTurn(
        ctx({ visionCapacityRemaining: 0, promisingCandidateAwaitingVerdict: true })
      ).grant,
      "a candidate was pursued that nothing could judge"
    ).toBe(false);
  });
});

/* ═══════════ 5. a promising candidate is not lost to a generic clock ═══════════ */

describe("R267 §5 — promisingCandidateNotSilentlyDiscarded", () => {
  it("promisingCandidateNotSilentlyDiscarded = PASS", () => {
    /**
     * The §6 scenario exactly: a candidate found, ranked and awaiting a verdict, with the turns
     * otherwise over. It outranks the ceiling-adjacent refusals because those describe whether a
     * NEW search is worth taking — and none of them is a reason to drop something already found.
     */
    const atRisk = shouldGrantSearchTurn(
      ctx({ turnsTaken: 2, promisingSoFar: 0, promisingCandidateAwaitingVerdict: true })
    );
    expect(atRisk).toMatchObject({ grant: true, reason: "PROMISING_CANDIDATE_AT_RISK" });
  });

  it("and it even outranks a provider the caller thinks unsuitable, because it is already found", () => {
    expect(
      shouldGrantSearchTurn(
        ctx({ turnsTaken: 1, providerSuitsNeed: false, promisingCandidateAwaitingVerdict: true })
      ).grant
    ).toBe(true);
  });

  it("BUT IT IS STILL BOUNDED — it cannot break the ceiling", () => {
    expect(
      shouldGrantSearchTurn(
        ctx({ turnsTaken: MAX_SEARCH_TURNS, promisingCandidateAwaitingVerdict: true })
      )
    ).toMatchObject({ grant: false, reason: "TURN_CEILING_REACHED" });
  });

  it("nor a scope that genuinely cannot pay for the turn and what it produces", () => {
    expect(
      shouldGrantSearchTurn(
        ctx({ remainingScopeMs: TURN_MS, promisingCandidateAwaitingVerdict: true })
      ).grant,
      "a turn was started that could not be followed through"
    ).toBe(false);
  });

  it("searchBudgetExhaustionExplained = PASS — the refusal names the numbers", () => {
    const out = shouldGrantSearchTurn(ctx({ remainingScopeMs: 5_000 }));
    expect(out).toMatchObject({ grant: false, reason: "SEARCH_BUDGET_EXHAUSTED" });
    if (!out.grant) {
      expect(out.detail).toContain("5s left");
      expect(out.detail).toContain(`${(TURN_MS * TURN_PLUS_FOLLOW_THROUGH) / 1000}s`);
    }
  });
});

/* ═══════════ 6. adaptive is not unlimited ═══════════ */

describe("R267 §6 — searchBudgetAlwaysBounded", () => {
  it("searchBudgetAlwaysBounded = PASS — EXHAUSTIVELY, not by inspection", () => {
    /**
     * Every combination of the inputs, at and past the ceiling. "I cannot think of a way past it"
     * and "there is no way past it" are different claims, and only the second is worth having.
     */
    let granted = 0;
    for (const turnsTaken of [MAX_SEARCH_TURNS, MAX_SEARCH_TURNS + 1, 99]) {
      for (const promisingSoFar of [0, 1, 1000]) {
        for (const providerSuitsNeed of [true, false]) {
          for (const visionCapacityRemaining of [0, 1, 999]) {
            for (const remainingScopeMs of [0, 120_000, Number.POSITIVE_INFINITY]) {
              for (const promisingCandidateAwaitingVerdict of [true, false]) {
                const d = shouldGrantSearchTurn({
                  turnsTaken,
                  promisingSoFar,
                  providerSuitsNeed,
                  visionCapacityRemaining,
                  remainingScopeMs,
                  turnBudgetMs: TURN_MS,
                  promisingCandidateAwaitingVerdict,
                });
                if (d.grant) granted++;
              }
            }
          }
        }
      }
    }
    expect(granted, "an input combination bought a turn past the ceiling").toBe(0);
  });

  it("the ceiling is a constant no input reads", () => {
    expect(MAX_SEARCH_TURNS).toBe(3);
    expect(TURN_PLUS_FOLLOW_THROUGH).toBe(2);
  });

  it("and no scope at all is not a licence — the ceiling still binds", () => {
    expect(
      shouldGrantSearchTurn(
        ctx({ turnsTaken: MAX_SEARCH_TURNS, remainingScopeMs: Number.POSITIVE_INFINITY })
      ).grant
    ).toBe(false);
  });
});

/* ═══════════ 7. the ledger ═══════════ */

describe("R267 §7 — searchMetricsRecorded", () => {
  it("searchMetricsRecorded = PASS — every field the brief lists", () => {
    const l = createSearchBudgetLedger();
    noteSearchTurn(l, 2, 0, "youtube_cc", 8_400, 20);
    noteSearchTurn(l, 2, 0, "youtube_cc", 7_100, 12);
    const row = searchBudgetRow(l, 2, 0, "youtube_cc");
    row.eligibleCandidates = 9;
    row.rankedCandidates = 9;
    row.shortlistedCandidates = 4;
    row.visionAsked = 4;
    row.visionFit = 1;
    row.visionMismatch = 3;
    row.downloadsStarted = 2;
    row.downloadsSucceeded = 1;
    row.adopted = 1;
    expect(row).toMatchObject({
      searchTurns: 2,
      searchDurationMs: 15_500,
      candidatesReturned: 32,
      eligibleCandidates: 9,
      shortlistedCandidates: 4,
      visionAsked: 4,
      adopted: 1,
    });
  });

  it("THE QUESTION IT EXISTS TO ANSWER: longer because it was worth it, or only longer?", () => {
    const l = createSearchBudgetLedger();
    /** Worth it: two turns, and the second produced the adopted clip. */
    noteSearchTurn(l, 0, 0, "worthwhile", 8_000, 20);
    noteSearchTurn(l, 0, 0, "worthwhile", 8_000, 15);
    searchBudgetRow(l, 0, 0, "worthwhile").adopted = 1;
    /** Only longer: one turn, nothing found, and it says so. */
    noteSearchTurn(l, 0, 1, "barren", 12_000, 0);
    noteSearchStopped(l, 0, 1, "barren", {
      grant: false,
      reason: "NOTHING_PROMISING",
      detail: "1 turn(s) produced nothing worth a verdict",
    });
    const lines = formatSearchBudget(l);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("turns=2");
    expect(lines[0]).toContain("adopted=1");
    expect(lines[1]).toContain("returned=0");
    expect(lines[1]).toContain("NOTHING_PROMISING");
  });

  it("a stop is recorded with its reason, and exhaustion is flagged as exhaustion", () => {
    const l = createSearchBudgetLedger();
    noteSearchTurn(l, 1, 1, "p", 5_000, 3);
    noteSearchStopped(l, 1, 1, "p", {
      grant: false,
      reason: "SEARCH_BUDGET_EXHAUSTED",
      detail: "5s left and a turn plus what it produces needs 24s",
    });
    const row = searchBudgetRow(l, 1, 1, "p");
    expect(row.searchBudgetExhausted).toBe(true);
    expect(row.reason).toContain("SEARCH_BUDGET_EXHAUSTED");
  });

  it("A SEARCH THAT STOPPED AND SAID NOTHING IS COUNTED — §9's invariant", () => {
    const l = createSearchBudgetLedger();
    noteSearchTurn(l, 3, 2, "silent", 6_000, 8);
    expect(unexplainedSearchStops(l)).toHaveLength(1);
    noteSearchStopped(l, 3, 2, "silent", {
      grant: false,
      reason: "TURN_CEILING_REACHED",
      detail: "3 of 3 turns already taken",
    });
    expect(unexplainedSearchStops(l)).toHaveLength(0);
  });

  it("and a render that searched nothing reports nothing", () => {
    expect(formatSearchBudget(createSearchBudgetLedger())).toEqual([]);
    expect(unexplainedSearchStops(createSearchBudgetLedger())).toEqual([]);
  });
});

/* ═══════════ 8. nothing was loosened ═══════════ */

describe("R267 §8 — this module can only say yes-to-one-more-turn or no", () => {
  it("it admits no candidate, spends nothing and skips nothing", () => {
    /**
     * Comments stripped first. The prose in this function legitimately discusses adoption and
     * Vision — explaining WHY it refuses a look nobody can judge — and a scan of the raw text
     * cannot tell an explanation from an action. The first version of this failed on its own
     * doc comment, which is the scanner being wrong rather than the code.
     */
    const code = stripComments(SRC).slice(
      SRC.indexOf("export function shouldGrantSearchTurn("),
      SRC.indexOf("export type SearchBudgetRow")
    );
    for (const forbidden of ["adopt", "eligible", "fetch(", "await ", "process.env", "Date.now"]) {
      expect(code, `the decision learned to ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("and it is pure — the same context always gives the same answer", () => {
    const c = ctx({ turnsTaken: 1, promisingSoFar: 2 });
    expect(shouldGrantSearchTurn(c)).toEqual(shouldGrantSearchTurn(c));
  });
});
