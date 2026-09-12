import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { hasContentAnchor, validateSearchQuery, isAbstractionWord } from "./searchQueryContract";
import { createBeatImageGateState } from "./beatImageRelevanceGate";

/**
 * WHY NOT ONE YOUTUBE CLIP REACHED THE FILM — THE THREE PLACES IT DIED.
 *
 * Render 578 found 2479 YouTube candidates and delivered none. Its own numbers:
 *
 *     [VisionCensus]  youtube_screening judged=24 unavailable=0 skipped=21
 *     [VisualFunnel]  youtube_cc retrieved=2479 downloadSucceeded=88 eligible=1 composed=0
 *     [VisionSelection] TOTAL beats=17 reviewPool=19 reviewed=10 FIT=0
 *     [SourceLineage] scene=1 beat=0 route=backfill archiveAsset=57439
 *
 * Three separate faults, one symptom.
 *
 *   1. BACKFILL ASKED NOBODY. All thirteen delivered clips entered through `route=backfill`, and
 *      `FIT=0` says not one picture in the film was approved for the sentence it plays under.
 *      The compose backfill's `pushClip` computed the clip's beat FOURTEEN LINES BELOW the call
 *      that needed it, so `beatClipRefusedByRelevanceGate` was handed `undefined` and took its
 *      beat-blind branch: it checked for an existing refusal and never obtained a verdict.
 *
 *   2. THE YOUTUBE SLICE RAN OUT AND SAID NOTHING. `maxYoutubeBeatImageJudgements()` is 24; the
 *      render spent exactly 24, first-come, and refused 22 of them. The remaining ~64 downloads
 *      met `return true` and entered the pool on a silent yes the caller reads as "passed".
 *
 *   3. "standing brink" WAS A SEARCH QUERY. Openverse was asked for it — two words lifted from
 *      "Standing on the brink of utter defeat" — and returned a Flickr photograph of a BRINK'S
 *      armoured security truck. Neither word names anything a camera can point at.
 */

describe("1. backfill may not fill a beat nobody was asked about", () => {
  const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const flat = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ");

  it("THE BEAT IS PICKED BEFORE THE EDITOR IS ASKED, NOT AFTER", () => {
    /**
     * Both lines already existed; only their order was wrong. The assertion is on the order,
     * because that is the entire defect and a re-ordering is exactly what could silently return.
     */
    const pick = flat.indexOf("const bi = beatIndex ?? pickVoiceBackfillBeatIndex(");
    const ask = flat.indexOf("if (await beatClipRefusedByRelevanceGate(dedup, clipPath, scene.index, bi))");
    expect(pick, "the backfill still picks a beat").toBeGreaterThan(-1);
    expect(ask, "and still asks about it").toBeGreaterThan(-1);
    expect(pick, "and picks it FIRST").toBeLessThan(ask);
  });

  it("the adoption guard is asked about the same beat", () => {
    expect(flat).toContain("if (await adoptionGuardRefusesPush(dedup, clipPath, scene.index, bi))");
  });

  it("THE RAW ARGUMENT IS NOT WHAT GETS ASKED ABOUT, in this closure", () => {
    /**
     * Scoped to the compose backfill's own closure. The four `pushSceneClip` closures name their
     * OWN parameter `beatIndex` and are required to pass it — they are the routes that always
     * had a beat. This is about the one closure whose beat arrived optional.
     */
    const start = flat.indexOf("const pushClip = async (clipPath: string, holdSec: number, beatIndex?: number)");
    expect(start, "the backfill closure is still there").toBeGreaterThan(-1);
    const body = flat.slice(start, flat.indexOf("await backfillArchiveMontageFromPool(", start));
    expect(body.length).toBeGreaterThan(100);
    expect(body).not.toContain("beatClipRefusedByRelevanceGate(dedup, clipPath, scene.index, beatIndex)");
    expect(body).not.toContain("adoptionGuardRefusesPush(dedup, clipPath, scene.index, beatIndex)");
  });

  it("the beat-blind branch still exists for callers that genuinely have no beat", () => {
    /**
     * `beatClipRefusedByRelevanceGate` is also called by the compose barrier, which legitimately
     * has no beat. Removing that branch would be a different change and a worse one — the point
     * is that a caller which HAS a beat must not reach it.
     */
    expect(SRC).toContain("if (beatIndex != null) {");
  });
});

/**
 * 2. A SPENT JUDGEMENT BUDGET IS NOT AN APPROVAL — superseded by removing the budget.
 *
 * This section made the silent `return true` visible: when YouTube's 24-judgement slice ran out,
 * every further download entered the pool on an answer the caller reads as "passed the image
 * gate", and the render counted 24 of 88 and said nothing about the other 64.
 *
 * Counting them was the right first move and it is what showed the size of the problem. The
 * second move made the counter unnecessary: the pre-pool screening is gone, so there is no budget
 * to spend here and no unscreened admission to record. YouTube is judged once, by the beat gate,
 * on the sentence it will run under. See youtubeIsJudgedWhereItIsUsed.test.ts.
 */


describe("3. a query has to name something you could photograph", () => {
  it("RENDER 578: \"standing brink\" IS NO LONGER A SEARCH QUERY", () => {
    expect(hasContentAnchor("standing brink")).toBe(false);
    const v = validateSearchQuery("standing brink");
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("NO_CONTENT_ANCHOR");
  });

  it("nor are the other meanings-without-subjects the render sent", () => {
    for (const q of ["death", "opening", "defeat", "betrayal", "the final moment"]) {
      expect(hasContentAnchor(q), q).toBe(false);
    }
  });

  it("BUT EVERY DEPICTABLE THING STILL SEARCHES", () => {
    /**
     * The half that matters. Blocking a word because it sounds abstract, rather than because no
     * provider could answer it, would empty films — which is the failure this codebase has
     * already paid for once.
     */
    for (const q of [
      "cyanide", "bunker", "street", "building", "military", "nazi", "poison", "1940s",
      "Adolf Hitler", "Erwin Rommel", "rubble", "surrender", "funeral", "crowd", "war",
    ]) {
      expect(hasContentAnchor(q), q).toBe(true);
    }
  });

  it("an abstraction ATTACHED to a subject still searches — it qualifies, it does not block", () => {
    expect(hasContentAnchor("brink of war")).toBe(true);
    expect(hasContentAnchor("crumbling empire")).toBe(true);
    expect(hasContentAnchor("final days of berlin")).toBe(true);
  });

  it("the production and abstraction sets answer different questions", () => {
    // "documentary" describes the film; "brink" describes the meaning. Both fail to point a
    // camera, and keeping them apart is what lets each list be argued with on its own terms.
    expect(isAbstractionWord("brink")).toBe(true);
    expect(isAbstractionWord("documentary")).toBe(false);
    expect(hasContentAnchor("documentary")).toBe(false);
  });

  it("nothing in the abstraction set is subject-specific", () => {
    /** Topic-agnostic by construction: no era, no place, no person, no war. */
    const SRC = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");
    const block = SRC.slice(
      SRC.indexOf("export const ABSTRACTION_VOCABULARY"),
      SRC.indexOf("export function isAbstractionWord")
    );
    for (const banned of ["hitler", "berlin", "nazi", "1945", "wwii", "german"]) {
      expect(block.toLowerCase(), banned).not.toContain(`"${banned}"`);
    }
  });

  it("the check is one definition, used by the gate and by the generators", () => {
    const SRC = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");
    expect(SRC).toContain("!isProductionWord(w) && !isFunctionWord(w) && !isAbstractionWord(w)");
    expect((SRC.match(/ABSTRACTION_VOCABULARY\.has\(/g) ?? []).length, "one reader").toBe(1);
  });
});
