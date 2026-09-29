/**
 * Video 619 — sentence-opening words are not names.
 *
 *     [QueryAnchor] rejected="here's catch" reason=SUBJECT_NOT_NAMED chosen="Despite Kylie Jenner"
 *     [QueryAnchor] rejected="celebrity luxury NYC walk" reason=UNVERIFIED_TERM chosen="next david"
 *
 * Both anchors were sent to Wikimedia, media.ccc, Europeana, SepiaSearch and more, and refused
 * there. The fragment check knew "Over" and "As" but not "Despite" or "next". Nothing is added to a
 * query: a term that opens with such a word is passed over for the next proven one.
 */
import { describe, expect, it } from "vitest";
import { chooseProvenAnchor, looksLikeSentenceFragment } from "./mediaResearchEngine";
import { emptyQueryContext, provenToken } from "./searchQueryContract";

describe("Video 619 — a sentence opener does not begin a search subject", () => {
  it("the two anchors of render 619, and their siblings, read as fragments", () => {
    for (const t of ["Despite Kylie Jenner", "next david", "However Kris Jenner", "Meanwhile Kim", "Here's catch", "It's true"]) {
      expect(looksLikeSentenceFragment(t), t).toBe(true);
    }
  });

  it("real subjects still pass, including names that begin with a common word", () => {
    for (const t of ["Kylie Jenner", "Robert Shapiro", "David Dobrik", "Adolf Hitler", "Berlin bunker", "Today Show", "Now Magazine", "New York City"]) {
      expect(looksLikeSentenceFragment(t), t).toBe(false);
    }
  });

  it("the fallback passes over 'Despite Kylie Jenner' and takes the proven name after it", () => {
    const beat = "Despite Kylie Jenner's cosmetics empire, here's the catch.";
    const ctx = emptyQueryContext(beat);
    ctx.persons.push(provenToken("Despite Kylie Jenner", "person", "beat_text", beat));
    ctx.persons.push(provenToken("Kylie Jenner", "person", "beat_text", beat));
    const { anchor, rejected } = chooseProvenAnchor(["here's catch"], ctx);
    expect(rejected).toContain("here's catch");
    expect(anchor).toBe("Kylie Jenner");
  });

  it("'next david' is passed over for the whole name the sentence proves", () => {
    const beat = "He was called the next David Dobrik.";
    const ctx = emptyQueryContext(beat);
    ctx.persons.push(provenToken("next David", "person", "beat_text", beat));
    ctx.persons.push(provenToken("David Dobrik", "person", "beat_text", beat));
    expect(chooseProvenAnchor(["celebrity luxury NYC walk"], ctx).anchor).toBe("David Dobrik");
  });

  it("with nothing proven after it, the beat gets no anchor rather than a fragment", () => {
    const beat = "Despite everything, it held.";
    const ctx = emptyQueryContext(beat);
    ctx.persons.push(provenToken("Despite Everything", "person", "beat_text", beat));
    expect(chooseProvenAnchor(["here's catch"], ctx).anchor).toBe("");
  });
});
