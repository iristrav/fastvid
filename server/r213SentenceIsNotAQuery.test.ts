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

/* ═══════════ 3. when it must refuse to build a query ═══════════ */

describe("R213 §3 — nothing to search for is answered with nothing", () => {

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
});
