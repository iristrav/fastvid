/**
 * RONDE 220 — THE LAYER THAT DECIDES WHO GETS SEEN AT ALL.
 *
 * The script states, per sentence, what should be on screen. That reached the QUERY long ago, and
 * RONDE 218/219 gave it to the two relevance lists — the ones that judge a candidate once it is in
 * hand. Between them sits the ranking, and the ranking is the reason a candidate is in hand: the
 * per-beat look budget is small, so a candidate ranked twelfth is usually never judged at all.
 *
 * `AssetDirectorContext` carried usedPaths, categories, blueprint, budget, scene clips, editorial
 * memory, activeEntity, activeLocation, activeEra and a motion range. It did not carry what the
 * script asked the viewer to see, and a grep of assetDirector.ts found no other route by which it
 * arrived.
 *
 * ── The trap this round had to avoid ────────────────────────────────────────────────────────
 *
 * The obvious change was to append the intent's words to the word list that
 * `scoreAnnotationFingerprint` matches on. Measured against the formula, that is a trap:
 *
 *     const fallback = Math.round(25 + (hits / words.length) * ceiling);
 *
 * Every added word grows the DENOMINATOR. A candidate that matched the sentence perfectly but does
 * not happen to contain the intent's phrasing would score LOWER than before — the round would have
 * made the ranking worse while appearing to enrich it.
 *
 * It is also wrong on the evidence. Provider text is a short title about a whole asset; that it
 * omits the script's wording is not an argument against the clip.
 *
 * So it is additive and capped. THE INVARIANT THIS FILE EXISTS FOR: no candidate can score lower
 * than it did before this round.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const AD = fs.readFileSync(path.join(__dirname, "assetDirector.ts"), "utf8");
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════ 1. the intent reaches the ranking ═══════════ */

describe("R220 §1 — the ranking is told what the script asked for", () => {
  it("the context carries it", () => {
    expect(AD).toContain("intentText?: string | null;");
  });

  it("and the 40% fingerprint scorer receives it", () => {
    const call = AD.slice(AD.indexOf("const fp = scoreAnnotationFingerprint("), AD.indexOf("const fp = scoreAnnotationFingerprint(") + 300);
    expect(call).toContain("ctx.intentText");
  });

  it("THE PIPELINE FILLS IT, with the same resolver as RONDE 218 and 219", () => {
    const ctx = PIPE.slice(PIPE.indexOf("const adCtx: AssetDirectorContext = {"), PIPE.indexOf("const adResult = rankCandidatesWithContext("));
    expect(ctx).toContain("intentText:");
    expect(ctx).toContain("resolveBeatVisualIntent(beatText)");
    expect(ctx).toContain("intentSearchQueries(it)");
  });

  it("an absent intent is null, not an empty string pretending to be a statement", () => {
    const ctx = PIPE.slice(PIPE.indexOf("intentText: (() => {"), PIPE.indexOf("intentText: (() => {") + 500);
    expect(ctx).toContain("|| null;");
  });
});

/* ═══════════ 2. the invariant ═══════════ */

describe("R220 §2 — no candidate can score lower than before this round", () => {
  it("THE EXISTING FORMULA IS UNTOUCHED — the denominator did not grow", () => {
    expect(
      AD,
      "the intent words were folded into the match, which penalises every candidate that lacks them"
    ).toContain("const fallback = Math.round(25 + (words.length > 0 ? (hits / words.length) * ceiling : 0));");
  });

  it("the bonus is added, never subtracted, and is bounded", () => {
    expect(AD).toContain("const INTENT_MATCH_BONUS_MAX = 15;");
    const fn = AD.slice(AD.indexOf("function intentMatchBonus("), AD.indexOf("function scoreAnnotationFingerprint("));
    expect(fn).toContain("Math.round((hits / unique.length) * INTENT_MATCH_BONUS_MAX)");
    /**
     * The property, stated on the returns rather than on the characters: the function has exactly
     * two exits, `0` and a non-negative ratio times the cap. `hits` is a filtered length and
     * `unique.length` is guarded above, so neither can make the product negative.
     */
    const returns = [...fn.matchAll(/return ([^;]+);/g)].map((m) => m[1]!.trim());
    expect(returns).toEqual(["0", "Math.round((hits / unique.length) * INTENT_MATCH_BONUS_MAX)"]);
  });

  it("NO INTENT MEANS NO CHANGE — absence is not evidence against a candidate", () => {
    const fn = AD.slice(AD.indexOf("function intentMatchBonus("), AD.indexOf("function scoreAnnotationFingerprint("));
    expect(fn).toContain("if (words.length === 0 || !hay) return 0;");
  });

  it("the cap sits below the weakest evidence ceiling, so it reorders within a tier only", () => {
    /**
     * 15 is below the 25-point floor of the formula and below every ceiling (35 filename, 55
     * provider text, 70 a model that looked at the frames). A filename match plus the full bonus
     * cannot overtake a candidate a model actually described.
     */
    expect(AD).toContain("const ceiling = seenHay ? 70 : providerHay ? 55 : 35;");
    const max = Number(AD.match(/const INTENT_MATCH_BONUS_MAX = (\d+);/)?.[1]);
    expect(max).toBeLessThan(35);
  });

  it("both branches are capped at 100 so the bonus cannot inflate past the scale", () => {
    expect(AD).toContain("Math.min(100, fallback + bonus)");
    expect(AD).toContain("Math.min(100, score + intentMatchBonus(intentText, annHay))");
  });
});

/* ═══════════ 3. both branches, and no second ranker ═══════════ */

describe("R220 §3 — one ranker, fed better", () => {
  it("the external-provider branch matches against what is really known about the clip", () => {
    expect(AD).toContain("intentMatchBonus(intentText, `${base} ${providerHay} ${seenHay}`)");
  });

  it("the curated branch matches against the annotation's own text", () => {
    expect(AD).toContain("const annHay = [");
    expect(AD).toContain("ann.historicalContext.event");
    expect(AD).toContain('meta?.observedDepicts ?? ""');
  });

  it("NO SECOND RANKING ENGINE — the existing scorer is fed, not replaced", () => {
    const rankers = [...AD.matchAll(/export function rankCandidatesWithContext\(/g)].length;
    expect(rankers, "a second ranker appeared").toBe(1);
    expect(AD).toContain("function scoreCandidate(");
    expect((AD.match(/function scoreCandidate\(/g) ?? []).length).toBe(1);
  });

  it("short words are ignored, as everywhere else in this scorer", () => {
    const fn = AD.slice(AD.indexOf("function intentMatchBonus("), AD.indexOf("function scoreAnnotationFingerprint("));
    expect(fn).toContain("w.length > 3");
  });
});
