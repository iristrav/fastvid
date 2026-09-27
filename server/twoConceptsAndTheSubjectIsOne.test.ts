/**
 * TWO CONCEPTS, AND THE SUBJECT IS ONE OF THEM.
 *
 * ── What render 593 sent to real providers ──────────────────────────────────────────────────
 *
 *     "Rumors kardashians Kardashians"     a sentence, with the subject said twice
 *     "it's documentary footage"           four words, and not one of them a subject
 *     "masterclass other"                  two content words that name nothing to photograph
 *     "single day" · "news other"          the same failure, twice more
 *     "sword tuned" · "shaped"             the sentence's grammar standing in for its picture
 *
 * Those are two different defects wearing one symptom. Some queries are too long; the rest are
 * the wrong two words. A cap repairs only the first kind, and `ensureSubjectAnchor` — which puts
 * the subject back in front — repairs only the last. `narrowToSubjectPlusConcept` is where the
 * two meet: keep the subject whole, then CHOOSE one concept to stand beside it.
 *
 * ── The line this file exists to hold ───────────────────────────────────────────────────────
 *
 * `query.split(" ").slice(0, 2)` would pass a naive length test and fail every case that matters:
 * on "Kim Kardashian launched a new beauty collection" it returns the subject and nothing about
 * the beat; on "The Titanic sank in 1912" it returns "The Titanic". So the tests below are not
 * about length. Each one names the concept that must survive, and several assert that a
 * truncation could not have produced the answer.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { narrowToSubjectPlusConcept, semanticConceptCount } from "./searchQueryContract";
import {    } from "./visualSearchPlan";
import { buildBeatQueryEscalationTiers } from "./videoPipeline";

/** A beat's typed concepts, in the shape the planner produces them. */
function intent(over: Record<string, string[]> = {}) {
  return { event: [], location: [], period: [], objects: [], action: [], people: [], ...over };
}

/* ═══════════════════════ §9 — the subject is never traded away ═══════════════════════ */

describe("the main subject survives everything", () => {
  it("a beat with a subject and no usable concept searches for the subject alone", () => {
    const out = narrowToSubjectPlusConcept(
      "Kim Kardashian other stuff things",
      "Kim Kardashian",
      intent()
    );
    expect(out.query).toBe("Kim Kardashian");
    expect(out.concepts).toEqual(["Kim Kardashian"]);
  });

  it("A CATEGORY CANNOT REPLACE THE SUBJECT", () => {
    /**
     * The defect `de1c88b` closed, asserted again at this layer. Nothing in this function reads a
     * category table, so the only way "celebrity" could reach the output is by being in the
     * narration — and then it is a concept beside the subject, never instead of it.
     */
    const out = narrowToSubjectPlusConcept(
      "Kim Kardashian celebrity",
      "Kim Kardashian",
      intent({ objects: ["celebrity"] })
    );
    expect(out.query.startsWith("Kim Kardashian")).toBe(true);
    expect(out.concepts[0]).toBe("Kim Kardashian");
    expect(out.query).not.toBe("celebrity");
  });

  it("a multi-word subject is ONE concept, not two terms", () => {
    const out = narrowToSubjectPlusConcept(
      "Kim Kardashian beauty",
      "Kim Kardashian",
      intent({ objects: ["beauty"] })
    );
    expect(semanticConceptCount(out.query, "Kim Kardashian")).toBe(2);
    /** Without the anchor the same string is three content words — which is why it is passed. */
    expect(semanticConceptCount(out.query, "")).toBe(3);
  });

  it("no proven subject means no invented one", () => {
    /** §6's rule, reaching this function unchanged from `ensureSubjectAnchor`. */
    const out = narrowToSubjectPlusConcept("Berlin 1945", "", intent({
      location: ["Berlin"],
      period: ["1945"],
    }));
    expect(out.query).toBe("Berlin 1945");
    expect(out.concepts).toEqual(["Berlin", "1945"]);
  });
});

/* ═══════════════════════ §14 — the negative cases, by name ═══════════════════════ */

describe("the queries render 593 actually sent cannot be produced", () => {
  const FORBIDDEN: Array<[string, string, ReturnType<typeof intent>]> = [
    ["news other", "", intent()],
    ["masterclass other", "", intent()],
    ["single day", "", intent()],
    ["sword tuned", "", intent()],
    ["it's documentary footage", "", intent()],
    ["news kim", "", intent()],
  ];

  for (const [query, anchor, i] of FORBIDDEN) {
    it(`"${query}" does not survive as a query`, () => {
      const out = narrowToSubjectPlusConcept(query, anchor, i);
      expect(out.query).not.toBe(query);
    });
  }

  it("PADDING WORDS ARE NOT CONCEPTS", () => {
    /** §11's list, each one measured in a production log rather than imagined. */
    for (const pad of [
      "news", "video", "footage", "documentary", "latest", "official",
      "other", "single", "day", "masterclass", "tuned", "thing", "stuff",
    ]) {
      const out = narrowToSubjectPlusConcept(`Marie Curie ${pad}`, "Marie Curie", intent());
      expect(out.query, `"${pad}" became a search term`).toBe("Marie Curie");
    }
  });
});

/* ═══════════════════════ §12 — a category is not a visual concept ═══════════════════════ */

describe("§12 — the second term has to name something you could photograph", () => {
  /**
   * The beat every case below is judged against. It is one sentence, and it is the ONLY evidence
   * admitted: a word this sentence does not contain cannot be this beat's visual concept, whatever
   * tier or simplification supplied it.
   */
  const BEAT = "Kim Kardashian launched a new beauty collection and the rumors filled the news.";

  const ACCEPTED: Array<[string, string]> = [
    ["beauty", "Kim Kardashian beauty"],
    ["rumors", "Kim Kardashian rumors"],
  ];
  const REFUSED = ["celebrity", "news", "documentary", "footage", "video", "official", "other"];

  for (const [term, expected] of ACCEPTED) {
    it(`Kim Kardashian + ${term} → "${expected}"`, () => {
      const out = narrowToSubjectPlusConcept(
        `Kim Kardashian ${term}`,
        "Kim Kardashian",
        intent(),
        BEAT
      );
      expect(out.query).toBe(expected);
      expect(semanticConceptCount(out.query, "Kim Kardashian")).toBe(2);
    });
  }

  for (const term of REFUSED) {
    it(`Kim Kardashian + ${term} → the subject alone, NOT "Kim Kardashian ${term}"`, () => {
      const out = narrowToSubjectPlusConcept(
        `Kim Kardashian ${term}`,
        "Kim Kardashian",
        intent(),
        BEAT
      );
      expect(out.query, `"${term}" became this beat's visual concept`).toBe("Kim Kardashian");
      /** §10 — and the subject is what survives, never the category. */
      expect(out.query).not.toBe(term);
      expect(out.concepts).toEqual(["Kim Kardashian"]);
    });
  }

  it("THE DIFFERENCE IS THE BEAT, NOT A LIST OF WORDS", () => {
    /**
     * §9's requirement, made falsifiable. `celebrity` is refused above because THIS beat does not
     * say it — not because the word is special. Give it a beat that does say it, and it is that
     * beat's concept like any other word.
     */
    const saysIt = "The celebrity walked past Kim Kardashian without looking.";
    const out = narrowToSubjectPlusConcept(
      "Kim Kardashian celebrity",
      "Kim Kardashian",
      intent(),
      saysIt
    );
    expect(out.query, "the rule is keyed on the word rather than on the evidence").toBe(
      "Kim Kardashian celebrity"
    );
  });

  it("NO HARDCODED CATEGORY COMPARISON ANYWHERE IN THE POLICY", () => {
    /** §9 in the source: the distinction may not be `if (term === "celebrity")`. */
    const contract = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");
    const policy = contract.slice(contract.indexOf("export function narrowToSubjectPlusConcept"));
    for (const word of ["celebrity", "fashion", "beauty", "rumors"]) {
      expect(
        policy.toLowerCase().includes(`"${word}"`),
        `the policy names "${word}" — that is a blacklist, not a measure`
      ).toBe(false);
    }
    /** It uses the gate's own evidence measure instead. */
    expect(policy).toContain("termProvableFrom");
  });

  it("THE PADDING SET STAYS SMALL — §8", () => {
    /**
     * The set is allowed and is deliberately not the mechanism. It holds words that are empty in
     * EVERY beat, including beats that contain them ("news" is in this file's own fixture). A set
     * that grew past a few dozen would be the brittle list §8 forbids.
     */
    const contract = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");
    const block = contract.slice(
      contract.indexOf("const EMPTY_CONCEPT_WORDS"),
      contract.indexOf("/** Is this word capable of being the concept half")
    );
    const words = [...block.matchAll(/"([^"]+)"/g)].length;
    expect(words, `the padding set has grown to ${words} words`).toBeLessThanOrEqual(60);
  });

  it("a subject-only query is a PASS, not a failure to find a second term", () => {
    const out = narrowToSubjectPlusConcept(
      "Kim Kardashian celebrity",
      "Kim Kardashian",
      intent(),
      BEAT
    );
    expect(out.query).toBe("Kim Kardashian");
    expect(semanticConceptCount(out.query, "Kim Kardashian")).toBe(1);
    /** §13 — two is a ceiling, not a quota. */
    expect(semanticConceptCount(out.query, "Kim Kardashian")).toBeLessThanOrEqual(2);
  });

  it("A TYPED CONCEPT IS NOT SILENCED BY THE EVIDENCE RULE", () => {
    /**
     * The case that decides where the rule may be applied. The planner types "The Titanic sank in
     * 1912" as `event: sinking`; `sank` does not stem to `sinking`, so requiring the typed concept
     * to be provable from the sentence would return `Titanic` and lose the beat entirely.
     *
     * Typed concepts are the beat's own semantic model and were put through `termProvableFrom`
     * where they were built. The evidence rule applies to words scavenged from the QUERY.
     */
    const sentence = "The Titanic sank in 1912 after hitting an iceberg";
    const out = narrowToSubjectPlusConcept(
      sentence,
      "Titanic",
      intent({ event: ["sinking"], objects: ["iceberg"] }),
      sentence
    );
    expect(out.query).toBe("Titanic sinking");
  });
});

/* ═══════════════════════ §13 — the policy runs before the adapters ═══════════════════════ */

describe("§13 — one policy, applied once, where the adapters cannot undo it", () => {
  const PLAN = readFileSync(join(__dirname, "visualSearchPlan.ts"), "utf8");

  it("NO TRUNCATION ANYWHERE IN THE POLICY", () => {
    /**
     * §16, as a property of the source. A `slice(0, 2)` over words would satisfy every count in
     * this file and none of its meaning, so the shape itself is forbidden.
     */
    const contract = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");
    const policy = contract.slice(contract.indexOf("export function narrowToSubjectPlusConcept"));
    expect(policy).not.toMatch(/\.split\([^)]*\)\s*\.slice\(0,\s*2\)/);
    expect(policy).not.toMatch(/words\.slice\(0,\s*2\)/);
  });
});
