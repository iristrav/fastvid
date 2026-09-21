/**
 * WHAT COUNTS AS A PLACEHOLDER — one module, because six answers existed and no two agreed.
 *
 * ── The census that produced this file ──────────────────────────────────────────────────────
 *
 * Six independent predicates decided whether a clip "depicts nothing", and running them over the
 * filenames the pipeline actually writes gives six different films:
 *
 *   filename                          A      B      C      D
 *   scene_0_slot100_guaranteed.mp4   false  true   true   false
 *   scene_0_fallback.mp4             true   false  true   false
 *   scene_0_b1_ai_fallback.mp4       true   false  true   false
 *
 *   A  isPipelineFallbackClip   videoPipeline    /_fallback\.mp4$/i
 *   B  isGuaranteedClipName     beatVisualStatus /guaranteed|_slot\d+_guaranteed/i
 *   C  FALLBACK_RE              assetDirector    /color_fallback|fallback|guaranteed|placeholder|color_clip/i
 *                               globalDocumentaryDirector — a byte-identical second copy
 *   D  FALLBACK_BASENAMES       shotSequence     /^(color_fallback|fallback|guaranteed|…)/i
 *
 * D is anchored at the start of the basename and every name this pipeline writes begins with
 * `scene_`, so D has never matched anything in production. It is a predicate that has always
 * returned false, feeding a reorderer that has therefore never known a card from a picture.
 *
 * A is the one the DELIVERY GATE reads, through `renderJobWorker`, and A is false for
 * `_guaranteed.mp4` — which is the filename `generateGuaranteedBeatClip` writes for ALL FOUR of
 * its rungs, including the two that draw a card.
 *
 * ── Why the filename cannot be the authority, and what is ───────────────────────────────────
 *
 * `generateGuaranteedBeatClipInner` writes every rung to the same path:
 *
 *     scene_${sceneIndex}_slot${slotIndex}_guaranteed.mp4
 *
 * Its first two rungs (`topical`, `wikimedia`) fetch REAL footage — curated archive material and
 * a Commons file. Its last two (`text_overlay`, `color_fallback`) draw a card. All four land on
 * one name, so no regex over that name can separate them. Widening A to cover `_guaranteed.mp4`
 * would make the delivery gate refuse real rescued archive footage; narrowing B would blind the
 * status reader. Both directions are wrong because the question is being asked of the wrong thing.
 *
 * The answer exists, and it is recorded at the moment the clip is made: the TIER the ladder
 * returned, the adopt SOURCE the pipeline wrote, and the ROUTE those become on the ledger. This
 * module holds those three, and holds the filename predicates too — clearly marked as what they
 * are, so a caller that has nothing but a path knows exactly how much its answer is worth.
 *
 * Nothing here changes a threshold, a gate or a limit. It gives the existing rules one place to
 * read their own vocabulary from.
 */
import path from "path";

/* ═══════════════════════ 1. the tier — the authority at creation ═══════════════════════ */

/**
 * The four rungs of the guaranteed ladder, in the order it tries them.
 *
 * Declared here rather than imported from `videoPipeline`, so a module that only needs to ask
 * this question does not pull in fifty thousand lines to do it. `GuaranteedClipTier` in
 * videoPipeline and `BeatFillTier` in beatOutcomeAudit are the same four strings; a test pins
 * that they stay the same four.
 */
export type PlaceholderTier = "topical" | "wikimedia" | "text_overlay" | "color_fallback";

/** The rungs that fetch real media. Everything else on the ladder draws something. */
const REAL_MEDIA_TIERS: ReadonlySet<string> = new Set<PlaceholderTier>(["topical", "wikimedia"]);

/**
 * True when the ladder drew a card rather than fetching a picture.
 *
 * An UNKNOWN tier counts as a placeholder. That is the safe direction and it is the direction
 * `isPlaceholderGuaranteedTier` has always taken: a caller that did not pass the out-parameter
 * cannot prove it got real footage, and a render should not be credited with media it cannot name.
 */
export function tierIsPlaceholder(tier: string | undefined | null): boolean {
  return !REAL_MEDIA_TIERS.has(String(tier ?? ""));
}

/* ═══════════════════════ 2. the adopt source — the authority afterwards ═══════════════════════ */

/**
 * The adopt-audit source labels that mean "this pipeline manufactured it".
 *
 * `fallback` and `rescue_placeholder` are what the per-beat guaranteed-fill sites record, and are
 * the pair `isFillerAdoptSource` has always used. `guaranteed` and `color_fallback` are older
 * labels that three consumers still list defensively — `editorialReviewEngine`,
 * `editorialScoreFeedback` and the reporting in `clipAdoptAudit`. They are kept so that
 * consolidating on this set narrows nobody's answer.
 *
 * NOTE the one deliberate asymmetry: `adoptRouteForSource` maps `guaranteed` to `backfill`, not
 * to `fallback`. That is its own long-standing distinction — "a beat filled by something other
 * than the route that should have filled it" — and this set does not overrule it. This answers
 * "does it depict nothing"; that answers "which route filled the beat". Different questions.
 */
export const PLACEHOLDER_ADOPT_SOURCES: ReadonlySet<string> = new Set([
  "fallback",
  "rescue_placeholder",
  "guaranteed",
  "color_fallback",
]);

/** True when an adopt-audit source label names a card rather than media something chose. */
export function adoptSourceIsPlaceholder(source: string | undefined | null): boolean {
  return PLACEHOLDER_ADOPT_SOURCES.has(String(source ?? "").trim().toLowerCase());
}

/* ═══════════════════════ 3. the ledger route — the authority at delivery ═══════════════════════ */

/**
 * True when a lineage record's route is the one whose output depicts nothing.
 *
 * `adoptRouteForSource` already collapses `fallback` and `rescue_placeholder` onto the single
 * route `"fallback"`, and `deliveryGate`'s ledger-side reader has always used exactly this test.
 * It is named here so the render worker can ask the same question the pipeline's own gate asks,
 * instead of asking a filename.
 */
export function lineageRouteIsPlaceholder(route: string | undefined | null): boolean {
  return String(route ?? "").trim().toLowerCase() === "fallback";
}

/* ═══════════════════════ 4. the filename — a signal, never a verdict ═══════════════════════ */

/**
 * Every basename token this pipeline has ever written onto a manufactured clip.
 *
 * The union of the three regexes that were maintained separately, with the anchor dropped —
 * `shotSequenceOptimizer`'s `^` is the reason its copy never matched a real file.
 *
 * READ THE WARNING ON `clipPathLooksManufactured` BEFORE USING THIS TO REFUSE ANYTHING.
 */
export const MANUFACTURED_BASENAME_RE =
  /color_fallback|fallback|guaranteed|placeholder|color_clip|black_fill/i;

/**
 * A clip whose NAME suggests the pipeline made it — including the ladder's real-media rungs.
 *
 * OVER-REPORTS BY CONSTRUCTION. `scene_0_slot2_guaranteed.mp4` matches, and it is a curated
 * archive clip as often as it is a grey card, because all four rungs share the name. Use this to
 * SORT, to DESCRIBE or to raise a question. Never to reject a clip from a render: for that, ask
 * the tier, the adopt source or the ledger route, which know which rung answered.
 *
 * The three callers that classify shot types for reordering and reporting are exactly the right
 * kind of caller — a mislabelled clip changes an ordering heuristic, not a delivery.
 */
export function clipPathLooksManufactured(clipPath: string): boolean {
  return MANUFACTURED_BASENAME_RE.test(path.basename(clipPath || ""));
}

/**
 * The narrow, historical predicate: a clip written to a `*_fallback.mp4` path.
 *
 * This is `isPipelineFallbackClip`'s body, unchanged, moved here so there is one copy. It is
 * deliberately NOT widened to `_guaranteed.mp4`: the export gate and the delivery gate read it,
 * and the ladder's real rungs share that name, so widening it would refuse genuine footage. The
 * gap it leaves is closed where it should be — at the planner, by the tier — not by making this
 * regex guess harder.
 */
export function clipPathIsFallbackFile(clipPath: string): boolean {
  return /_fallback\.mp4$/i.test(path.basename(clipPath || ""));
}

/* ═══════════════════════ 5. the one question the timeline asks ═══════════════════════ */

/** Which authority answered, so a refusal names its evidence instead of asserting a verdict. */
export type PlaceholderVerdict = {
  placeholder: boolean;
  /** `TIER`, `ADOPT_SOURCE`, `LINEAGE_ROUTE`, `FILENAME`, or `NONE` when nothing objected. */
  authority: "TIER" | "ADOPT_SOURCE" | "LINEAGE_ROUTE" | "FILENAME" | "NONE";
  /** The value that decided it, for the log line. */
  evidence: string;
};

/**
 * IS THIS BEAT'S CLIP A CARD THIS PIPELINE DREW?
 *
 * The one question the timeline asks, answered from the strongest evidence available rather than
 * from whichever fact the caller happened to hold.
 *
 * ── The order, and why it is this order ─────────────────────────────────────────────────────
 *
 *   TIER          what the ladder returned at the moment it answered. Nothing is closer to the
 *                 truth, and it is the only fact that separates the ladder's four rungs.
 *   ADOPT_SOURCE  what the pipeline wrote down when it adopted the clip. Survives the tier going
 *                 out of scope, which it does at every call site but one.
 *   LINEAGE_ROUTE what that source became on the ledger. Survives into another process.
 *   FILENAME      a guess. Last, and only the narrow `_fallback.mp4` form — the wide token match
 *                 would refuse the ladder's real rungs, which is worse than missing a card.
 *
 * A caller that holds none of them gets `NONE`, which means "nothing here says it is a placeholder",
 * NOT "this was proven to be real media". The distinction matters: a beat with no record at all is
 * a different problem, and the caller that can tell them apart should be the one reporting it.
 */
export function beatClipIsPlaceholder(facts: {
  clipPath?: string | null;
  tier?: string | null;
  adoptSource?: string | null;
  lineageRoute?: string | null;
}): PlaceholderVerdict {
  if (facts.tier != null && String(facts.tier).length > 0) {
    if (tierIsPlaceholder(facts.tier)) {
      return { placeholder: true, authority: "TIER", evidence: String(facts.tier) };
    }
    /**
     * A REAL RUNG ENDS THE QUESTION.
     *
     * `topical` and `wikimedia` fetch genuine footage and write it to a `_guaranteed.mp4` name. If
     * this fell through to the filename check the clip would be refused for being named like the
     * card it is not — which is the exact mistake this module was written to stop.
     */
    return { placeholder: false, authority: "TIER", evidence: String(facts.tier) };
  }
  if (facts.adoptSource != null && adoptSourceIsPlaceholder(facts.adoptSource)) {
    return { placeholder: true, authority: "ADOPT_SOURCE", evidence: String(facts.adoptSource) };
  }
  if (facts.lineageRoute != null && lineageRouteIsPlaceholder(facts.lineageRoute)) {
    return { placeholder: true, authority: "LINEAGE_ROUTE", evidence: String(facts.lineageRoute) };
  }
  if (facts.clipPath && clipPathIsFallbackFile(facts.clipPath)) {
    return { placeholder: true, authority: "FILENAME", evidence: path.basename(facts.clipPath) };
  }
  return { placeholder: false, authority: "NONE", evidence: "" };
}
