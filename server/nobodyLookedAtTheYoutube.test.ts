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
 * WHY THE SECOND FIX IS ONE LINE OF COMMENT IN THE PIPELINE AND ALL OF THIS HERE.
 *
 * `youtubeClipPassesImageGate` ends with an instruction in its own words: "DO NOT ADD PROSE
 * ANYWHERE ABOVE — put it after this return, or in a test file", because `ronde61GateRejectionSticks`
 * slices that function at 2600 characters and `ronde60YoutubeSegment` at 4200, and each proves a
 * rule lives inside its slice. A few hundred characters of explanation pushes one of them out and
 * the rule reads as deleted — a false finding produced by prose, which this file has produced
 * before. So the explanation lives here, where it costs nothing.
 *
 * ── What render 578 measured ────────────────────────────────────────────────────────────────
 *
 *     [VisionCensus] youtube_screening judged=24 unavailable=0 skipped=21
 *     [VisualFunnel]  youtube_cc retrieved=2479 downloadSucceeded=88 eligible=1 composed=0
 *
 * `maxYoutubeBeatImageJudgements()` is 24 and the render spent exactly 24 — the whole slice,
 * first-come, on whichever clips finished downloading first, of which it refused 22. The other
 * sixty-odd downloads met `if (used >= max) return true;` and were waved through.
 *
 * The caller reads that `true` as "passes the image gate" and puts the clip in the pool. So the
 * render's most expensive source spent most of its bandwidth on material admitted by a silent
 * yes, and the one number an operator can read about it — the screening census — counted 24 of 88
 * and said nothing whatever about the other 64. Not a wrong decision: an unrecorded one.
 *
 * ── What changes ────────────────────────────────────────────────────────────────────────────
 *
 * The answer is the same and the clip is still admitted. Turning it away would lose material the
 * beat gate can still judge, and the download is already paid for. What is added is that the
 * render SAYS a clip went in unscreened and counts how many did — incremented where the decision
 * is made rather than reconstructed afterwards from the gap between two other counters, which is
 * exactly the reconstruction nobody performed.
 */
describe("2. a spent judgement budget is not an approval", () => {
  const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("THE RENDER SAYS A CLIP WENT IN UNSCREENED", () => {
    expect(SRC).toContain("NOT_SCREENED");
    expect(SRC).toContain("gate.youtubeUnscreenedAdmissions = (gate.youtubeUnscreenedAdmissions ?? 0) + 1");
  });

  it("and counts them, so the number is stated rather than inferred", () => {
    const state = createBeatImageGateState();
    expect(state.youtubeUnscreenedAdmissions).toBe(0);
  });

  it("BOTH YOUTUBE NUMBERS REACH THE SUMMARY — one without the other misleads", () => {
    expect(SRC).toContain("youtube judged=${g.youtubeJudgementsUsed}");
    expect(SRC).toContain("unscreened=${g.youtubeUnscreenedAdmissions ?? 0}");
  });

  it("the clip is still ADMITTED — this is a record, not a new refusal", () => {
    /**
     * Turning the clip away would lose material the beat gate can still judge, and the download
     * is already paid for. RONDE 199b's lesson: a requirement that cannot be met empties the film.
     */
    const flat = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ");
    const idx = flat.indexOf("gate.youtubeUnscreenedAdmissions = ");
    expect(idx).toBeGreaterThan(-1);
    expect(flat.slice(idx, idx + 400)).toContain("return true;");
  });
});

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
