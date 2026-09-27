import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {   } from "./visualSearchPlan";
import { hasContentAnchor, validateSearchQuery } from "./searchQueryContract";

/**
 * A CATEGORY WORD IS NOT THE PERSON IT REPLACED.
 *
 * RONDE 14b7cc2 stopped `visualSearchPlan` from sending a tier term to a provider on its own, so
 * `news` and `documentary archive` stopped being searches. The stock ladder
 * (`adoptStockBeatClipFallbackInner`) never read that plan — it assembles its own queries — and
 * every one of them passes through `simplifyStockSearchWord`, whose first act is to walk
 * `STOCK_TOPIC_WORD_RULES` and RETURN A CATEGORY WORD. One of those rules is
 *
 *     [/\bcelebrity\b|\bpaparazzi\b|\bfamous\b|\bstar\b|\binfluencer\b|\bkardashian\b/, "celebrity"]
 *
 * which erases a named person by construction. Render 593 is the production half of the same
 * measurement: `query="news" status=DOWNLOADED searchRoute=fetchPexelsClips` on a beat whose only
 * proven terms were `["Kim Kardashian"]`, answered with footage of somebody else.
 *
 * The simplifier is NOT changed here. It still collapses, and the category word is still what
 * varies from query to query. The anchor is put back afterwards, by the same exported helper the
 * plan uses, on a term the beat's own sentence proves.
 */

const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * The REAL rule table, lifted verbatim out of the source and evaluated — so this test cannot
 * drift from the table, and cannot quietly re-implement it either.
 */
function loadTopicRules(): [RegExp, string][] {
  const start = PIPELINE.indexOf("const STOCK_TOPIC_WORD_RULES: [RegExp, string][] = [");
  expect(start, "STOCK_TOPIC_WORD_RULES is gone — this test is about that table").toBeGreaterThan(0);
  const open = PIPELINE.indexOf("[", start + "const STOCK_TOPIC_WORD_RULES: [RegExp, string][] =".length);
  const end = PIPELINE.indexOf("\n];", start);
  // eslint-disable-next-line no-eval
  return eval(PIPELINE.slice(open, end + 2)) as [RegExp, string][];
}

/** The first loop of `simplifyStockSearchWord`, over the table it actually reads. */
function collapse(query: string): string | null {
  for (const [re, word] of loadTopicRules()) {
    if (re.test(query.toLowerCase())) return word;
  }
  return null;
}

describe("the defect, measured on the table the pipeline reads", () => {
  it("a named person collapses to a category", () => {
    expect(collapse("Kim Kardashian")).toBe("celebrity");
    expect(collapse("Kim Kardashian news conference")).toBe("celebrity");
    expect(collapse("Kim Kardashian 2018 interview")).toBe("celebrity");
  });

  it("AND IT IS NOT ONE UNLUCKY NAME", () => {
    /** Topic-agnostic: the same erasure lands on unrelated subjects from unrelated domains. */
    expect(collapse("Marie Curie laboratory Paris")).toBe("science");
    expect(collapse("Elon Musk factory floor")).toBe("tesla");
    expect(collapse("Greta Thunberg climate speech")).toBe("climate");
  });

  it("the collapsed word passes the Search Gate on its own, so nothing downstream stops it", () => {
    /**
     * This is why the gate cannot be the place to fix it, and why no gate is touched here.
     * "celebrity" names a subject — `hasContentAnchor` is right to say so. It is simply not
     * THIS beat's subject, and a context-less caller has nothing to compare it against.
     */
    expect(hasContentAnchor("celebrity")).toBe(true);
    expect(validateSearchQuery("celebrity").ok).toBe(true);
    expect(validateSearchQuery("news").ok).toBe(true);
  });
});
