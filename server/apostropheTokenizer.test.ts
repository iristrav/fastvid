/**
 * PRODUCTION FIX — contractions must not become search terms.
 *
 * ── The production evidence this comes from ──────────────────────────────────────────────────
 *
 * The first real Railway render (Stauffenberg / Hitler / Berlin) sent these to providers:
 *
 *     [SearchQueryRejected] query="didn know hitler"  term="didn"  reason=TITLE_INFERENCE_NOT_ALLOWED
 *     [SearchQueryRejected] query="this dissent didn" term="didn"  reason=TITLE_INFERENCE_NOT_ALLOWED
 *
 * `didn` is not a word anybody searched for. It is the front half of "didn’t", split by a
 * sanitiser, promoted to a keyword, and then — correctly — refused by the search gate as an
 * unverifiable content term.
 *
 * ── The mechanism ───────────────────────────────────────────────────────────────────────────
 *
 * `sanitizeVisualKeyword` strips quotes with `/["'`]/` and then turns every remaining
 * non-`\w` character into a SPACE. `\w` is `[A-Za-z0-9_]`, so an apostrophe that survived the
 * first pass becomes a space and splits the word.
 *
 * The first pass only knows the STRAIGHT apostrophe. Narration written by an LLM uses the typographic
 * one (U+2019 ’) almost every time, so in production the strip never fired and every contraction
 * split:
 *
 *     didn’t   → "didn t"    → keyword "didn"
 *     wasn’t   → "wasn t"    → keyword "wasn"
 *     Hitler’s → "hitler s"  → the possessive is lost
 *
 * Two of the three sanitisers in that file never stripped quotes at all, straight or curly.
 *
 * ── Why this is not a search-gate change ────────────────────────────────────────────────────
 *
 * The gate was right to block "didn know hitler"; no provider would return anything useful for it.
 * The defect is upstream, and fixing it makes the gate's job smaller without making it weaker.
 * SEARCH_GATE_STRICT is untouched.
 */
import { describe, expect, it } from "vitest";

import { sanitizeVisualKeyword, sanitizePrioritySubject } from "./scriptVisualKeywords";

/** The typographic apostrophe an LLM actually writes, kept as an escape so it cannot be "fixed". */
const CURLY = "’";

describe("PRODUCTION — a contraction never becomes a search keyword", () => {
  /**
   * The exact string from the production log. `didn` must not survive as a token, however the
   * sanitiser chooses to handle the contraction — collapsing it or dropping it are both fine,
   * emitting the fragment is not.
   */
  it(`does not split "didn${CURLY}t" into the keyword "didn"`, () => {
    const out = sanitizeVisualKeyword(`didn${CURLY}t know hitler`);
    expect(out.split(/\s+/), `"didn" reached the providers: ${out}`).not.toContain("didn");
  });

  it("handles the straight apostrophe the same way", () => {
    const out = sanitizeVisualKeyword("didn't know hitler");
    expect(out.split(/\s+/)).not.toContain("didn");
  });

  /** Every contraction the narration of a documentary actually produces. */
  it.each([
    ["wasn", `wasn${CURLY}t there`],
    ["couldn", `couldn${CURLY}t escape`],
    ["wouldn", `wouldn${CURLY}t surrender`],
    ["hadn", `hadn${CURLY}t arrived`],
    ["doesn", `doesn${CURLY}t exist`],
    ["isn", `isn${CURLY}t known`],
  ])('never emits the fragment "%s"', (fragment, phrase) => {
    expect(sanitizeVisualKeyword(phrase).split(/\s+/)).not.toContain(fragment);
  });

  /**
   * A possessive is the other half of the same bug and matters more: "Hitler’s bunker" is a real
   * search, and splitting it costs the entity. The NAME must survive.
   */
  it(`keeps the name in "Hitler${CURLY}s bunker"`, () => {
    const out = sanitizeVisualKeyword(`Hitler${CURLY}s bunker`);
    expect(out).toContain("hitler");
    expect(out).toContain("bunker");
  });

  it(`keeps the name in "Germany${CURLY}s surrender"`, () => {
    expect(sanitizeVisualKeyword(`Germany${CURLY}s surrender`)).toContain("germany");
  });

  /** The same input through the priority-subject path, which sanitises separately. */
  it("the priority-subject sanitiser does not emit the fragment either", () => {
    const out = sanitizePrioritySubject(`didn${CURLY}t know hitler`);
    expect(out.split(/\s+/)).not.toContain("didn");
  });

  /**
   * A guard against over-correcting: ordinary words must still tokenise normally, and the
   * hyphen — which the sanitiser deliberately keeps — must survive.
   */
  it("leaves ordinary keywords alone", () => {
    expect(sanitizeVisualKeyword("berlin 1945 archival footage")).toBe("berlin 1945 archival footage");
    expect(sanitizeVisualKeyword("anti-aircraft gun")).toContain("anti-aircraft");
  });
});
