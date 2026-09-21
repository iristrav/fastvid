/**
 * A SLOT WITH NO SENTENCE BEHIND IT SPENDS NOTHING.
 *
 * ── What render 594 paid for a slot whose answer was already decided ────────────────────────
 *
 *     [BeatRelevance]  s1b6: backfill approval requirement suspended: reason=slot_without_beat  (7×)
 *     [BeatLookups]    beat=s1b6 lookups=13 repeated=0 distinct_candidates=13 | declined: no_narration=8
 *     [YOUTUBE_TURN]   scene=1 beat=6 turn=START visualNeed=archival reservedMs=24000
 *     [VisualLineageEvent] … providerAssetId=LW9xaNF5iLs stage=DOWNLOAD_SUCCEEDED
 *     [YOUTUBE_TURN]   scene=1 beat=6 turn=END result=YOUTUBE_CANDIDATES_DELIVERED usedMs=35533
 *
 * Thirteen editor lookups and a thirty-six second YouTube download, for a slot that cannot earn an
 * approval because there is no sentence to judge a picture against. That was the ONLY YouTube
 * candidate the render produced.
 *
 * ── What this round changed, and what it did not ────────────────────────────────────────────
 *
 * The approval rule is untouched: `nothingToJudgeAgainst` still classifies `slot_without_beat`
 * exactly as it did, and no picture is admitted that was not admitted before. What changed is
 * WHEN the question is asked — before provider acquisition instead of after the bytes have
 * arrived — so the beat's turn, its download slot and its reserve stay with the beats that can
 * use them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { nothingToJudgeAgainst } from "./beatVisualRelevance";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** The body of one function, by brace matching from its declaration. */
function bodyOf(src: string, decl: string): string {
  const at = src.indexOf(decl);
  if (at < 0) return "";
  let depth = 0;
  for (let n = src.indexOf("{", at); n < src.length; n++) {
    if (src[n] === "{") depth++;
    else if (src[n] === "}" && --depth === 0) return src.slice(at, n + 1);
  }
  return src.slice(at);
}

/* ═══════════════════ THE PREDICATE ═══════════════════ */

describe("the predicate reads the record and claims nothing more", () => {
  const FN = bodyOf(PIPE, "function slotHasNoBeatBehindIt(");

  it("it exists, and it reads the scene's own beat count", () => {
    expect(FN, "slotHasNoBeatBehindIt is gone").not.toBe("");
    expect(FN).toContain("beatCountFor");
  });

  it("A MISSING COUNT IS NOT EVIDENCE OF A MISSING BEAT", () => {
    /**
     * The same rule the outcome split follows: a scope that cannot count knows less, not more.
     * Without this, a route that runs before the resolver is installed would stop sourcing for
     * every beat in the render.
     */
    expect(FN).toContain("beatCount != null");
    expect(FN).toContain("beatIndex >= beatCount");
  });

  it("an absent beat index is not a beatless slot either", () => {
    expect(FN).toContain("if (beatIndex == null) return false;");
  });
});

/* ═══════════════════ THE SOURCING ENTRIES ═══════════════════ */

describe("nothing is acquired for a slot with no sentence", () => {
  it("THE BEAT FILL ASKS BEFORE IT HYDRATES, SEARCHES OR FETCHES", () => {
    const fill = bodyOf(PIPE, "async function fillBeatVisual(");
    expect(fill, "fillBeatVisual is gone").not.toBe("");
    expect(
      fill,
      "fillBeatVisual's guard is absent or disabled"
    ).toContain('if (skipSourcingForBeatlessSlot("beat visual fill", scene.index, beat.index)) return false;');
    const guard = fill.indexOf("skipSourcingForBeatlessSlot");
    /**
     * Order is the whole point. Refusing after the archive prefetch, the geo lock or a provider
     * call is what already happened in production.
     */
    for (const later of [
      "hydrateSceneBeatInPlace",
      "archivePrefetch",
      "searchCuratedCandidatesForBeat",
    ]) {
      const at = fill.indexOf(later);
      if (at > 0) {
        expect(guard, `the guard runs after ${later}`).toBeLessThan(at);
      }
    }
  });

  it("AND THE ROUTE WITH ITS OWN FALLBACK LADDER ASKS TOO", () => {
    /**
     * `ensureBeatVisualFilled` calls `fillBeatVisual` and then has stock, rescue and guaranteed
     * rungs of its own. Guarding only the inner call would stop one rung and pay for the rest.
     */
    const ensure = bodyOf(PIPE, "async function ensureBeatVisualFilled(");
    expect(ensure, "ensureBeatVisualFilled is gone").not.toBe("");
    expect(
      ensure,
      "ensureBeatVisualFilled's guard is absent or disabled"
    ).toContain('if (skipSourcingForBeatlessSlot("beat visual fill", scene.index, beat.index)) return;');
    const guard = ensure.indexOf("skipSourcingForBeatlessSlot");
    const firstFetch = ensure.indexOf("adoptStockBeatClipFallback");
    if (firstFetch > 0) expect(guard).toBeLessThan(firstFetch);
  });

  it("THE YOUTUBE TURN IS REFUSED BEFORE THE SEARCH, not after the download", () => {
    const turn = PIPE.slice(
      PIPE.indexOf("turn=SKIPPED "),
      PIPE.indexOf("const attempt = await tryBeatRealYouTubeFootage(req);")
    );
    expect(turn, "the YouTube turn's guard block is gone").not.toBe("");
    /**
     * The exact conditional, not merely the name. `if (false && slotHasNoBeatBehindIt(...))`
     * contains the name and does nothing — a mutation proved that a presence check passes while
     * the guard is switched off.
     */
    expect(
      turn,
      "the YouTube turn's slot guard is absent or disabled"
    ).toContain("if (slotHasNoBeatBehindIt(sceneIndex, beat.index)) {");
    const guard = turn.indexOf("if (slotHasNoBeatBehindIt(sceneIndex, beat.index)) {");
    expect(turn).toContain("reason=slot_without_beat");
    /** It is asked before the query check and before any budget is spent. */
    const search = turn.indexOf("tryBeatRealYouTubeFootage");
    if (search > 0) expect(guard).toBeLessThan(search);
  });

  it("and the refusal is LOGGED, never silent", () => {
    const skip = bodyOf(PIPE, "function skipSourcingForBeatlessSlot(");
    expect(skip).toContain("console.warn");
    expect(skip).toContain("slot_without_beat");
  });
});

/* ═══════════════════ WHAT MAY NOT HAVE CHANGED ═══════════════════ */

describe("the gates this round may not touch", () => {
  it("THE APPROVAL RULE IS UNCHANGED — this is about spending, not about admitting", () => {
    for (const outcome of ["no_scope", "beat_unknown", "no_narration", "slot_without_beat"] as const) {
      expect(nothingToJudgeAgainst(outcome), outcome).toBe(true);
    }
    for (const outcome of ["judged", "already_judged", "placeholder", "budget_spent"] as const) {
      expect(nothingToJudgeAgainst(outcome), outcome).toBe(false);
    }
  });

  it("A NORMAL BEAT IS NOT TOUCHED", () => {
    /**
     * The guard's only true case is an index past the scene's last sentence. Every beat inside the
     * record — including one whose text is empty, which is a different finding — sources exactly
     * as it did.
     */
    const FN = bodyOf(PIPE, "function slotHasNoBeatBehindIt(");
    expect(FN).not.toContain("beatText");
    expect(FN).not.toContain("contextFor(");
    /** It reads a count. It does not read narration, subject, intent or any gate's verdict. */
    for (const f of ["relevance", "vision", "approve", "adopt"]) {
      expect(FN.toLowerCase(), `the predicate consults ${f}`).not.toContain(f);
    }
  });

  it("no shortlist, source-share or vision budget was moved by this round", () => {
    const gate = readFileSync(join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(gate).toContain(
      'export const MAX_JUDGEMENTS_PER_BEAT = envInt("MAX_BEAT_IMAGE_JUDGEMENTS_PER_BEAT", 4, 1, 12);'
    );
    const shortlist = readFileSync(join(__dirname, "beatShortlist.ts"), "utf8");
    expect(shortlist).toContain('envInt("MAX_BEAT_SHORTLIST", MAX_JUDGEMENTS_PER_BEAT * 2, 1, 40)');
    expect(shortlist).toContain('envInt("MAX_BEAT_SHORTLIST_PER_SOURCE", MAX_JUDGEMENTS_PER_BEAT, 1, 40)');
  });
});
