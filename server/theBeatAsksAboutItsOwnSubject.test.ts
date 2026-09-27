import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  
  
  termProvableFrom,
  hasContentAnchor,
} from "./searchQueryContract";

/**
 * P0 — THE BEAT ASKS ABOUT WHAT IT IS ABOUT, NOT ABOUT ITS FIRST FOUR WORDS.
 *
 * ── What render 580 measured ────────────────────────────────────────────────────────────────
 *
 *     beat  "Rumors about Kylie Jenner illuminate how they amplify her celebrity"
 *
 *     scene=2 beat=0 query="kylie"        terms=["Kylie Jenner"] reason=OK
 *     scene=2 beat=0 query="jenner"       terms=["Kylie Jenner"] reason=OK
 *     scene=2 beat=0 query="illuminate"   terms=["Kylie Jenner"] reason=OK        ← allowed
 *     scene=2 beat=0 query="street"       terms=["Kylie Jenner"] reason=UNVERIFIED_TERM
 *     scene=2 beat=0 query="documentary"  terms=["Kylie Jenner"] reason=NO_CONTENT_ANCHOR
 *
 *     [Quality] Video 580: beat image gate — attempts=98 answered=94
 *                          (fits=8 does_not_fit=86) failed=4
 *
 * Eighty-six refusals out of ninety-four answered judgements. The editor was right every time; it
 * was being shown footage fetched for a verb.
 *
 * ── The two halves of the break ─────────────────────────────────────────────────────────────
 *
 * A. `hasContentAnchor` asks three NEGATIVE questions — not a production word, not a function
 *    word, not an abstraction. "illuminate" is none of those, so it counted as a subject.
 *
 * B. `visualTermsFromIntent`, which asks the positive question, was wired into exactly ONE
 *    production call site: the Wikimedia rescue at the bottom of the ladder. The primary plan —
 *    the queries every provider is asked FIRST — used `contentTermsFromText`, which walks the
 *    narration in reading order. RONDE 577 had already measured that as "shaped"×11 "life"×10
 *    "evidence"×10 and written the replacement; the replacement reached one route of several.
 *
 * ── What this round does NOT do ─────────────────────────────────────────────────────────────
 *
 * Loosen anything. Every term still passes `termProvableFrom`, so what reaches a provider is a
 * SUBSET of what reached it before. `street`, `documentary`, `establishing` and `other` stay
 * blocked, and the Search Gate remains the last word.
 */

const KYLIE_BEAT = "Rumors about Kylie Jenner illuminate how they amplify her celebrity";

describe("nothing is admitted that evidence does not support", () => {

  it("and the gate's own measure is still the filter", () => {
    expect(termProvableFrom("Kylie Jenner", KYLIE_BEAT)).toBe(true);
    expect(termProvableFrom("New York", KYLIE_BEAT)).toBe(false);
    expect(termProvableFrom("street", KYLIE_BEAT)).toBe(false);
  });

  it("THE GENERIC SHOT VOCABULARY STAYS BLOCKED", () => {
    /** Unchanged, and asserted because a round about anchors could break it without noticing. */
    for (const word of ["documentary", "establishing", "other", "wide", "aerial", "b-roll"]) {
      expect(hasContentAnchor(word), word).toBe(false);
    }
  });

  it("a real query still passes", () => {
    expect(hasContentAnchor("Kylie Jenner")).toBe(true);
    expect(hasContentAnchor("Berlin 1945")).toBe(true);
  });
});

describe("normalisation is not semantic permission", () => {
  const BUNKER = "The Führerbunker in Berlin was sealed in 1945";

  it("and folding proves the word the script actually said", () => {
    /** `fuhrerbunker` is the same word as `Führerbunker`; evidence follows the word, not the bytes. */
    expect(termProvableFrom("fuhrerbunker", BUNKER)).toBe(true);
  });
});

describe("the primary retrieval route actually reads it", () => {
  const PLAN = readFileSync(join(__dirname, "visualSearchPlan.ts"), "utf8");
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("AND NO SECOND TERM EXTRACTOR WAS BUILT", () => {
    /** One engine. `beatQueryTerms` chooses between two existing functions and computes nothing. */
    const fn = PLAN.slice(PLAN.indexOf("function beatQueryTerms"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).not.toMatch(/split\(|match\(|RegExp|filter\(|map\(/);
  });

  it("the Search Gate is still the last word", () => {
    /** Nothing here marks a query verified, allowed, or exempt from validation. */
    const fn = PLAN.slice(PLAN.indexOf("function beatQueryTerms"));
    expect(fn.slice(0, fn.indexOf("\n}"))).not.toMatch(/verified|allowed|bypass|skipGate/i);
  });
});
