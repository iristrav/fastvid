/**
 * RONDE 214 — THE QUERY CONTRACT ONLY KNEW ENGLISH GRAMMAR, AND THIS PIPELINE NARRATES IN DUTCH.
 *
 * ── How it surfaced ─────────────────────────────────────────────────────────────────────────
 *
 * A production render reported `Scene 0: 4 zinnen maar 0 voice/script-matchende clips — export
 * geblokkeerd`, on a render made AFTER RONDE 213 shipped. RONDE 213 reduces a narration sentence
 * to its first four content words. Measured on Dutch narration, before this round:
 *
 *     "Het was een van de grootste rampen uit de Nederlandse geschiedenis."
 *         → "Het een van de"              four grammar words; nothing to search for
 *     "De eerste bewoners van het eiland bouwden hun huizen op palen in het veen."
 *         → "De eerste bewoners van"      half the query spent on grammar
 *
 * `FUNCTION_WORDS` was English-only — its own comment said so — so "de", "het", "een" and "van"
 * were read as SUBJECTS. Before RONDE 213 that was a quiet inaccuracy, because the whole sentence
 * went out and the content words were in it somewhere. The four-word cap turned it into a query
 * with no subject at all.
 *
 * `hasContentAnchor` could not catch it: those words are in neither the English function set nor
 * the production vocabulary, so the query read as having a subject and was sent.
 *
 * ── This is a regression this round owns ────────────────────────────────────────────────────
 *
 * RONDE 213 made Dutch renders worse than they were. The gap it exposed is older, but the harm is
 * new, and this file exists so that the next language this product speaks is a failing test rather
 * than a blocked export.
 */
import { describe, expect, it } from "vitest";

import {
  DUTCH_FUNCTION_WORDS,
  FUNCTION_WORDS,
  checkPersonName,
  contentTermsFromText,
  hasContentAnchor,
  isFunctionWord,
  isNameParticleToken,
  validateSearchQuery,
} from "./searchQueryContract";

/** Real Dutch documentary narration, and what a provider should be asked for each. */
const DUTCH_NARRATION: Array<[string, string]> = [
  [
    "De eerste bewoners van het eiland bouwden hun huizen op palen in het veen.",
    "eerste bewoners eiland bouwden",
  ],
  [
    "In de winter van 1953 brak de Noordzee door de dijken en verdronken meer dan achttienhonderd mensen.",
    "winter 1953 brak Noordzee",
  ],
  [
    "Het was een van de grootste rampen uit de Nederlandse geschiedenis.",
    "grootste rampen Nederlandse geschiedenis",
  ],
  ["De fabriek sloot na veertig jaar zijn deuren.", "fabriek sloot veertig jaar"],
];

/* ═══════════ 1. the sentences that produced the blocked export ═══════════ */

describe("R214 §1 — Dutch narration reduces to Dutch subjects", () => {
  it.each(DUTCH_NARRATION)("%s", (sentence, expected) => {
    expect(contentTermsFromText(sentence, 4)).toBe(expected);
  });

  it("THE EXACT QUERY THAT HAD NO SUBJECT IN IT", () => {
    const before = "Het een van de";
    // Every word of it is grammar, so it can no longer be built OR accepted.
    for (const w of before.split(" ")) expect(isFunctionWord(w), w).toBe(true);
    expect(hasContentAnchor(before)).toBe(false);
    expect((validateSearchQuery(before) as any).reason).toBe("NO_CONTENT_ANCHOR");
  });

  it("no reduced Dutch query is made only of grammar", () => {
    for (const [sentence] of DUTCH_NARRATION) {
      const q = contentTermsFromText(sentence, 4);
      expect(q, `"${sentence}" produced nothing`).not.toBe("");
      expect(q.split(" ").some((w) => !isFunctionWord(w)), `"${q}" is all grammar`).toBe(true);
      expect((validateSearchQuery(q) as any).ok).toBe(true);
    }
  });

  it("a cap of four now buys four subjects, not four articles", () => {
    const q = contentTermsFromText(DUTCH_NARRATION[2]![0], 4);
    expect(q.split(" ")).toHaveLength(4);
    for (const w of q.split(" ")) expect(isFunctionWord(w), `${w} is grammar`).toBe(false);
  });
});

/* ═══════════ 2. what must not have broken ═══════════ */

describe("R214 §2 — the name particles still build names", () => {
  it.each(["Vincent van Gogh", "Charles de Gaulle", "Ludwig van Beethoven", "Winston Churchill"])(
    "%s is still a person",
    (name) => {
      expect((checkPersonName(name, name) as any).ok, name).toBe(true);
    }
  );

  it("the particles are function words AND particles, and the particle rule runs first", () => {
    /**
     * This is the collision that made the change risky: "de", "van", "den", "der", "ten" and "ter"
     * are Dutch grammar AND Dutch surname particles. `checkPersonName` matches
     * `isNameParticleToken` and `continue`s before `blocksPersonName` is ever asked, which is why
     * both can be true at once without "Vincent van Gogh" falling apart.
     */
    for (const p of ["de", "van", "den", "der", "ten", "ter"]) {
      expect(isNameParticleToken(p), p).toBe(true);
      expect(isFunctionWord(p), p).toBe(true);
    }
  });

  it("a particle alone is still not a name", () => {
    expect((checkPersonName("de Gaulle", "de Gaulle") as any).ok).toBe(false);
    expect((checkPersonName("Hermann de", "Hermann de") as any).ok).toBe(false);
  });

  it("ENGLISH IS UNTOUCHED — the round adds a language, it does not change one", () => {
    expect(contentTermsFromText("The first settlers built their houses on wooden piles.", 4)).toBe(
      "first settlers built houses"
    );
    expect(contentTermsFromText("Nobody had expected the water to rise that quickly.", 4)).toBe(
      "Nobody expected water rise"
    );
    for (const w of ["the", "and", "of", "with", "was", "have"]) {
      expect(isFunctionWord(w), w).toBe(true);
    }
  });

  it("the gate's other refusals are unchanged", () => {
    expect((validateSearchQuery("documentary establishing aerial") as any).reason).toBe(
      "NO_CONTENT_ANCHOR"
    );
    expect((validateSearchQuery("She walked into the hall") as any).reason).toBe(
      "FORBIDDEN_PRONOUN"
    );
  });
});

/* ═══════════ 3. the list itself ═══════════ */

describe("R214 §3 — the Dutch closed class", () => {
  it("every Dutch word is reachable through the one predicate", () => {
    for (const w of DUTCH_FUNCTION_WORDS) {
      expect(FUNCTION_WORDS.has(w), w).toBe(true);
      expect(isFunctionWord(w), w).toBe(true);
    }
  });

  it("it is lower case and free of duplicates", () => {
    expect(DUTCH_FUNCTION_WORDS).toEqual(DUTCH_FUNCTION_WORDS.map((w) => w.toLowerCase()));
    expect(new Set(DUTCH_FUNCTION_WORDS).size).toBe(DUTCH_FUNCTION_WORDS.length);
  });

  it('"WEER" IS DELIBERATELY ABSENT — a documentary about weather needs the noun', () => {
    expect(DUTCH_FUNCTION_WORDS).not.toContain("weer");
    expect(contentTermsFromText("Het weer sloeg om boven de Noordzee.", 4)).toContain("weer");
  });

  it("no Dutch content noun crept into the closed class", () => {
    for (const noun of ["water", "dijk", "stad", "oorlog", "fabriek", "eiland", "winter", "mensen"]) {
      expect(isFunctionWord(noun), `${noun} was swallowed as grammar`).toBe(false);
    }
  });

  it("the pronoun REJECTION list is not widened — only the grammar list is", () => {
    /**
     * `FORBIDDEN_PERSON_PRONOUNS` drives an outright query refusal. Dutch pronouns are stripped as
     * grammar here, which is a reduction; making them a rejection reason would be a different and
     * larger change than the evidence supports.
     */
    expect((validateSearchQuery("Zij liep de zaal binnen") as any).reason).not.toBe(
      "FORBIDDEN_PRONOUN"
    );
  });
});
