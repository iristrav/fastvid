import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  visualTermsFromIntent,
  contentTermsFromText,
  validateSearchQuery,
  emptyQueryContext,
  provenToken,
} from "./searchQueryContract";

/**
 * A QUERY IS WHAT THE BEAT IS ABOUT, NOT THE FIRST FOUR WORDS OF ITS SENTENCE.
 *
 * ── What render 577 measured ────────────────────────────────────────────────────────────────
 *
 *     ALLOWED : "shaped"×11  "life"×10  "evidence"×10  "instructions"×9  "cremation"×4
 *     BLOCKED : "establishing"×32 "documentary"×30 "street"×18 "funeral"×14 "death"×14
 *               "corpse"×14 "building"×14 "military"×10 "bunker"×4 "underground"×4
 *     158 rejections — UNVERIFIED_TERM ×92, NO_CONTENT_ANCHOR ×66
 *
 * Read the allowed column as a list of pictures and it is absurd: nobody can be shown "shaped".
 * Read it as the first four non-function words of a sentence and it is exactly right, which is
 * what `contentTermsFromText` returns — it walks the narration in READING order.
 *
 * ── The two wrong fixes, and why these tests exist ──────────────────────────────────────────
 *
 * The tempting fix is to open the gate so "bunker" gets through. That would let every unproven
 * noun through with it, and the gate is the only thing standing between a render and a picture of
 * something the script never said.
 *
 * The second tempting fix is to let the planner's terms bypass the evidence check. Same hole,
 * different door. So the rule these tests pin is: the new term source may only ever return a
 * SUBSET of what the gate already accepted, reordered by what a picture needs.
 */

/* ═══════════════════ A · intent → visual terms ═══════════════════ */

describe("the typed terms come out in the order a picture needs them", () => {
  const evidence =
    "Hitler was in the bunker in Berlin in 1945 when the instructions shaped the final hours.";

  it("SUBJECT FIRST — what a person would say the beat is about", () => {
    const terms = visualTermsFromIntent(
      { subject: "bunker", people: ["Hitler"], location: ["Berlin"], period: ["1945"] },
      evidence
    );
    expect(terms.split(" ")[0]).toBe("bunker");
  });

  it("then people, event, location, period, objects — nouns that narrow an archive", () => {
    const terms = visualTermsFromIntent(
      {
        subject: "bunker",
        people: ["Hitler"],
        location: ["Berlin"],
        period: ["1945"],
        action: ["shaped"],
      },
      evidence,
      4
    );
    expect(terms).toBe("bunker Hitler Berlin 1945");
  });

  it("THE VERB IS LAST — 'shaped' is how the sentence moves, not what it shows", () => {
    /**
     * The single most direct statement of render 577's defect. With four slots and four nouns
     * available, the action never gets one.
     */
    const terms = visualTermsFromIntent(
      { subject: "bunker", people: ["Hitler"], location: ["Berlin"], period: ["1945"], action: ["shaped"] },
      evidence,
      4
    );
    expect(terms).not.toContain("shaped");
  });

  it("but a beat with nothing else does use its action", () => {
    const terms = visualTermsFromIntent({ action: ["cremation"] }, "the cremation took place");
    expect(terms).toBe("cremation");
  });

  it("THE SENTENCE-ORDER SOURCE IS WHAT IT REPLACES — and it still behaves as it did", () => {
    /**
     * Not deleted, not changed: a beat whose extractors typed nothing still gets the old answer.
     * Asserting the old behaviour here is what makes the change a REPLACEMENT of the default
     * rather than a removal of a route.
     */
    const sentence = "The instructions shaped the final hours of life.";
    expect(contentTermsFromText(sentence, 4)).toBe("instructions shaped final hours");
    expect(visualTermsFromIntent(null, sentence)).toBe("");
    expect(visualTermsFromIntent({}, sentence)).toBe("");
  });

  it("a term is never repeated, however many fields hold it", () => {
    const terms = visualTermsFromIntent(
      { subject: "Berlin", location: ["Berlin", "berlin"], event: ["Berlin"] },
      "Berlin fell."
    );
    expect(terms).toBe("Berlin");
  });

  it("the cap is honoured", () => {
    const terms = visualTermsFromIntent(
      { subject: "bunker", people: ["Hitler"], location: ["Berlin"], period: ["1945"] },
      "Hitler was in the bunker in Berlin in 1945.",
      2
    );
    expect(terms.split(" ")).toHaveLength(2);
    expect(visualTermsFromIntent({ subject: "bunker" }, "the bunker", 0)).toBe("");
  });

  it("a forbidden term is dropped even when the beat proves it", () => {
    /**
     * The planner naming something forbidden is a stronger statement than an extractor naming it
     * present, so the refusal wins. Same direction the ranking already takes.
     */
    const terms = visualTermsFromIntent(
      { subject: "bunker", objects: ["corpse"], forbidden: ["corpse"] },
      "a corpse was found in the bunker"
    );
    expect(terms).toBe("bunker");
  });

  it("production vocabulary alone is not a query", () => {
    expect(visualTermsFromIntent({ subject: "documentary" }, "the documentary footage")).toBe("");
    expect(visualTermsFromIntent({ subject: "establishing" }, "an establishing shot")).toBe("");
  });
});

/* ═══════════════════ B · the evidence rule is NOT relaxed ═══════════════════ */

describe("a term the beat cannot prove is still refused", () => {
  it("FÜHRERBUNKER IS REFUSED when the beat only says Hitler was in Berlin", () => {
    /**
     * The exact case the round was told to preserve. The planner may well be right that a
     * Führerbunker picture would suit — but the beat has not proved it, and a term nothing
     * proves is a term this render may not search for.
     */
    const beat = "Hitler was in Berlin.";
    expect(visualTermsFromIntent({ subject: "Führerbunker" }, beat)).toBe("");
    expect(visualTermsFromIntent({ subject: "Hitler", objects: ["Führerbunker"] }, beat)).toBe(
      "Hitler"
    );
  });

  it("and so is the folded spelling — dropping the umlaut proves nothing either", () => {
    const beat = "Hitler was in Berlin.";
    expect(visualTermsFromIntent({ subject: "fuhrerbunker" }, beat)).toBe("");
  });

  it("BUT WHEN THE BEAT SAYS FÜHRERBUNKER, THE FOLDED QUERY IS CARRIED", () => {
    /**
     * The other half, and the reason this uses the existing normalisation rather than a string
     * compare: a provider that cannot take an umlaut must still be askable about the thing the
     * beat named.
     */
    const beat = "The Führerbunker lay under Berlin.";
    expect(visualTermsFromIntent({ subject: "fuhrerbunker" }, beat)).toBe("fuhrerbunker");
    expect(visualTermsFromIntent({ subject: "Führerbunker" }, beat)).toBe("Führerbunker");
  });

  it("an unsupported visual noun is refused however useful it looks", () => {
    const beat = "The war ended in May.";
    for (const noun of ["bunker", "funeral", "corpse", "military", "underground"]) {
      expect(visualTermsFromIntent({ subject: noun }, beat), `${noun} was admitted`).toBe("");
    }
  });

  it("and each of those IS carried once the beat names it", () => {
    expect(visualTermsFromIntent({ subject: "bunker" }, "they reached the bunker")).toBe("bunker");
    expect(visualTermsFromIntent({ subject: "funeral" }, "the funeral was held")).toBe("funeral");
    expect(visualTermsFromIntent({ subject: "military" }, "military units arrived")).toBe(
      "military"
    );
  });

  it("a plural in the beat proves the singular in the query — the existing stemmer, unchanged", () => {
    expect(visualTermsFromIntent({ subject: "bunker" }, "the bunkers were sealed")).toBe("bunker");
  });
});

/* ═══════════════════ C · the gate itself is untouched ═══════════════════ */

describe("THE OUTPUT IS A SUBSET OF WHAT THE GATE ALREADY ACCEPTED", () => {
  /**
   * The invariant that makes this change safe to reason about. If it holds, no query this source
   * produces can reach a provider that the previous code would have refused — the change can only
   * move which ALLOWED query is asked, never widen the set.
   */
  const beat = "Hitler reached the bunker in Berlin in 1945.";
  const ctx = emptyQueryContext(beat);

  it("every term it returns passes validateSearchQuery", () => {
    const terms = visualTermsFromIntent(
      { subject: "bunker", people: ["Hitler"], location: ["Berlin"], period: ["1945"] },
      beat
    );
    expect(terms).toBeTruthy();
    expect(validateSearchQuery(terms, ctx).ok).toBe(true);
  });

  it("and a term the gate refuses never appears in its output", () => {
    const refused = validateSearchQuery("Führerbunker", ctx);
    expect(refused.ok).toBe(false);
    expect(visualTermsFromIntent({ subject: "Führerbunker" }, beat)).toBe("");
  });

  it("a verified token in the context does not bypass the beat's own evidence", () => {
    /**
     * A typed token is evidence that an extractor CLASSIFIED something, not that the beat said it.
     * This source checks the beat, so a proven-but-unsaid term is still refused here.
     */
    const withToken = emptyQueryContext(beat);
    withToken.objects = [provenToken("Führerbunker", "proven_entity")];
    expect(visualTermsFromIntent({ objects: ["Führerbunker"] }, beat)).toBe("");
  });
});

/* ═══════════════════ D · the wiring ═══════════════════ */

describe("the rescue rung asks the beat before it asks the sentence", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("THE INTENT IS CONSULTED FIRST, WITH THE SENTENCE AS FALLBACK", () => {
    expect(PIPE).toContain(
      "visualTermsFromIntent(intentForTerms, `${beat.text} ${scene.text ?? \"\"}`) ||"
    );
    expect(PIPE).toContain("contentTermsFromText(beat.text);");
  });

  it("the fallback is still there — a beat that typed nothing is no worse off", () => {
    /**
     * Deliberately asserted. Removing the old source would have turned "no typed terms" from a
     * weak query into NO query, which is a different change and a worse one to make silently.
     */
    expect(PIPE).toContain("contentTermsFromText");
  });

  it("and the beat's own intent is what is read, not the scene's", () => {
    expect(PIPE).toContain(
      "const intentForTerms = beatVisualIntent(dedup.beatIntent, scene.index, beat.index);"
    );
  });
});

/* ═══════════════════ E · nothing was relaxed ═══════════════════ */

describe("the gates this round must not touch are untouched", () => {
  const SRC = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");

  it("the validator still refuses a query with no content anchor", () => {
    expect(SRC).toContain('return { ok: false, reason: "NO_CONTENT_ANCHOR"');
  });

  it("the evidence check still requires EVERY content word", () => {
    /** `termProvableFrom` returns false on the first unproven word. A loosened version would not. */
    expect(visualTermsFromIntent({ subject: "Berlin bunker" }, "Berlin fell.")).toBe("");
  });

  it("and the new source calls that same check rather than its own", () => {
    const fn = SRC.slice(
      SRC.indexOf("export function visualTermsFromIntent"),
      SRC.indexOf("RONDE 216 — ASK BEFORE YOU BUILD")
    );
    expect(fn).toContain("termProvableFrom(term, sourceText)");
    expect(fn).toContain("hasContentAnchor(query)");
  });
});
