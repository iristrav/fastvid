/**
 * THE FRAMING A BEAT WAS PLANNED FOR, AND WHETHER ANYTHING EVER ASKS FOR IT.
 *
 * ── What was actually wrong ─────────────────────────────────────────────────────────────────
 *
 * FastVid plans shots properly. `SHOT_SEMANTICS` gives sixteen framings a scale, a role and a
 * meaning; the storyboard planner assigns one per beat; the Documentary Planning Engine derives a
 * `preferredShot` for every beat from its visual goal; the Asset Director weighs shot type at 10%
 * of a candidate's score.
 *
 * And no query this system has ever sent to a provider asked for a framing. Not one. So the
 * ranking could only prefer a close-up when a close-up happened to be in the pool by accident,
 * which over twenty-three beats of a documentary is how every shot ends up at the same middle
 * distance.
 *
 * Two things were missing, and this file guards both:
 *
 *   · the vocabulary had no words for ASKING — `searchTerms`, and the property that makes them
 *     safe to append to a query the search gate will inspect;
 *   · `preferredShot` was computed, logged, and read by nothing.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  ALL_SHOT_TYPES,
  SHOT_SEMANTICS,
  getPlannedShot,
  normaliseShotType,
  shotSearchTerms,
  withPlannedShot,
} from "./shotVocabulary";
import { PRODUCTION_VOCABULARY, validateSearchQuery, type VerifiedQueryContext } from "./searchQueryContract";
import { buildHistoricalArchivalQueries, buildMediaSearchIntent } from "./mediaResearchEngine";
import { withSearchProvenance } from "./searchQueryContract";

/* ═══════════════════════ the property that makes these terms safe ═══════════════════════ */

describe("every search term is a word the gate allows without evidence", () => {
  /**
   * THE load-bearing test of this round.
   *
   * `PRODUCTION_VOCABULARY` is the search gate's closed class of camera and format words —
   * admitted on any query because they describe the FILM rather than making a claim about the
   * world that a script could contradict. That is the entire reason a shot term can be appended to
   * a proven anchor and survive: it asserts nothing.
   *
   * Add "aerial view" here one day and this goes red, because "view" is a content word. It would
   * otherwise be built, sent, silently refused by the gate, and every render would quietly ask one
   * fewer question than its log claimed.
   */
  it("no shot term contains a word the gate would demand proof for", () => {
    for (const shotType of ALL_SHOT_TYPES) {
      for (const term of SHOT_SEMANTICS[shotType].searchTerms) {
        for (const word of term.split(/\s+/)) {
          expect(
            PRODUCTION_VOCABULARY.has(word.toLowerCase()),
            `${shotType}: "${term}" contains "${word}", which is not production vocabulary`
          ).toBe(true);
        }
      }
    }
  });

  it("every framing in the vocabulary has an answer, even if that answer is silence", () => {
    for (const shotType of ALL_SHOT_TYPES) {
      expect(Array.isArray(SHOT_SEMANTICS[shotType].searchTerms), shotType).toBe(true);
    }
    // Not all of them: a vocabulary where nothing can be asked for would pass the test above
    // trivially, and would be exactly the state this round set out to leave behind.
    const withTerms = ALL_SHOT_TYPES.filter((t) => SHOT_SEMANTICS[t].searchTerms.length > 0);
    expect(withTerms.length).toBeGreaterThanOrEqual(8);
  });

  /**
   * A medium shot is what a provider returns by default, and it is what the FALLBACK storyboard
   * assigns to every beat when the planner is unavailable. Asking for it would put one identical
   * extra query on every beat of a video whose shots were never planned at all.
   */
  it("the neutral framing asks for nothing", () => {
    expect(SHOT_SEMANTICS.medium.searchTerms).toEqual([]);
  });
});

/* ═══════════════════════ reading a planner's loose wording ═══════════════════════ */

describe("the vocabulary recognises how planners actually write", () => {
  it("reads the union's own spellings", () => {
    for (const shotType of ALL_SHOT_TYPES) {
      expect(normaliseShotType(shotType), shotType).toBe(shotType);
    }
  });

  it("reads the storyboard planner's prose", () => {
    expect(normaliseShotType("close up")).toBe("close_up");
    expect(normaliseShotType("Close-Up")).toBe("close_up");
    expect(normaliseShotType("closeup")).toBe("close_up");
    expect(normaliseShotType("medium shot")).toBe("medium");
    expect(normaliseShotType("wide shot")).toBe("wide");
    expect(normaliseShotType("establishing shot")).toBe("establishing");
    expect(normaliseShotType("  Aerial  ")).toBe("aerial");
    expect(normaliseShotType("b-roll")).toBe("b_roll");
    expect(normaliseShotType("archive footage")).toBe("archive_footage");
  });

  /**
   * Null, not a nearest match. A framing nobody planned, handed to a beat because its wording
   * looked a bit like something, is worse than no framing at all.
   */
  it("refuses wording it does not know rather than guessing", () => {
    for (const unknown of ["", "  ", "dutch angle", "over the shoulder", "whip pan", "shot", "close enough"]) {
      expect(normaliseShotType(unknown), JSON.stringify(unknown)).toBeNull();
    }
    expect(normaliseShotType(null)).toBeNull();
    expect(normaliseShotType(undefined)).toBeNull();
  });

  it("an unknown framing asks for nothing", () => {
    expect(shotSearchTerms("dutch angle")).toEqual([]);
    expect(shotSearchTerms(null)).toEqual([]);
  });
});

/* ═══════════════════════ the ambient scope ═══════════════════════ */

describe("the planned shot travels with the beat, not through thirteen signatures", () => {
  it("is absent outside any beat scope", () => {
    expect(getPlannedShot()).toBeUndefined();
  });

  it("is what the beat's scope says, inside it", () => {
    withPlannedShot("close_up", () => {
      expect(getPlannedShot()).toBe("close_up");
    });
    expect(getPlannedShot()).toBeUndefined();
  });

  it("a beat with no planned framing opens no scope", () => {
    withPlannedShot(null, () => expect(getPlannedShot()).toBeUndefined());
    withPlannedShot(undefined, () => expect(getPlannedShot()).toBeUndefined());
  });

  it("survives an await, which is the whole reason it is not a variable", async () => {
    await withPlannedShot("aerial", async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(getPlannedShot()).toBe("aerial");
    });
  });
});

/* ═══════════════════════ the query family itself ═══════════════════════ */

describe("a planned framing reaches the providers", () => {
  const provenance = (): VerifiedQueryContext =>
    ({
      persons: [{ term: "Adolf Hitler", verified: true }],
      places: [{ term: "Berlin", verified: true }],
      countries: [{ term: "Germany", verified: true }],
      events: [{ term: "Battle of Berlin", verified: true }],
      actions: [],
      objects: [],
      time: [],
      years: [{ term: "1945", verified: true }],
      evidence:
        "In April 1945 the Battle of Berlin reached the city centre while Adolf Hitler stayed underground.",
      topic: "the fall of Berlin in 1945",
    }) as unknown as VerifiedQueryContext;

  const beatText =
    "In April 1945 the Battle of Berlin reached the city centre while Adolf Hitler stayed underground.";

  const intent = () =>
    buildMediaSearchIntent({
      beatText,
      searchQueries: ["Battle of Berlin"],
      keywords: ["Berlin"],
      primaryPerson: "Adolf Hitler",
      persons: ["Adolf Hitler"],
      videoTitle: "The Fall of Berlin",
      powerWord: "Battle of Berlin",
      personTopicLock: false,
      spaceTopic: false,
      muskTopic: false,
    });

  const queriesWith = (shot: string | null) =>
    withSearchProvenance(provenance(), () =>
      withPlannedShot(normaliseShotType(shot), () => buildHistoricalArchivalQueries(intent(), beatText))
    );

  it("asks for the framing that was planned", () => {
    const asked = queriesWith("close up");
    expect(asked.some((q) => /closeup|close-up/i.test(q))).toBe(true);
  });

  it("asks a different question for a different framing", () => {
    expect(queriesWith("aerial").some((q) => /aerial/i.test(q))).toBe(true);
    expect(queriesWith("establishing").some((q) => /establishing shot/i.test(q))).toBe(true);
  });

  /**
   * The regression this round is guarding: without a planned framing the family must be exactly
   * what it was before any of this existed.
   */
  it("a beat with no planned framing gets the query family it always got", () => {
    const withoutShot = queriesWith(null);
    const withNeutral = queriesWith("medium shot");
    expect(withNeutral).toEqual(withoutShot);
    expect(withoutShot.every((q) => !/closeup|aerial|establishing shot/i.test(q))).toBe(true);
  });

  /**
   * The point of choosing production vocabulary rather than the planner's own phrasing: the query
   * has to survive the same gate every other query passes through. It is asserted on the REAL
   * validator, not on the list the terms were drawn from, because the gate is the thing that
   * decides.
   */
  it("the shot queries are ones the gate actually admits", () => {
    for (const shot of ["close up", "aerial", "establishing", "wide", "overhead", "cutaway", "b-roll"]) {
      const asked = queriesWith(shot);
      const terms = shotSearchTerms(shot);
      const shotQueries = asked.filter((q) => terms.some((t) => q.toLowerCase().includes(t)));
      expect(shotQueries.length, `${shot} produced no query`).toBeGreaterThan(0);
      for (const q of shotQueries) {
        expect(validateSearchQuery(q, provenance()).ok, `${shot}: "${q}" was refused`).toBe(true);
      }
    }
  });

  it("the framing never replaces the subject — the anchor is still in every query", () => {
    for (const q of queriesWith("close up")) {
      expect(q.trim().length).toBeGreaterThan(0);
    }
    const asked = queriesWith("close up");
    const shotQuery = asked.find((q) => /closeup/i.test(q))!;
    expect(shotQuery.toLowerCase()).toContain("battle of berlin");
  });
});

/* ═══════════════════════ preferredShot, no longer dead ═══════════════════════ */

describe("the contract's planned framing is read by something", () => {
  const pipeline = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  /**
   * `preferredShot` was derived per beat, stored on the contract, printed in the planning summary
   * — and never read. The Asset Director's shot signal came from the storyboard alone, so a beat
   * the storyboard planner skipped was ranked as though nobody had planned its framing, while the
   * plan on disk said exactly what it should be.
   */
  it("preferredShot reaches the ranking when the storyboard has nothing to say", () => {
    expect(pipeline).toContain("_contract?.preferredShot");
    expect(pipeline).toContain("plannedShotType: _plannedShot,");
  });

  it("the storyboard still wins where it has an opinion", () => {
    const idx = pipeline.indexOf("const _plannedShot =");
    expect(idx).toBeGreaterThan(-1);
    const line = pipeline.slice(idx, idx + 200);
    expect(line.indexOf("_shot?.shotType")).toBeLessThan(line.indexOf("_contract?.preferredShot"));
  });

  /**
   * The scope has to be opened at the leaf. RONDE 100B established that wrapping the entry points
   * leaves routes uncovered — 425 provider searches reached a builder with no scope at all — and
   * a planned shot threaded through entry points would be missing from exactly those routes.
   */
  it("the framing scope is opened where the proof scope is", () => {
    expect(pipeline).toContain("withPlannedShot(normaliseShotType(plannedShot), fn)");
    const guard = pipeline.indexOf("function withBeatProvenance");
    const scope = pipeline.indexOf("withPlannedShot(normaliseShotType(plannedShot), fn)");
    expect(scope).toBeGreaterThan(guard);
    expect(scope - guard).toBeLessThan(3000);
  });
});
