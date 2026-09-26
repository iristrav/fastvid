/**
 * RONDE 660 — VIDEO 608: A GOOD QUESTION LOST FOR ONE WORD.
 *
 *     [QueryAnchor] rejected="Hitler pacing Führerbunker reenactment" reason=UNVERIFIED_TERM
 *                   chosen="multiple addictions"
 *
 * "reenactment" is not in the script, so the validator was right to refuse the candidate. What was
 * wrong is what happened next: the whole candidate was thrown away and an abstract phrase from the
 * fallback list became the anchor. The fix narrows the candidate to the words the SAME validator
 * accepts; the gate itself is untouched.
 */
import { describe, expect, it } from "vitest";

import { chooseProvenAnchor, narrowToProvenTerms } from "./mediaResearchEngine";
import { emptyQueryContext, provenToken, validateSearchQuery, type VerifiedQueryContext } from "./searchQueryContract";

const BEAT = "Adolf Hitler kept pacing the Führerbunker, driven by multiple addictions.";

function render608Context(): VerifiedQueryContext {
  const ctx = emptyQueryContext(BEAT);
  ctx.persons.push(provenToken("Adolf Hitler", "person", "beat_text", BEAT));
  ctx.places.push(provenToken("Führerbunker", "place", "beat_text", BEAT));
  ctx.events.push(provenToken("multiple addictions", "event", "beat_text", BEAT));
  return ctx;
}

describe("RONDE 660 — the candidate is narrowed, not thrown away", () => {
  it("the original candidate is still refused (the gate did not move)", () => {
    expect(validateSearchQuery("Hitler pacing Führerbunker reenactment", render608Context()).ok).toBe(false);
  });

  it("without the unproven word it is a question the gate accepts", () => {
    const narrowed = narrowToProvenTerms("Hitler pacing Führerbunker reenactment", render608Context());
    expect(narrowed).toBe("Hitler pacing Führerbunker");
    expect(validateSearchQuery(narrowed!, render608Context()).ok).toBe(true);
  });

  it("and it becomes the anchor instead of the abstract fallback phrase", () => {
    const { anchor, rejected } = chooseProvenAnchor(["Hitler pacing Führerbunker reenactment"], render608Context());
    expect(rejected).toContain("Hitler pacing Führerbunker reenactment");
    expect(anchor).toBe("Hitler pacing Führerbunker");
    expect(anchor).not.toBe("multiple addictions");
  });

  it("a candidate that is nothing but unproven words is not narrowed into a fragment", () => {
    expect(narrowToProvenTerms("cinematic reenactment", render608Context())).toBeNull();
  });

  it("a narrowed candidate that drops the beat's proven person does not outrank that person", () => {
    const ctx = render608Context();
    const { anchor } = chooseProvenAnchor(["Führerbunker corridor reenactment"], ctx);
    expect(anchor).toBe("Adolf Hitler");
  });

  it("without a context nothing is narrowed", () => {
    expect(narrowToProvenTerms("Hitler pacing Führerbunker reenactment", undefined)).toBeNull();
  });
});
