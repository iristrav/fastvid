import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ensureSubjectAnchor, subjectAnchorForBeat } from "./visualSearchPlan";
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

describe("the anchor the ladder puts back", () => {
  const profile = { entities: { persons: ["Kim Kardashian"], companies: [] as string[] } };

  it("is chosen by the same helper the plan uses, from the beat's own words", () => {
    const anchor = subjectAnchorForBeat(profile, {
      beatText: "Kim Kardashian turned the rumour into a headline.",
      sceneText: "",
      topic: "The Kardashians",
    });
    expect(anchor).toBe("Kim Kardashian");
    expect(ensureSubjectAnchor("celebrity", anchor)).toBe("Kim Kardashian celebrity");
    expect(ensureSubjectAnchor("news", anchor)).toBe("Kim Kardashian news");
  });

  it("A BEAT THAT DOES NOT SAY THE NAME GETS NO ANCHOR — none is invented", () => {
    /**
     * `subjectAnchorForBeat` gates every candidate through `termProvableFrom`. A profile that
     * guessed a person the sentence never names yields "", and `ensureSubjectAnchor` then returns
     * the query untouched rather than attaching a claim the narration does not support.
     */
    const anchor = subjectAnchorForBeat(profile, {
      beatText: "The cameras never stopped rolling that summer.",
      sceneText: "",
      topic: "The Kardashians",
    });
    expect(anchor).toBe("");
    expect(ensureSubjectAnchor("celebrity", anchor)).toBe("celebrity");
  });

  it("query diversity is arithmetically unchanged", () => {
    /**
     * The anchor is a constant prefix applied AFTER the collapse, so it cannot merge two queries
     * that the collapse left distinct, and cannot split two it had already merged. Whatever the
     * `Set` kept before, it keeps now.
     */
    const collapsed = ["celebrity", "news", "city", "fashion", "celebrity"];
    const before = new Set(collapsed);
    const after = new Set(collapsed.map((q) => ensureSubjectAnchor(q, "Kim Kardashian")));
    expect(after.size).toBe(before.size);
    expect([...after]).toEqual([
      "Kim Kardashian celebrity",
      "Kim Kardashian news",
      "Kim Kardashian city",
      "Kim Kardashian fashion",
    ]);
  });

  it("it adds the subject and never removes a term the query had", () => {
    /** Only the anchor's own words are deduplicated out; everything else survives verbatim. */
    expect(ensureSubjectAnchor("kardashian celebrity", "Kim Kardashian")).toBe("Kim Kardashian celebrity");
    expect(ensureSubjectAnchor("Kim Kardashian news", "Kim Kardashian")).toBe("Kim Kardashian news");
  });
});

describe("the call site — the ladder, not the simplifier", () => {
  /** The whole stock-fallback function, bounded so the assertions below cannot wander. */
  const LADDER = (() => {
    const at = PIPELINE.indexOf("async function adoptStockBeatClipFallbackInner");
    expect(at, "adoptStockBeatClipFallbackInner is gone").toBeGreaterThan(0);
    const end = PIPELINE.indexOf("async function adoptEmergencyGeoStockClip", at);
    expect(end).toBeGreaterThan(at);
    return PIPELINE.slice(at, end);
  })();

  /** Just its query assembly, for the questions that are about the order of the chain. */
  const ASSEMBLY = (() => {
    const at = LADDER.indexOf("const stockSubjectAnchor = semanticProfile");
    expect(at, "the anchor is not derived in this function at all").toBeGreaterThan(0);
    const cap = LADDER.indexOf("].slice(0, queryCap);", at);
    expect(cap).toBeGreaterThan(at);
    return LADDER.slice(at, cap + 24);
  })();

  it("the anchor is derived, not hardcoded, and only when a profile exists", () => {
    expect(ASSEMBLY).toContain("const stockSubjectAnchor = semanticProfile");
    expect(ASSEMBLY).toContain("? subjectAnchorForBeat(semanticProfile, {");
    expect(ASSEMBLY).toContain("beatText: beat.text,");
    expect(ASSEMBLY).toContain(': "";');
  });

  it("IT RUNS AFTER THE COLLAPSE — before it, the simplifier would eat it again", () => {
    const simplifyAt = ASSEMBLY.indexOf("simplifyStockSearchWord(toQueryString(q), beat.text, true)");
    const anchorAt = ASSEMBLY.indexOf("ensureSubjectAnchor(q, stockSubjectAnchor)");
    const emptyAt = ASSEMBLY.indexOf("q.trim().length > 0");
    expect(simplifyAt).toBeGreaterThan(0);
    expect(anchorAt).toBeGreaterThan(simplifyAt);
    expect(emptyAt).toBeGreaterThan(anchorAt);
  });

  it("BOTH PROVIDERS ARE STILL CALLED STRICT, SO THE COLLAPSE CANNOT HAPPEN TWICE", () => {
    /**
     * `fetchPexelsClips` and `fetchPixabayClips` re-run `simplifyStockSearchWord` themselves when
     * `strictQueries` is false. The ladder passes `true` to both, which is what makes this one
     * call site the whole fix. If either ever flips, the anchor is collapsed away again inside
     * the fetcher and this round is silently undone.
     */
    const pex = LADDER.indexOf("fetchPexelsClips(");
    const pix = LADDER.indexOf("fetchPixabayClips(");
    expect(pex).toBeGreaterThan(0);
    expect(pix).toBeGreaterThan(pex);
    expect(LADDER.slice(pex, pex + 400)).toContain("dedup.usedPexelsIds");
    expect(LADDER.slice(pex, pex + 400)).toMatch(/\n\s*true,\n\s*`b\$\{beat\.index\}_pex`/);
    expect(LADDER.slice(pix, pix + 400)).toMatch(/`b\$\{beat\.index\}_pix`,\n\s*true,/);
  });

  it("the simplifier itself is untouched — it still returns the category word", () => {
    /**
     * The guard against fixing this in the wrong place. Collapsing is what a stock library wants;
     * losing the subject is not. The table and the loop that reads it stay exactly as they were.
     */
    const at = PIPELINE.indexOf("function simplifyStockSearchWord(");
    expect(at, "simplifyStockSearchWord is gone").toBeGreaterThan(0);
    /**
     * Bounded to THIS function: a second copy of the same loop lives in another helper, and an
     * unbounded search found that one and reported the collapse intact after it had been removed
     * from the simplifier.
     */
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\nfunction enrichStockQuery(", at));
    expect(body).toContain("for (const [re, word] of STOCK_TOPIC_WORD_RULES) {\n    if (re.test(combined)) return word;\n  }");
    expect(loadTopicRules().length).toBeGreaterThan(90);
  });

  it("no gate, cap or filter was relaxed to make room for it", () => {
    expect(ASSEMBLY).toContain("!isBlockedStockQuery(toQueryString(q))");
    expect(ASSEMBLY).toContain("].slice(0, queryCap);");
    /** The whole condition, not the substring — `if (false && …)` still contains the call. */
    expect(LADDER).toContain("if (dedup.stockQueriesAsked.has(askKey)) {");
  });
});
