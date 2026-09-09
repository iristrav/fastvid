/**
 * RONDE 213 — THE PICTURE EDITOR CAN ONLY CHOOSE FROM WHAT THE SEARCH BROUGHT BACK.
 *
 * ── The finding ─────────────────────────────────────────────────────────────────────────────
 *
 * R199–R204 spent four rounds making sure every picture is looked at, that a refused one cannot
 * ship, and that the render reports its choice honestly. None of that can help a beat whose
 * CANDIDATE POOL never contained a fitting picture — and the pool is built by the query.
 *
 * `visualSearchPlan` built its highest-confidence query as `beatText.slice(0, 80)`. Measured on
 * three ordinary narration sentences from three unrelated subjects:
 *
 *     "In the winter of 1953 the North Sea broke through the dikes and drowned more tha"
 *     "The factory floor fell silent for the first time in forty years, and the town un"
 *     "Researchers had been measuring the glacier since 1912, but nobody expected the r"
 *
 * Three out of three: a whole English sentence, cut mid-word, sent to Pexels, Archive.org and
 * Wikimedia as the FIRST thing asked. Five sites did this; the worst two are the plan's primary
 * round (confidence 0.85) and the plan-disabled branch, where it was the beat's only query at
 * confidence 1.
 *
 * ── The gate was never the problem ──────────────────────────────────────────────────────────
 *
 * `validateSearchQuery` answered `ok: true` for all three, correctly. Without a proven context it
 * can only ask whether a query contains a pronoun and whether it names any subject at all, and a
 * sentence names plenty. Nothing about the gate is changed by this round — loosening it was never
 * the available move, and tightening it would refuse honest queries too.
 *
 * ── What the fix may not do ─────────────────────────────────────────────────────────────────
 *
 * It only REMOVES, and only function words: a closed grammatical class that names nothing. The
 * surviving words keep the sentence's own order, so every query is a SUBSEQUENCE of the narration.
 * No term appears that the script did not say, and no term is reordered into a claim the script did
 * not make — which is what keeps this a reduction rather than a second query generator.
 *
 * PRODUCTION_VOCABULARY is deliberately not used to strip. That set says which words need no
 * evidence, not which words carry no meaning; stripping by it would delete "black" from a black
 * market and "period" from a period of famine.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  contentTermsFromText,
  hasContentAnchor,
  validateSearchQuery,
} from "./searchQueryContract";

const PLAN = fs.readFileSync(path.join(__dirname, "visualSearchPlan.ts"), "utf8");
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** The three sentences the finding was measured on, plus one that fails the gate on a pronoun. */
const REAL_NARRATION = [
  "In the winter of 1953 the North Sea broke through the dikes and drowned more than eighteen hundred people in a single night.",
  "The factory floor fell silent for the first time in forty years, and the town understood immediately what that silence meant.",
  "Researchers had been measuring the glacier since 1912, but nobody expected the retreat to accelerate this quickly.",
  "Her instructions were clear: the evidence had to be destroyed before dawn.",
];

/* ═══════════ 1. what the narration becomes ═══════════ */

describe("R213 §1 — a sentence is reduced to the terms it actually names", () => {
  it("THE THREE MEASURED SENTENCES, as they now reach a provider", () => {
    expect(contentTermsFromText(REAL_NARRATION[0]!, 4)).toBe("winter 1953 North Sea");
    expect(contentTermsFromText(REAL_NARRATION[1]!, 4)).toBe("factory floor fell silent");
    expect(contentTermsFromText(REAL_NARRATION[2]!, 4)).toBe("Researchers measuring glacier 1912");
  });

  it("A WORD IS NEVER CUT IN HALF — the defect is structurally impossible now", () => {
    for (const beat of REAL_NARRATION) {
      const q = contentTermsFromText(beat, 4);
      for (const term of q.split(" ").filter(Boolean)) {
        expect(
          beat.split(/[^\p{L}\p{N}'’-]+/u),
          `"${term}" is not a whole word of the narration`
        ).toContain(term);
      }
    }
  });

  it("EVERY QUERY IS A SUBSEQUENCE — nothing invented, nothing reordered", () => {
    for (const beat of REAL_NARRATION) {
      const source = beat.split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean);
      const terms = contentTermsFromText(beat, 4).split(" ").filter(Boolean);
      let at = -1;
      for (const t of terms) {
        const next = source.indexOf(t, at + 1);
        expect(next, `"${t}" appears out of the sentence's own order`).toBeGreaterThan(at);
        at = next;
      }
    }
  });

  it("the pronoun that used to refuse a whole beat's query is simply gone", () => {
    // "Her instructions …" was rejected FORBIDDEN_PRONOUN as a raw sentence.
    const raw: any = validateSearchQuery(REAL_NARRATION[3]!.slice(0, 80));
    expect(raw.ok).toBe(false);
    expect(raw.reason).toBe("FORBIDDEN_PRONOUN");
    const reduced = contentTermsFromText(REAL_NARRATION[3]!, 4);
    expect(reduced).toBe("instructions clear evidence destroyed");
    expect((validateSearchQuery(reduced) as any).ok).toBe(true);
  });

  it("every reduced query passes the gate the raw sentence was gambling on", () => {
    for (const beat of REAL_NARRATION) {
      const q = contentTermsFromText(beat, 4);
      expect(q).not.toBe("");
      expect((validateSearchQuery(q) as any).ok, `refused: "${q}"`).toBe(true);
    }
  });
});

/* ═══════════ 2. the term cap ═══════════ */

describe("R213 §2 — the cap", () => {
  it("takes the sentence's first content words, in order", () => {
    const s = "The eruption buried the harbour under ash for eleven years.";
    expect(contentTermsFromText(s, 2)).toBe("eruption buried");
    expect(contentTermsFromText(s, 3)).toBe("eruption buried harbour");
  });

  it("a short sentence yields what it has, not padding", () => {
    expect(contentTermsFromText("Chernobyl burned.", 4)).toBe("Chernobyl burned");
  });

  it("a single-word beat is a single-word query", () => {
    expect(contentTermsFromText("Chernobyl.", 4)).toBe("Chernobyl");
  });

  it("a cap of zero or less asks for nothing and gets nothing", () => {
    expect(contentTermsFromText(REAL_NARRATION[0]!, 0)).toBe("");
    expect(contentTermsFromText(REAL_NARRATION[0]!, -1)).toBe("");
  });
});

/* ═══════════ 3. when it must refuse to build a query ═══════════ */

describe("R213 §3 — nothing to search for is answered with nothing", () => {
  it("A SENTENCE THAT ONLY DESCRIBES THE FILM PRODUCES NO QUERY", () => {
    /**
     * "archival", "footage" and "restored" are all production vocabulary: they describe the film,
     * not its subject. `hasContentAnchor` — the gate's own helper — says so, and the builder must
     * agree with the gate rather than send a query it knows will be refused.
     */
    const q = contentTermsFromText("The archival footage was restored.", 4);
    expect(q).toBe("");
    expect(hasContentAnchor("archival footage restored")).toBe(false);
  });

  it("empty, blank and nonsense input are all the same answer", () => {
    expect(contentTermsFromText("", 4)).toBe("");
    expect(contentTermsFromText("   ", 4)).toBe("");
    expect(contentTermsFromText("... --- ...", 4)).toBe("");
  });

  it("A HOLE IN THE GATE, FOUND WHILE BUILDING THIS: punctuation was a subject", () => {
    /**
     * The split deliberately keeps the apostrophe and hyphen inside a token so "Churchill's" and
     * "Marie-Curie" stay one word. The cost, unnoticed until the reduction started producing such
     * tokens: `"---"` survived as a word, `foldSearchText` returned it unchanged, and
     * `hasContentAnchor` answered TRUE — so `validateSearchQuery("---")` answered `ok`. The gate's
     * subject check said a row of hyphens asks for something.
     *
     * Fixed at the one definition, so the builder and the gate inherit it together. This NARROWS
     * what passes, which is the permitted direction.
     */
    for (const junk of ["---", "'''", "-", "'-'", "--- ..."]) {
      expect(hasContentAnchor(junk), `"${junk}" still counts as a subject`).toBe(false);
      expect((validateSearchQuery(junk) as any).reason).toBe("NO_CONTENT_ANCHOR");
    }
  });

  it("and a real hyphenated or possessive name still passes", () => {
    expect(hasContentAnchor("Marie-Curie")).toBe(true);
    expect(hasContentAnchor("Churchill's bunker")).toBe(true);
    expect(contentTermsFromText("Marie-Curie entered the laboratory.", 4)).toBe(
      "Marie-Curie entered laboratory"
    );
  });

  it("a sentence of pure grammar yields nothing", () => {
    expect(contentTermsFromText("It was to be, and it had been.", 4)).toBe("");
  });

  it("KNOWN AND ACCEPTED: a nearly contentless sentence yields a weak single term", () => {
    /**
     * "of course" is an idiom whose only non-function word is "course". Special-casing it would be
     * a hardcoded stopword for one English phrase — the topic-specific patch this brief forbids —
     * and the term IS what the sentence says. A weak query is judged by the picture editor like
     * any other; a wrong one invented to look strong would not be.
     */
    expect(contentTermsFromText("It was, of course, all of them.", 4)).toBe("course");
  });
});

/* ═══════════ 4. the five sites ═══════════ */

describe("R213 §4 — no builder sends a raw sentence any more", () => {
  it("THE PRIMARY ROUND no longer carries verbatim beat text", () => {
    expect(PLAN, "the sentence is still the 0.85 query").not.toContain(
      'scored(input.beatText.slice(0, 80), 0.85, "verbatim beat text")'
    );
    expect(PLAN, "the sentence is still the only query when the plan is off").not.toContain(
      'scored(input.beatText.slice(0, 80), 1, "verbatim beat text")'
    );
  });

  it("the adjacent-beat fragments are reduced too", () => {
    expect(PLAN).not.toContain("prevBeat.slice(0, 60)");
    expect(PLAN).not.toContain("nextBeat.slice(0, 60)");
  });

  it("the Wikimedia rescue's last resort is reduced too", () => {
    expect(PIPE, "the rescue still appends the raw sentence").not.toContain(
      "wikiQueries.push(beat.text.slice(0, 80))"
    );
    const at = PIPE.indexOf("const wikiQueries: string[] = [];");
    expect(at).toBeGreaterThan(0);
    expect(PIPE.slice(at, at + 600)).toContain("contentTermsFromText(beat.text)");
  });

  it("AN EMPTY REDUCTION ADDS NO QUERY — no site falls back to the raw text", () => {
    for (const m of PLAN.matchAll(/contentTermsFromText\(/g)) {
      const around = PLAN.slice(m.index!, m.index! + 400);
      expect(around, "a reduction result is used without checking it is non-empty").toMatch(
        /\?|if \(/
      );
    }
    const at = PIPE.indexOf("const beatTerms = contentTermsFromText(beat.text);");
    expect(PIPE.slice(at, at + 120)).toContain("if (beatTerms) wikiQueries.push(beatTerms)");
  });

  it("the cap is one named constant, not a number repeated at each site", () => {
    expect(PLAN).toContain("const BEAT_QUERY_TERMS = 4;");
    expect(PLAN).toContain("const ADJACENT_QUERY_TERMS = 3;");
  });
});

/* ═══════════ 5. what this round is not allowed to have done ═══════════ */

describe("R213 §5 — the gate is untouched", () => {
  it("STRICT MODE IS STILL THE DEFAULT", () => {
    const src = fs.readFileSync(path.join(__dirname, "searchQueryContract.ts"), "utf8");
    expect(src).toContain('return process.env.SEARCH_GATE_STRICT !== "false";');
  });

  it("the validator still refuses a query with no subject", () => {
    expect((validateSearchQuery("documentary establishing aerial") as any).reason).toBe(
      "NO_CONTENT_ANCHOR"
    );
  });

  it("the validator still refuses a capitalised pronoun", () => {
    expect((validateSearchQuery("She walked into the hall") as any).reason).toBe(
      "FORBIDDEN_PRONOUN"
    );
  });

  it("the reduction strips grammar only — a content word is never removed as production vocabulary", () => {
    /**
     * The guard against the tempting-but-wrong version of this fix: PRODUCTION_VOCABULARY contains
     * "black", "white", "period", "real" and "old", which are ordinary content words in a sentence.
     * Stripping by that set would have quietly deleted the subject.
     */
    expect(contentTermsFromText("The black market survived the period of famine.", 4)).toBe(
      "black market survived period"
    );
  });
});
