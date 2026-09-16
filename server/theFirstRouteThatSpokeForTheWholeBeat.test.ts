/**
 * RONDE 253 — THE FIRST ROUTE THAT SPOKE FOR THE WHOLE BEAT.
 *
 * ── What 8df4422 fixed, and what it could not reach ─────────────────────────────────────────
 *
 * RONDE 252 repaired two adoption loops that walked a list they already held, handing `adoptClip`
 * one path at a time. Twenty candidates became twenty selections of one. Both loops now offer the
 * list, and `adoptClip` ranks it and declares the beat's vision review pool from that ranking.
 *
 * That fix is necessary and it is not sufficient, because of the line it cannot see:
 *
 *     // A route that runs after another has already declared adds nothing — the first cut stands.
 *     if (pool.declared.length > 0) return;
 *
 * A beat is not resolved by one route. Render 585 measured `rankRuns=13` against `ranked=6` on a
 * single beat: thirteen invocations of `adoptClip`, each declaring. And two of the routes that can
 * run FIRST are deliberately single-winner — Europeana and the Openverse web-wide fallback both
 * fetch with `count=1`, take `[0]`, and call `adoptClip([winner.path], …)`. They are right to.
 *
 * But the first of them to run froze the beat's declared pool at ONE, permanently. Every later
 * route could then aggregate ten candidates, rank them, review them — and the beat's own record of
 * what it had nominated still read `reviewPool=1`. Render 585 shows the incoherence directly:
 * `reviewed > declared` on s0b0 and s2b2, which is impossible under a model where a candidate is
 * declared and then reviewed.
 *
 * So the cap was never the constraint, and neither was the ranking. The beat had a budget of eight
 * and spent one, because the first route to speak spoke for all of them.
 *
 * ── What the declaration means now ──────────────────────────────────────────────────────────
 *
 * The candidates this beat nominated for the picture editor, across all of its routes, bounded by
 * the beat's own cap. A later route adds what it nominated into whatever room is left; it never
 * displaces what an earlier route declared, so the first cut still has priority — it simply no
 * longer has exclusivity.
 *
 * NOTHING HERE RAISES A BUDGET. The cap is `maxShortlistPerBeat()`, unchanged, and the
 * REVIEW_POOL_OVER_BUDGET invariant that guards it is unchanged.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  buildVisionReviewPool,
  createVisionReviewPoolState,
  declareVisionReviewPool,
  formatVisionSelection,
  neverReachedEditor,
  beatReviewPool,
  visionSelectionViolations,
  type ReviewCandidate,
} from "./visionAwareSelection";

const PIPE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const candidates = (...keys: string[]): ReviewCandidate[] =>
  keys.map((contentKey, cheapRank) => ({ contentKey, cheapRank }));

/** The two single-winner routes that can run first, then a route that aggregated ten. */
const singleWinnerFirst = () => {
  const state = createVisionReviewPoolState();
  declareVisionReviewPool(state, 0, 0, candidates("europeana:solo"), 8);
  return state;
};

describe("1. a single-winner route no longer speaks for the whole beat", () => {
  /**
   * THE EXACT SHAPE FROM RENDER 585. Europeana fetched one, adopted nothing usable, and the
   * media-research route then aggregated ten — and the beat still reported reviewPool=1.
   */
  it("a later route's ten candidates reach a pool the first route opened at one", () => {
    const state = singleWinnerFirst();
    declareVisionReviewPool(
      state, 0, 0,
      candidates("youtube_cc:a", "wikimedia:b", "internet_archive:c", "youtube_cc:d",
                 "wikimedia:e", "internet_archive:f", "youtube_cc:g", "wikimedia:h",
                 "pexels:i", "pixabay:j"),
      8
    );
    const line = formatVisionSelection(state).find((l) => l.includes("s0b0"))!;
    expect(line, "render 585 printed reviewPool=1 here").toContain("reviewPool=8");
  });

  it("and the first route's own candidate is still in the pool it opened", () => {
    const state = singleWinnerFirst();
    declareVisionReviewPool(state, 0, 0, candidates("wikimedia:b", "youtube_cc:a"), 8);
    expect(beatReviewPool(state, 0, 0).declared).toContain("europeana:solo");
  });

  /** Priority, not exclusivity: what was declared first keeps its place at the front. */
  it("a later route appends into free room and displaces nothing", () => {
    const state = singleWinnerFirst();
    declareVisionReviewPool(state, 0, 0, candidates("wikimedia:b", "youtube_cc:a"), 8);
    expect(beatReviewPool(state, 0, 0).declared).toEqual([
      "europeana:solo",
      "wikimedia:b",
      "youtube_cc:a",
    ]);
  });
});

describe("2. the cap is still the cap", () => {
  it("three routes offering six each declare eight, not eighteen", () => {
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 1, 0, candidates("a:1", "a:2", "a:3", "a:4", "a:5", "a:6"), 8);
    declareVisionReviewPool(state, 1, 0, candidates("b:1", "b:2", "b:3", "b:4", "b:5", "b:6"), 8);
    declareVisionReviewPool(state, 1, 0, candidates("c:1", "c:2", "c:3", "c:4", "c:5", "c:6"), 8);
    expect(beatReviewPool(state, 1, 0).declared).toHaveLength(8);
  });

  it("and the over-budget invariant stays silent, because nothing went over", () => {
    const state = createVisionReviewPoolState();
    for (const p of ["a", "b", "c", "d"]) {
      declareVisionReviewPool(state, 2, 1, candidates(`${p}:1`, `${p}:2`, `${p}:3`), 8);
    }
    expect(
      visionSelectionViolations(state).filter((v) => v.includes("REVIEW_POOL_OVER_BUDGET"))
    ).toEqual([]);
  });

  /** A beat whose cap is already full ignores a later route entirely, as it must. */
  it("a full pool takes nothing more", () => {
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 3, 0, candidates("a:1", "a:2", "a:3", "a:4"), 4);
    declareVisionReviewPool(state, 3, 0, candidates("b:1", "b:2"), 4);
    expect(beatReviewPool(state, 3, 0).declared).toEqual(["a:1", "a:2", "a:3", "a:4"]);
  });
});

describe("3. one asset nominated by two routes is one candidate", () => {
  /**
   * Routes overlap by design — the same Wikimedia file can be reached from the archival route and
   * the media-research route. Counting it twice would inflate the pool with one picture.
   */
  it("a candidate two routes both nominated occupies one slot", () => {
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 4, 0, candidates("wikimedia:same", "youtube_cc:x"), 8);
    declareVisionReviewPool(state, 4, 0, candidates("wikimedia:same", "youtube_cc:y"), 8);
    const declared = beatReviewPool(state, 4, 0).declared;
    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toEqual(["wikimedia:same", "youtube_cc:x", "youtube_cc:y"]);
  });
});

describe("4. a single route behaves exactly as it did before", () => {
  /**
   * The regression that matters most: the one-route case is the case RONDE 194 designed, and this
   * change must be invisible to it.
   */
  it("one route offering ten still declares the cheapest-ranked eight", () => {
    const ten = candidates("a:1", "a:2", "a:3", "a:4", "a:5", "a:6", "a:7", "a:8", "a:9", "a:10");
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 5, 0, ten, 8);
    expect(beatReviewPool(state, 5, 0).declared).toEqual(
      buildVisionReviewPool(ten, 8).map((c) => c.contentKey)
    );
  });

  it("a genuinely single-candidate beat still declares one", () => {
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 6, 0, candidates("only:one"), 8);
    expect(formatVisionSelection(state).find((l) => l.includes("s6b0"))!).toContain("reviewPool=1");
  });

  it("a cap of zero declares nothing, however many routes ask", () => {
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 7, 0, candidates("a:1", "a:2"), 0);
    declareVisionReviewPool(state, 7, 0, candidates("b:1"), 0);
    expect(beatReviewPool(state, 7, 0).declared).toEqual([]);
  });
});

describe("5. the candidates nobody asked about are still named", () => {
  /**
   * `neverReachedEditor` derives its answer from declared minus reviewed. A pool that now records
   * every route's nominations makes that number LARGER and more honest — the beats that declared
   * eight and reviewed two were always doing that; only the record was short.
   */
  it("a pool filled by three routes reports every unanswered candidate", () => {
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 8, 0, candidates("a:1", "a:2"), 8);
    declareVisionReviewPool(state, 8, 0, candidates("b:1", "b:2"), 8);
    expect(neverReachedEditor(beatReviewPool(state, 8, 0))).toEqual(["a:1", "a:2", "b:1", "b:2"]);
  });
});

describe("6. nothing was loosened to achieve this", () => {
  it("the pool is still declared with the beat's own shortlist cap", () => {
    expect(PIPE).toContain("maxShortlistPerBeat()");
  });

  it("and the vision gate still has its own per-beat judgement ceiling", () => {
    const gate = readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(gate).toContain("MAX_JUDGEMENTS_PER_BEAT");
    expect(gate).toContain('process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE !== "false"');
  });

  /** The two intentional single-winner routes are untouched — they ask for one and take one. */
  it("the single-winner routes still hand over one path", () => {
    expect([...PIPE.matchAll(/adoptClip\(\s*\[winner\.path\]/g)]).toHaveLength(2);
  });
});
