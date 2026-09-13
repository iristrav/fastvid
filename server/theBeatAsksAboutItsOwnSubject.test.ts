import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  visualTermsFromIntent,
  contentTermsFromText,
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

describe("an action is not something a camera can point at", () => {
  it("RENDER 580'S BEAT ANCHORS ON THE PERSON, WITH THE VERBS BEHIND HER", () => {
    /**
     * The verbs are not banned from a query — they are banned from BEING one. This module's own
     * note is why: "action last: a verb rarely narrows a search and often widens it". Behind
     * "Kylie Jenner" a verb can only narrow; the defect was `query="illuminate"` going out alone,
     * and that is asserted separately below and in the plan's own filter.
     */
    const terms = visualTermsFromIntent(
      { people: ["Kylie Jenner"], action: ["illuminate", "amplify"] },
      KYLIE_BEAT
    );
    expect(terms.startsWith("Kylie Jenner"), terms).toBe(true);
  });

  it("AN ACTION-ONLY BEAT STILL USES ITS ACTION — an earlier round decided that", () => {
    /**
     * Pinned by `theBeatSaysWhatItIsAbout.test.ts` and correct: "cremation" names an event a camera
     * can be pointed at, and a beat with nothing else is better served by it than by nothing. My
     * first attempt at this round broke it, which is how the rule below found its real shape.
     *
     * What render 580 proved is narrower: an action must not be asked about INSTEAD OF a subject
     * that exists. That belongs in the query filter, not here — see `dropActionOnlyQueries`.
     */
    expect(visualTermsFromIntent({ action: ["cremation"] }, "the cremation took place")).toBe("cremation");
    expect(
      visualTermsFromIntent({ action: ["illuminate", "amplify"] }, KYLIE_BEAT)
    ).not.toBe("");
  });

  it("but an action may still ride along behind a real subject", () => {
    /**
     * Not a ban on verbs — a ban on a verb BEING the subject. "Kylie Jenner" narrows the search and
     * the action can only narrow it further, which is why `visualTermsFromIntent` has always put
     * action last rather than dropping it.
     */
    const terms = visualTermsFromIntent(
      { subject: "Berlin", action: ["marching"] },
      "Troops were marching through Berlin"
    );
    expect(terms).toContain("Berlin");
  });

  it("every other typed category still anchors on its own", () => {
    for (const [label, intent] of [
      ["subject", { subject: "Berlin" }],
      ["people", { people: ["Kylie Jenner"] }],
      ["event", { event: ["coronation"] }],
      ["location", { location: ["Berlin"] }],
      ["period", { period: ["1945"] }],
      ["objects", { objects: ["bunker"] }],
    ] as const) {
      const source = "Kylie Jenner in Berlin in 1945, the coronation, a bunker";
      expect(visualTermsFromIntent(intent as never, source), label).not.toBe("");
    }
  });
});

describe("nothing is admitted that evidence does not support", () => {
  it("AN UNSUPPORTED ENTITY IS STILL REFUSED, EVEN FROM THE INTENT", () => {
    /**
     * The rule the whole round rests on: coming out of `visualTermsFromIntent` is not permission.
     * "New York" is a thing a camera can point at and the beat never said it, so it is not a term
     * this beat may search for — "known in the world, therefore searchable" is exactly the
     * inference this codebase refuses.
     */
    expect(visualTermsFromIntent({ location: ["New York"] }, KYLIE_BEAT)).toBe("");
    expect(visualTermsFromIntent({ objects: ["street"] }, KYLIE_BEAT)).toBe("");
  });

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

  it("FÜHRERBUNKER SURVIVES FOLDING — the word is never truncated at the umlaut", () => {
    /**
     * The failure this guards is `Führerbunker → hrerbunker`: a fold that drops the non-ASCII head
     * of the word and hands a different word to the provider. Asserted as "the term comes back
     * whole", because "does not contain 'hrerbunker'" is not that test — `führerbunker` contains
     * that substring perfectly legitimately.
     */
    const terms = visualTermsFromIntent({ objects: ["Führerbunker"] }, BUNKER);
    expect(terms).toBe("Führerbunker");
    expect(terms.toLowerCase().startsWith("f"), terms).toBe(true);
    expect(termProvableFrom("Führerbunker", BUNKER)).toBe(true);
    /** And the truncated spelling really is a different word, which the evidence rule refuses. */
    expect(termProvableFrom("hrerbunker", BUNKER)).toBe(false);
  });

  it("and folding proves the word the script actually said", () => {
    /** `fuhrerbunker` is the same word as `Führerbunker`; evidence follows the word, not the bytes. */
    expect(termProvableFrom("fuhrerbunker", BUNKER)).toBe(true);
  });

  it("BUT A FOLDED SPELLING OF A WORD THE SCRIPT NEVER SAID IS STILL REFUSED", () => {
    const noBunker = "Kylie Jenner launched Kylie Cosmetics";
    expect(termProvableFrom("fuhrerbunker", noBunker)).toBe(false);
    expect(visualTermsFromIntent({ objects: ["Führerbunker"] }, noBunker)).toBe("");
  });

  it("a multi-word entity is kept whole", () => {
    const terms = visualTermsFromIntent({ people: ["Kylie Jenner"] }, KYLIE_BEAT);
    expect(terms).toBe("Kylie Jenner");
  });
});

describe("no cross-beat contamination", () => {
  it("A BEAT'S TERMS COME FROM ITS OWN EVIDENCE", () => {
    const beat0 = "Kylie Jenner launched Kylie Cosmetics";
    const beat1 = "Berlin was divided in 1961";
    /** Beat 1's intent cannot borrow beat 0's sentence, and neither can the reverse. */
    expect(visualTermsFromIntent({ people: ["Kylie Jenner"] }, beat1)).toBe("");
    expect(visualTermsFromIntent({ location: ["Berlin"] }, beat0)).toBe("");
    expect(visualTermsFromIntent({ location: ["Berlin"] }, beat1)).toContain("Berlin");
  });

  it("THE SEARCH PLAN IS CACHED PER BEAT, NOT PER SCENE", () => {
    /**
     * The key was `s${scene.index}` while the input is `beatText: beat.text`: the first beat of a
     * scene built the plan and every later beat was handed it, terms and all. The audit lines could
     * not show it — they name the beat that ASKED, not the beat the terms came from.
     */
    const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE).toContain("getOrGenerateSearchPlan(`s${scene.index}b${beat.index}`");
    expect(PIPE).not.toContain("getOrGenerateSearchPlan(`s${scene.index}`");
  });
});

describe("the primary retrieval route actually reads it", () => {
  const PLAN = readFileSync(join(__dirname, "visualSearchPlan.ts"), "utf8");
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("visualTermsFromIntent REACHES THE PRIMARY PLAN, not only the rescue", () => {
    /**
     * The structural half of this round. Before it, the function had one production call site —
     * `videoPipeline.ts`'s Wikimedia rescue — and the queries every provider is asked FIRST never
     * saw it. Pinned on behaviour, not a line number.
     */
    expect(PLAN).toContain("visualTermsFromIntent");
    expect(PLAN).toContain("function beatQueryTerms(input: VisualSearchPlanInput)");
  });

  it("BOTH PLAN ROUTES USE THE SAME BUILDER", () => {
    /**
     * The plan route and the planless route (VISUAL_SEARCH_PLAN_ENABLED=false) build the same
     * query. Fixing one and not the other would leave the defect reachable behind a flag.
     */
    expect((PLAN.match(/beatQueryTerms\(input\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the pipeline hands it the beat's own typed intent", () => {
    expect(PIPE).toContain("intent: beatVisualIntent(dedup.beatIntent, scene.index, beat.index)");
  });

  it("contentTermsFromText SURVIVES AS THE FALLBACK", () => {
    /**
     * A beat whose extractors typed nothing is no worse off than it is today. Removing the
     * fallback would have made this round a narrowing of coverage rather than of noise.
     */
    expect(PLAN).toContain("contentTermsFromText(input.beatText, BEAT_QUERY_TERMS)");
    expect(contentTermsFromText("Kylie Jenner launched Kylie Cosmetics")).not.toBe("");
  });

  it("AND NO SECOND TERM EXTRACTOR WAS BUILT", () => {
    /** One engine. `beatQueryTerms` chooses between two existing functions and computes nothing. */
    const fn = PLAN.slice(PLAN.indexOf("function beatQueryTerms"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).not.toMatch(/split\(|match\(|RegExp|filter\(|map\(/);
  });

  it("THE SINGLE-WORD QUERIES ARE FILTERED TOO — where illuminate really came from", () => {
    /**
     * `query="illuminate"` is one WORD, so it was never the joined term list: it came from
     * `profile.searchTiers[0]`, which this module sends as its own query at confidence 0.9, ahead
     * of everything else. Repairing only `beatQueryTerms` would have left the measured symptom
     * exactly where it was.
     */
    expect(PLAN).toContain("function dropActionOnlyQueries");
    expect(PLAN).toContain("dropActionOnlyQueries(");
    const at = PLAN.indexOf("const primary = dropActionOnlyQueries(");
    expect(at, "the primary round is no longer filtered").toBeGreaterThan(-1);
    expect(PLAN.slice(at, at + 400)).toContain("tier0.map");
  });

  it("and the filter is narrow — only THIS beat's own typed actions", () => {
    /**
     * It drops a query only when EVERY content word is a term the beat's own extractors typed as
     * an action. A verb the intent never typed is left alone: this round repairs the term source,
     * it does not start judging vocabulary it has no evidence about.
     */
    const fn = PLAN.slice(PLAN.indexOf("function dropActionOnlyQueries"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("intent?.action ?? []");
    expect(body).toContain("if (actions.size === 0) return queries;");
    expect(body).toContain("words.every");
    /**
     * And the third narrowing: when the actions are ALL the beat typed, nothing is dropped. An
     * earlier round pinned that deliberately — a beat about a cremation and nothing else is better
     * served by "cremation" than by silence.
     */
    expect(body).toContain("if (!hasVisualAnchor) return queries;");
    /** Never a hardcoded verb list — that would be a second vocabulary to drift from. */
    expect(body).not.toMatch(/"illuminate"|"amplify"|VERB|verbs/i);
  });

  it("the Search Gate is still the last word", () => {
    /** Nothing here marks a query verified, allowed, or exempt from validation. */
    const fn = PLAN.slice(PLAN.indexOf("function beatQueryTerms"));
    expect(fn.slice(0, fn.indexOf("\n}"))).not.toMatch(/verified|allowed|bypass|skipGate/i);
  });
});
