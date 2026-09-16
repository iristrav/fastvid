/**
 * RONDE 265 — HARD CONSTRAINTS ARE NOT LOUD SOFT SIGNALS.
 *
 * ── The production measurement ──────────────────────────────────────────────────────────────
 *
 *     focus = event
 *
 *     primaryEntity   +0      narration   +96
 *     secondaryEntity +5      visual      +44
 *     event           +0
 *     location        +0      negativeEvidence  -6
 *     object          +0
 *     date            +0      finalScore       +139
 *     place           +0
 *     eventPhrase     +0
 *     action          +0
 *
 * A candidate that matched the beat on NOTHING the beat was about ranked first, on 139. The two
 * terms that carried it — how the narration reads and how the picture looks — are the two that
 * say least about whether this is the right footage for this sentence.
 *
 * ── Why a weight change would not have fixed it ─────────────────────────────────────────────
 *
 * The sort is one flat sum. Raising the event term or lowering the narration term moves a
 * threshold; it does not change a shape. Any soft signal large enough still buys its way past any
 * hard one, and the next render finds a different pair of numbers that does it. §2 proves that
 * directly: the mismatched candidate is given a HUGE soft score and still loses.
 *
 * What was missing is a KIND, not a WEIGHT. A beat that names an event, a place and a period has
 * said three things that are true or false about a candidate — not more or less true.
 *
 * ── The four things this is not ─────────────────────────────────────────────────────────────
 *
 * Not a gate (§4), not a new weight (§5), not a second scorer (§5), and inert on beats that state
 * nothing (§3). Each is a test, because a ranking term that learned to reject would be the second
 * selection engine the brief forbids.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  compareHardMatch,
  documentaryHardMatch,
  formatHardMatch,
  type BeatVisualIntent,
  type HardMatchSignals,
} from "./beatVisualIntent";
import { stripComments } from "./sourceScan.test.support";

const CODE = stripComments(fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8"));

/** The §45 fixture: Kim Kardashian, Los Angeles County, 2024, defamation lawsuit. */
const BEAT: BeatVisualIntent = {
  sceneIndex: 2,
  beatIndex: 0,
  subject: "Kim Kardashian",
  action: ["sued"],
  event: ["defamation lawsuit"],
  location: ["Los Angeles County"],
  period: ["2024"],
  people: ["Kim Kardashian"],
  objects: [],
  evidenceRequirement: "hard",
  preferredShot: "medium",
  fallbackClass: "person",
  narrativePurpose: "establish",
  forbidden: [],
  foldedTerms: [],
};

const NOTHING_STATED: BeatVisualIntent = {
  ...BEAT,
  action: [],
  event: [],
  location: [],
  period: [],
};

const sig = (over: Partial<HardMatchSignals> = {}): HardMatchSignals => ({
  event: 0,
  eventPhrase: 0,
  location: 0,
  place: 0,
  date: 0,
  action: 0,
  ...over,
});

/** Candidate A — the right footage: the event, the place, the period and the action. */
const CANDIDATE_A = sig({ event: 6, location: 4, date: 3, action: 2 });
/** Candidate B — superficially similar: the right sort of person, and nothing else. */
const CANDIDATE_B = sig();

/* ═══════════ 1. the key itself ═══════════ */

describe("R265 §1 — what the beat requires, and whether the candidate shows it", () => {
  it("THE §45 FIXTURE: A satisfies four stated requirements, B satisfies none", () => {
    expect(documentaryHardMatch(BEAT, CANDIDATE_A)).toEqual({
      stated: 4,
      satisfied: 4,
      met: ["event", "place", "period", "action"],
      missed: [],
    });
    expect(documentaryHardMatch(BEAT, CANDIDATE_B)).toMatchObject({
      stated: 4,
      satisfied: 0,
      missed: ["event", "place", "period", "action"],
    });
  });

  it("a requirement the beat never made cannot be missed", () => {
    expect(documentaryHardMatch(NOTHING_STATED, CANDIDATE_B)).toEqual({
      stated: 0,
      satisfied: 0,
      met: [],
      missed: [],
    });
  });

  it("event and eventPhrase are one fact at two resolutions, as the sum already treats them", () => {
    expect(documentaryHardMatch(BEAT, sig({ eventPhrase: 5 })).met).toContain("event");
    expect(documentaryHardMatch(BEAT, sig({ event: 5 })).met).toContain("event");
  });

  it("and so are location and place", () => {
    expect(documentaryHardMatch(BEAT, sig({ place: 5 })).met).toContain("place");
    expect(documentaryHardMatch(BEAT, sig({ location: 5 })).met).toContain("place");
  });

  it("no intent at all is inert, not an error", () => {
    expect(documentaryHardMatch(null, CANDIDATE_A).stated).toBe(0);
    expect(documentaryHardMatch(undefined, CANDIDATE_A).stated).toBe(0);
  });
});

/* ═══════════ 2. hardMismatchOverridePrevented ═══════════ */

describe("R265 §2 — a loud soft score cannot buy its way past a hard requirement", () => {
  const A = documentaryHardMatch(BEAT, CANDIDATE_A);
  const B = documentaryHardMatch(BEAT, CANDIDATE_B);

  it("AC-P0-07: the candidate that meets the beat's requirements ranks first", () => {
    expect(compareHardMatch(A, B), "B ranked above A").toBeLessThan(0);
    expect(compareHardMatch(B, A)).toBeGreaterThan(0);
  });

  it("hardMismatchOverridePrevented — and this is the whole point", () => {
    /**
     * The comparator sees ONLY the hard requirements. There is no soft score large enough to
     * appear in it, which is exactly why a weight change could never have settled this: the
     * mismatched candidate's 96 and 44 have no way in.
     */
    const src = fs.readFileSync(path.join(__dirname, "beatVisualIntent.ts"), "utf8");
    const fn = src.slice(
      src.indexOf("export function compareHardMatch("),
      src.indexOf("export function formatHardMatch(")
    );
    expect(fn, "a soft term reached the hard comparison").not.toMatch(
      /narration|visual|finalScore|score/i
    );
    expect(fn).toContain("return b.satisfied - a.satisfied;");
  });

  it("partial credit counts: three of four beats two of four", () => {
    const three = documentaryHardMatch(BEAT, sig({ event: 1, location: 1, date: 1 }));
    const two = documentaryHardMatch(BEAT, sig({ event: 1, location: 1 }));
    expect(compareHardMatch(three, two)).toBeLessThan(0);
  });

  it("EQUAL COUNTS ARE A TIE — which requirement was missed is not this key's judgement", () => {
    /**
     * Two candidates that each satisfy two of four, with DIFFERENT twos and different names, so a
     * key that quietly started ordering on which requirement was met — or on how the names sort —
     * would show up here. A first version of this used two candidates whose met-lists began with
     * the same word, and a mutation that ordered by exactly that sailed through it.
     */
    const placeAndPeriod = documentaryHardMatch(BEAT, sig({ location: 1, date: 1 }));
    const eventAndAction = documentaryHardMatch(BEAT, sig({ event: 1, action: 1 }));
    expect(placeAndPeriod.satisfied).toBe(2);
    expect(eventAndAction.satisfied).toBe(2);
    expect(placeAndPeriod.met).toEqual(["place", "period"]);
    expect(eventAndAction.met).toEqual(["event", "action"]);
    expect(
      compareHardMatch(placeAndPeriod, eventAndAction),
      "the key started ranking one missed requirement above another"
    ).toBe(0);
    expect(compareHardMatch(eventAndAction, placeAndPeriod)).toBe(0);
  });
});

/* ═══════════ 3. inert where the beat said nothing ═══════════ */

describe("R265 §3 — a beat that states nothing is ordered exactly as before", () => {
  it("two candidates under a silent beat are a tie, so the existing score decides", () => {
    const a = documentaryHardMatch(NOTHING_STATED, CANDIDATE_A);
    const b = documentaryHardMatch(NOTHING_STATED, CANDIDATE_B);
    expect(compareHardMatch(a, b)).toBe(0);
  });

  it("and the sort falls through to the comparator it always used", () => {
    const at = CODE.indexOf("const hard = compareHardMatch(hardMatchOf(a), hardMatchOf(b));");
    expect(at, "the hard key is not in the sort").toBeGreaterThan(-1);
    const block = CODE.slice(at, at + 500);
    expect(block).toContain("if (hard !== 0) return hard;");
    expect(block, "the existing comparator was replaced rather than preceded").toContain(
      "return compareBeatCandidates("
    );
  });
});

/* ═══════════ 4. it orders, it never refuses ═══════════ */

describe("R265 §4 — not a gate", () => {
  it("A CANDIDATE THAT SATISFIES NOTHING IS STILL IN THE POOL, just lower", () => {
    /**
     * The property that keeps this a ranking term. `compareHardMatch` returns an ORDER; there is
     * no path through it that removes a candidate, and the sort it feeds returns every path it was
     * given. A scorer that could also reject would be the second selection engine the brief
     * forbids, and would turn a planning gap into a coverage gap.
     */
    const src = fs.readFileSync(path.join(__dirname, "beatVisualIntent.ts"), "utf8");
    const fn = src.slice(
      src.indexOf("export function compareHardMatch("),
      src.indexOf("export function formatHardMatch(")
    );
    for (const forbidden of ["filter", "reject", "eligible", "throw", "return null"]) {
      expect(fn, `the comparator learned to ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the sort still returns every candidate it was handed", () => {
    const at = CODE.indexOf("const sortedPaths = [...paths].sort((a, b) => {");
    expect(at).toBeGreaterThan(-1);
    const block = CODE.slice(at, at + 700);
    expect(block, "the sort became a filter").not.toContain(".filter(");
  });

  it("and the vision gate is untouched — ranking order is not a verdict", () => {
    expect(CODE).toContain("declareVisionReviewPool(");
  });
});

/* ═══════════ 5. no weight moved, no second scorer ═══════════ */

describe("R265 §5 — the existing sum is byte-for-byte what it was", () => {
  it("candidateScore still sums exactly the terms it summed", () => {
    expect(CODE).toContain(
      "scoreVisualRelevance(`${sourceQuery} ${path.basename(p)} ${beatText}`, keywords) +"
    );
    expect(CODE).toContain("scoreBeatNarrationMatch(beatText, sourceQuery, p) * 4 +");
    expect(CODE).toContain("realEntityScore(entityRules, sourceQuery, p) +");
    expect(CODE).toContain("nextLevelScore(p) +");
  });

  it("THE HARD KEY READS SIGNALS THE SHARED SCORER ALREADY PRODUCED", () => {
    const at = CODE.indexOf("const hardMatchOf = (p: string) => {");
    expect(at).toBeGreaterThan(-1);
    const block = CODE.slice(at, at + 600);
    expect(block, "a second scorer was built for the hard key").toContain(
      "scoreCandidateAgainstBeat("
    );
    expect(block).toContain("documentaryHardMatch(_intent, sig)");
  });

  it("and it is memoised, so a sort cannot pay for it O(n log n) times", () => {
    expect(CODE).toContain("const hardMatchCache = new Map<string,");
  });

  it("the decision is readable back from the log", () => {
    expect(CODE).toContain("formatHardMatch(sceneIndex, beatIndex, winnerHard,");
    expect(
      formatHardMatch(2, 0, documentaryHardMatch(BEAT, CANDIDATE_A), documentaryHardMatch(BEAT, CANDIDATE_B))
    ).toBe(
      "[HardMatch] s2b0 winner=4/4 met=[event,place,period,action] " +
        "runnerUp=0/4 missed=[event,place,period,action] — the hard requirements decided this, not the score"
    );
  });

  it("and it says nothing when the hard requirements did not decide", () => {
    const tie = documentaryHardMatch(BEAT, CANDIDATE_A);
    expect(formatHardMatch(2, 0, tie, tie)).not.toContain("decided this");
  });
});
