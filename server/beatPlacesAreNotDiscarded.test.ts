/**
 * RONDE 88A §7.3 — THE BEAT NAMED THE FÜHRERBUNKER AND THE CONTEXT KEPT BERLIN.
 *
 * ── What render 568 measured ─────────────────────────────────────────────────────────────────
 *
 *     terms=["Adolf Hitler","Joseph Stalin","wrapped","bunker"]
 *
 * No Führerbunker. The obvious reading — the extractor does not know the word — is wrong, and
 * this file exists because measuring it said so:
 *
 *     "Hitler spent his final days in the Führerbunker."           ->  "Führerbunker"
 *     "In the Führerbunker beneath Berlin, Adolf Hitler wrapped…"  ->  "Berlin"
 *
 * It knows the word. The beat named two places and `extractVisualPlacePhrase` returns ONE, so the
 * specific location lost to the generic city: step 2 (a phrase the geo vocabulary recognises) runs
 * before step 3, and step 3's own comment names Führerbunker as its reason for existing. "Berlin"
 * is in the vocabulary. "Führerbunker" is in no vocabulary at all — which is exactly what makes it
 * the term an archive search needs.
 *
 * ── Two changes, and the line between them ───────────────────────────────────────────────────
 *
 * COMPLETENESS. The context keeps every place the beat names, primary first. The preference order
 * is untouched, so `place` — which feeds the geo gates, the typed retrieval context and every
 * query built from `places[0]` — is byte for byte what it was. Reordering it to fix a completeness
 * problem would be a pipeline-wide ranking change, and this round does not make one.
 *
 * A CATEGORY ERROR. `PLACE_PREPOSITIONS` contains "of", so step 3 caught names as well as
 * locations, and the WINNER could be a person:
 *
 *     "The final hours of Adolf Hitler in the Führerbunker."  ->  "Adolf Hitler"
 *
 * That is not a ranking question. It is corrected with the beat's own person extractor — the same
 * relation `extractPersonNamesFromText` already enforces in the other direction — and the tests
 * below pin both the correction and the fact that it takes nothing else with it.
 *
 * ── What is NOT a defect, having checked ─────────────────────────────────────────────────────
 *
 * `"wrapped"` in that terms list reads like an invented entity and is not one. It is the beat's
 * own verb, returned by `extractActionCue`, whose docstring states the trade-off deliberately:
 * the morphological branch is generous because "an action only ever appears in a query behind an
 * entity that anchors it". `buildPrioritisedQueries` bears that out — every combination
 * containing `action` also contains `p1`. The word is in the script, it never leads a query, and
 * a test below holds that guarantee in place.
 */
import { describe, expect, it } from "vitest";

import {
  buildVerifiedQueryContextForBeat,
  extractActionCue,
  extractVisualPlacePhrase,
  extractVisualPlacePhrases,
} from "./videoPipeline";
import {
  buildPrioritisedQueries,
  emptyQueryContext,
  validateSearchQuery,
} from "./searchQueryContract";

const BUNKER_AND_CITY = "In the Führerbunker beneath Berlin, Adolf Hitler wrapped himself in silence.";

/* ═══════════════ the beat's places, all of them ═══════════════ */

describe("a beat that names two places keeps both", () => {
  it("returns the specific location alongside the city", () => {
    expect(extractVisualPlacePhrases(BUNKER_AND_CITY)).toEqual(["Berlin", "Führerbunker"]);
  });

  it("puts them all in the query context, verified", () => {
    const ctx = buildVerifiedQueryContextForBeat(BUNKER_AND_CITY);
    expect(ctx.places.map((p) => p.term)).toEqual(["Berlin", "Führerbunker"]);
    expect(ctx.places.every((p) => p.verified)).toBe(true);
    expect(ctx.places.every((p) => p.source === "beat_text")).toBe(true);
  });

  /** The whole point: the context can no longer be asked and answer no. */
  it("can now be asked whether the beat mentions the Führerbunker", () => {
    const ctx = buildVerifiedQueryContextForBeat(BUNKER_AND_CITY);
    expect(ctx.places.some((p) => p.term === "Führerbunker")).toBe(true);
  });

  it("names a place once, however often the beat says it", () => {
    const out = extractVisualPlacePhrases("From Berlin to Berlin, in Berlin.");
    expect(out).toEqual(["Berlin"]);
  });

  it("says nothing about a beat that names no place", () => {
    expect(extractVisualPlacePhrases("He said nothing for a long time.")).toEqual([]);
    expect(extractVisualPlacePhrases("")).toEqual([]);
  });
});

/* ═══════════════ the winner is unchanged ═══════════════ */

describe("the four-step preference order still decides which place is THE place", () => {
  /** Each case names the step it pins, so a reordering cannot pass by rewriting one expectation. */
  const cases: Array<[string, string, string]> = [
    ["1 — a building noun anywhere", "The Brandenburg Gate stood in ruins.", "Brandenburg Gate"],
    ["2 — a prepositional phrase the vocabulary knows", BUNKER_AND_CITY, "Berlin"],
    ["3 — any other prepositional phrase", "Hitler spent his final days in the Führerbunker.", "Führerbunker"],
    ["4 — a bare geo run", "Berlin was under constant bombardment in April 1945.", "Berlin"],
  ];

  for (const [step, beat, expected] of cases) {
    it(`step ${step}`, () => {
      expect(extractVisualPlacePhrase(beat)).toBe(expected);
    });
  }

  it("is the head of the list, by construction", () => {
    for (const [, beat] of cases) {
      expect(extractVisualPlacePhrases(beat)[0]).toBe(extractVisualPlacePhrase(beat));
    }
  });

  /** A month is never a place, at any step — the rule the original function opened with. */
  it("never reads a month as a place", () => {
    expect(extractVisualPlacePhrases("It happened in April and again in May.")).toEqual([]);
  });
});

/* ═══════════════ a person is not a place ═══════════════ */

describe("a name the beat states is never returned as a place", () => {
  /** Measured before the guard existed: this returned "Adolf Hitler". */
  it("prefers the location over the person the preposition also caught", () => {
    const beat = "The final hours of Adolf Hitler in the Führerbunker.";
    expect(extractVisualPlacePhrase(beat)).toBe("Führerbunker");
    expect(extractVisualPlacePhrases(beat)).toEqual(["Führerbunker"]);
  });

  it("drops the person from the list too, not only from the winner", () => {
    const beat = "Churchill spoke of Winston Churchill and of Dunkirk.";
    expect(extractVisualPlacePhrases(beat)).toEqual(["Dunkirk"]);
  });

  /** "" is the honest answer when every candidate turned out to be a man. */
  it("returns nothing rather than naming a man as a place", () => {
    const beat = "This is the story of Adolf Hitler.";
    expect(extractVisualPlacePhrase(beat)).toBe("");
    expect(buildVerifiedQueryContextForBeat(beat).places).toEqual([]);
  });

  /** A place whose name is also a surname stays a place — the guard must not be greedy. */
  it("keeps a real place the beat sets its action in", () => {
    expect(extractVisualPlacePhrases("Soldiers advanced through the ruined streets of Stalingrad."))
      .toContain("Stalingrad");
  });
});

/* ═══════════════ and nothing downstream was loosened or reordered ═══════════════ */

describe("the extra places change what the context KNOWS, not what the gate ALLOWS", () => {
  /**
   * `validateSearchQuery` already proves every word of `ctx.evidence`, and the beat text IS that
   * evidence. So the word was provable from the script before it was ever typed as a place — a
   * place token says WHAT KIND of thing it is, and proves nothing new.
   */
  it("proves nothing a bare evidence context did not already prove", () => {
    const evidenceOnly = emptyQueryContext(BUNKER_AND_CITY);
    expect(evidenceOnly.places).toEqual([]);
    expect(validateSearchQuery("Führerbunker", evidenceOnly).ok).toBe(true);
  });

  it("still refuses a place the beat never named", () => {
    const ctx = buildVerifiedQueryContextForBeat(BUNKER_AND_CITY);
    expect(validateSearchQuery("Reichstag", ctx).ok).toBe(false);
    expect(validateSearchQuery("Dunkirk", ctx).ok).toBe(false);
  });

  /**
   * `buildPrioritisedQueries` reads `places[0]` and nothing else, so a second place cannot change
   * a single built query. Stated as a test because it is the reason the winner did not need
   * reordering — and because letting the secondary place into the query family is the NEXT
   * question, deliberately not answered here.
   */
  it("builds the same queries it always did, from the primary place only", () => {
    const ctx = buildVerifiedQueryContextForBeat(BUNKER_AND_CITY);
    const queries = buildPrioritisedQueries(ctx).map((q) => q.query);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((q) => q.includes("Berlin"))).toBe(true);
    expect(queries.some((q) => q.includes("Führerbunker"))).toBe(false);
  });
});

/* ═══════════════ "wrapped" is the beat's own word, and it never leads ═══════════════ */

describe("the action cue is not an invented entity", () => {
  it("is a verb the beat actually contains", () => {
    const beat = "Adolf Hitler and Joseph Stalin wrapped the bunker in secrecy.";
    expect(extractActionCue(beat)).toBe("wrapped");
    expect(beat.toLowerCase()).toContain("wrapped");
  });

  /** Render 568's exact terms list, reproduced from the real extractors. */
  it("reproduces the audit line the report was written about", () => {
    const ctx = buildVerifiedQueryContextForBeat(
      "Adolf Hitler and Joseph Stalin wrapped the bunker in secrecy."
    );
    const terms = [
      ...ctx.persons, ...ctx.places, ...ctx.countries, ...ctx.events,
      ...ctx.actions, ...ctx.objects, ...ctx.time, ...ctx.years,
    ].filter((t) => t.verified).map((t) => t.term);
    expect(terms).toEqual(["Adolf Hitler", "Joseph Stalin", "wrapped", "bunker"]);
  });

  /**
   * The guarantee `extractActionCue`'s docstring rests on when it admits to being generous. If a
   * loose verb could ever lead a query, that trade-off would stop being acceptable.
   */
  it("never leads a query — every action query carries a person too", () => {
    const ctx = buildVerifiedQueryContextForBeat(
      "Adolf Hitler wrapped the Führerbunker in secrecy in 1945."
    );
    expect(ctx.actions.map((a) => a.term)).toContain("wrapped");
    for (const { query } of buildPrioritisedQueries(ctx)) {
      if (!query.toLowerCase().includes("wrapped")) continue;
      expect(query.startsWith("Adolf Hitler"), `"${query}" leads with the verb`).toBe(true);
    }
  });
});
