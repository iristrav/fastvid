import { describe, expect, it } from "vitest";
import {
  buildBeatVisualQueryList,
  buildPersonCelebrityVideoQueries,
  extractActionCue,
  extractPersonNamesFromText,
  extractVisualPlacePhrase,
  scriptStockSearchQueries,
  typedQueryPrefix,
} from "./videoPipeline";
import {
  buildHistoricalArchivalQueries,
  buildMediaSearchIntent,
  buildTypedRetrievalContext,
  centralTypedQueries,
  extractEventCue,
  extractEventPhraseForQuery,
  extractLocationPhrase,
  extractPeriodPhrase,
  type TypedRetrievalContext,
} from "./mediaResearchEngine";
import {
  buildInternetArchiveGeoQueries,
  buildWikimediaVideoGeoQueries,
} from "./geoDocumentarySources";
import { buildGeoStockSearchQueries } from "./curatedMediaSourcing";
import { beatVisualSearchSubjects } from "./scriptVisualKeywords";
import { uniqueQueryStrings, toQueryString } from "./stringCoercion";
import type { Scene } from "@shared/schema";

/**
 * RONDE 78 — the five context categories, complete, and proven to reach the provider.
 *
 * RONDE 77 left three gaps that this round closes:
 *
 *   event   was the bare verb out of EVENT_CUE_RE. "The Brandenburg Gate stood in ruins after
 *           the Battle of Berlin." contributed "battle" — the name of the event was thrown away.
 *   time    was the bare year. A beat that says "April 1945" knew more than "1945".
 *   person  could be overruled by the caller. A celebrity fetch for Hitler on the beat
 *           "Churchill addressed the nation after the fall of France." asked "Adolf Hitler
 *           France" first, about the wrong man.
 *
 * Every test runs the real functions on real narration. The four beats are the brief's, used as
 * measurements and never as special cases: §A asserts the extractors, §D–§F follow the same four
 * beats all the way to the query list each provider path is handed.
 */

const TITLE = "The final days of Hitler in the Fuhrerbunker — April 1945";

const BEAT_1 = "Adolf Hitler dictated his final political testament in the Fuhrerbunker in April 1945.";
const BEAT_2 = "The Brandenburg Gate stood in ruins after the Battle of Berlin.";
const BEAT_3 = "Soviet soldiers raised their flag over the Reichstag in April 1945.";
const BEAT_4 = "Churchill addressed the nation after the fall of France.";
const ALL = [BEAT_1, BEAT_2, BEAT_3, BEAT_4];

/** buildBeatVisualQueryList reads no field of the scene; it is threaded through for its callers. */
const SCENE = { text: "", beats: [] } as unknown as Scene;

/** The context exactly as every production path assembles it. */
function ctxFor(beat: string, persons: string[] = []): TypedRetrievalContext {
  return buildTypedRetrievalContext(beat, {
    persons: persons.length ? persons : extractPersonNamesFromText(beat),
    place: extractVisualPlacePhrase(beat),
    action: extractActionCue(beat),
  });
}

/** Exactly what typedRetrievalQueriesForBeat hands the RONDE 73/75 provider paths. */
function archivalQueries(beat: string): string[] {
  const persons = extractPersonNamesFromText(beat);
  const intent = buildMediaSearchIntent({
    beatText: beat,
    searchQueries: scriptStockSearchQueries(beat, persons, beat, TITLE),
    keywords: [],
    primaryPerson: "",
    persons,
    videoTitle: TITLE,
    powerWord: beatVisualSearchSubjects(beat)[0] ?? "",
    personTopicLock: false,
    spaceTopic: false,
    muskTopic: false,
  });
  return buildHistoricalArchivalQueries(intent, beat, {
    place: extractVisualPlacePhrase(beat),
    action: extractActionCue(beat),
  });
}

/** The list adoptInternetArchiveBeatClip hands to fetchInternetArchiveClips. */
function iaQueries(beat: string): string[] {
  const geo = buildInternetArchiveGeoQueries(beat, TITLE, 0);
  return uniqueQueryStrings([...archivalQueries(beat).slice(0, 3), ...geo], 3).slice(0, 11);
}

/** The list adoptWikimediaBeatClip iterates for Wikimedia video. */
function wikiQueries(beat: string): string[] {
  return uniqueQueryStrings(
    [
      ...archivalQueries(beat).slice(0, 3),
      ...buildGeoStockSearchQueries(beat, TITLE).slice(0, 3),
      ...buildWikimediaVideoGeoQueries(beat, TITLE),
      toQueryString(""),
    ],
    3
  ).slice(0, 11);
}

/* ═════════════ §A — the five categories ═════════════ */

describe("RONDE 78 §A — the beat's typed retrieval context", () => {
  it("BEAT 1 — person, place, time, event and action are all present", () => {
    const c = ctxFor(BEAT_1);
    expect(c.person).toBe("Adolf Hitler");
    expect(c.place).toBe("Fuhrerbunker");
    expect(c.time).toBe("April 1945");
    expect(c.year).toBe("1945");
    expect(c.event).toContain("political testament");
    expect(c.action).toBe("dictated");
  });

  it("BEAT 2 — place, the NAMED event, and the action", () => {
    const c = ctxFor(BEAT_2);
    expect(c.place).toContain("Brandenburg Gate");
    expect(c.event).toContain("Battle of Berlin");
    expect(c.action).toBe("stood");
    // The beat states no year, so the context claims none — not the title's 1945.
    expect(c.time).toBe("");
    expect(c.year).toBe("");
    expect(c.person).toBe("");
  });

  it("BEAT 3 — place, time and action, with the object beside them", () => {
    const c = ctxFor(BEAT_3);
    expect(c.place).toBe("Reichstag");
    expect(c.time).toBe("April 1945");
    expect(c.action).toBe("raised");
    expect(c.object).toBe("flag");
    expect(c.person).toBe("");
  });

  it("BEAT 4 — Churchill is the person, France the place", () => {
    const c = ctxFor(BEAT_4);
    expect(c.person).toBe("Churchill");
    expect(c.place).toBe("France");
    expect(c.action).toBe("addressed");
    expect(c.event).toContain("fall of France");
  });

  it("every field is a string, and an absent field is \"\" — never null or undefined", () => {
    for (const beat of [...ALL, "The war changed everything.", ""]) {
      const c = ctxFor(beat);
      for (const [k, v] of Object.entries(c)) {
        expect(typeof v, `${k} on "${beat.slice(0, 24)}"`).toBe("string");
        expect(v).toBe(v.trim());
        expect(v).not.toContain("undefined");
      }
    }
  });
});

describe("RONDE 78 §A2 — the event is named, and the ranking cue is untouched", () => {
  it("the query path gets the name, the ranking path keeps the verb", () => {
    // These two answers are deliberately different. extractEventCue feeds classifyBeatFocus and
    // eventMatchScore; changing it would change ranking, which this round does not do.
    expect(extractEventPhraseForQuery(BEAT_2, "stood")).toBe("Battle of Berlin");
    expect(extractEventCue(BEAT_2)).toBe("battle");
  });

  it("the direct object of the verb is recovered without a vocabulary for it", () => {
    // "testament" is in no list in this codebase. It is found because it is what the verb governs.
    expect(extractEventPhraseForQuery(BEAT_1, "dictated")).toBe("political testament");
    expect(extractEventPhraseForQuery("He signed the surrender document at Reims.", "signed"))
      .toContain("surrender");
  });

  it("named events are recognised generically, not from a list of famous ones", () => {
    expect(extractEventPhraseForQuery("Troops massed before the Siege of Leningrad.", ""))
      .toBe("Siege of Leningrad");
    expect(extractEventPhraseForQuery("It followed the Treaty of Versailles.", ""))
      .toBe("Treaty of Versailles");
    expect(extractEventPhraseForQuery("Reports arrived after the fall of Singapore.", ""))
      .toBe("fall of Singapore");
  });

  it("NEGATIVE — a lower-case object is not read as a named event", () => {
    // \\p{Lu} must stay case-sensitive: "the fall of night" is not an event.
    expect(extractEventPhraseForQuery("They waited for the fall of night.", "")).not.toContain("night");
  });

  it("NEGATIVE — no event is invented where the beat states none", () => {
    expect(extractEventPhraseForQuery("The war changed everything.", "changed")).toBe("");
    expect(extractEventPhraseForQuery("", "")).toBe("");
    expect(extractEventPhraseForQuery("   ", "raised")).toBe("");
  });
});

describe("RONDE 78 §A3 — the period, month and all", () => {
  it("keeps the month the beat names", () => {
    expect(extractPeriodPhrase(BEAT_1)).toBe("April 1945");
    expect(extractPeriodPhrase(BEAT_3)).toBe("April 1945");
    expect(extractPeriodPhrase("The order came in December 1944.")).toBe("December 1944");
  });

  it("falls back to the bare year, and to nothing at all", () => {
    expect(extractPeriodPhrase("Berlin was encircled in 1945.")).toBe("1945");
    expect(extractPeriodPhrase(BEAT_2)).toBe("");
    expect(extractPeriodPhrase("")).toBe("");
    // A month with no year is not a period — the year is what an archive indexes.
    expect(extractPeriodPhrase("He arrived in Munich in March.")).toBe("");
  });
});

/* ═════════════ §B — query generation ═════════════ */

describe("RONDE 78 §B — the combinations the context makes possible", () => {
  it("BEAT 1 — person+place+time, person+event+time and place+event+time all exist", () => {
    const qs = centralTypedQueries(ctxFor(BEAT_1));
        // RONDE 88 §4: the bare name+place leads and the year-qualified form follows at position 2
    // (that brief states it with a worked example: "Hitler Poland", then "Hitler Poland 1939").
    // The typed combination still leads and still carries the year.
    expect(qs[0]).toBe("Adolf Hitler Fuhrerbunker");
    expect(qs[1]).toBe("Adolf Hitler Fuhrerbunker 1945");
    expect(qs).toContain("Adolf Hitler political testament 1945");
    expect(qs).toContain("Fuhrerbunker political testament 1945");
    expect(qs).toContain("Adolf Hitler Fuhrerbunker dictated");
    // And the month-qualified variant, behind the year-only ones.
    expect(qs).toContain("Adolf Hitler Fuhrerbunker April 1945");
    expect(qs.indexOf("Adolf Hitler Fuhrerbunker April 1945"))
      .toBeGreaterThan(qs.indexOf("Adolf Hitler Fuhrerbunker"));
  });

  it("BEAT 2 — the named event reaches the query", () => {
    const qs = centralTypedQueries(ctxFor(BEAT_2));
    expect(qs[0]).toBe("Brandenburg Gate Battle of Berlin");
    expect(qs).toContain("Brandenburg Gate stood");
  });

  it("BEAT 3 — place+object+time and place+action survive together", () => {
    const qs = centralTypedQueries(ctxFor(BEAT_3));
    expect(qs[0]).toBe("Reichstag 1945");
    expect(qs).toContain("Reichstag flag 1945");
    expect(qs).toContain("Reichstag raised 1945");
  });

  it("BEAT 4 — the person leads and the action follows", () => {
    const qs = centralTypedQueries(ctxFor(BEAT_4));
    expect(qs[0]).toBe("Churchill France");
    expect(qs).toContain("Churchill France addressed");
  });

  it("NEGATIVE — no query repeats a word, and none is empty or malformed", () => {
    for (const beat of [...ALL, "The war changed everything.", ""]) {
      for (const q of centralTypedQueries(ctxFor(beat))) {
        // "fall of France" beside place "France" would read "France fall of France".
        const words = q.toLowerCase().split(/\s+/).filter((w) => !["of", "the", "and"].includes(w));
        expect(new Set(words).size, `"${q}" repeats a word`).toBe(words.length);
        expect(q).not.toContain("undefined");
        expect(q).not.toContain("null");
        expect(q).not.toMatch(/\s{2,}/);
        expect(q).toBe(q.trim());
        expect(q.length).toBeGreaterThan(0);
      }
    }
  });

  it("a missing field drops out rather than leaving a slot", () => {
    const bare: TypedRetrievalContext = {
      person: "", place: "Berlin", time: "", year: "", event: "", action: "", object: "",
    };
    expect(centralTypedQueries(bare)).toEqual(["Berlin archival footage"]);
    const empty: TypedRetrievalContext = {
      person: "", place: "", time: "", year: "", event: "", action: "", object: "",
    };
    expect(centralTypedQueries(empty)).toEqual([]);
  });
});

/* ═════════════ §C — the beat's person wins ═════════════ */

describe("RONDE 78 §C — beat person before scene person", () => {
  it("a beat that names Churchill is not asked about Hitler first", () => {
    for (const qs of [
      typedQueryPrefix(BEAT_4, { scenePersons: ["Adolf Hitler"] }),
      typedQueryPrefix(BEAT_4, { forcePerson: "Adolf Hitler" }),
      buildPersonCelebrityVideoQueries("Adolf Hitler", BEAT_4, 0),
      buildBeatVisualQueryList(BEAT_4, SCENE, TITLE, ["Adolf Hitler"], 4),
    ]) {
      expect(qs[0]).toBe("Churchill France");
      expect(qs[0]).not.toContain("Adolf Hitler");
    }
  });

  it("RONDE 88 — a SCENE person needs the scene text; an explicitly requested person does not", () => {
    /**
     * RONDE 88 §7/§11 splits what this test used to treat as one thing.
     *
     * scenePersons is assembled from the scene AND from the video's TITLE, so on a beat that
     * names nobody it is an inference about the sentence. The RONDE 87 audit measured the cost:
     * a beat reading "She addressed the nation after the fall of France" was searched as
     * "Adolf Hitler France" — and, from a title, as "Eva Braun Just France".
     *
     * An explicit person-targeted fetch is a different claim: buildPersonCelebrityVideoQueries
     * is fetching footage OF that person, which is the caller's own established context. That
     * half is unchanged, and is asserted below.
     */
    const bare = typedQueryPrefix(BEAT_4, { scenePersons: ["Adolf Hitler"] });
    expect(bare.join(" | ")).not.toContain("Adolf Hitler");
    // With the scene text stating the connection, the scene's person is proven and comes back.
    const proven = typedQueryPrefix(BEAT_4, {
      scenePersons: ["Adolf Hitler"],
      sceneText: "Adolf Hitler had already retreated to the bunker.",
    });
    expect(proven).toContain("Adolf Hitler France");
    // The explicit celebrity fetch never needed the scene text.
    expect(buildPersonCelebrityVideoQueries("Adolf Hitler", BEAT_4, 0)).toContain("Adolf Hitler France");
  });

  it("a beat that names nobody still uses an explicitly requested person", () => {
    // The pronoun case the fallback exists for. From the scene list it is an inference and is
    // refused; from an explicit fetch for that person it is proven, and now LEADS (§1).
    expect(typedQueryPrefix(BEAT_3, { scenePersons: ["Adolf Hitler"] }).join(" | "))
      .not.toContain("Adolf Hitler");
    const qs = buildPersonCelebrityVideoQueries("Adolf Hitler", BEAT_3, 0);
    expect(qs[0]).toBe("Adolf Hitler Reichstag");
    // RONDE 88: buildPersonCelebrityVideoQueries takes only the FIRST TWO typed queries
    // (videoPipeline.ts, `.slice(0, 2)`) and fills the rest with its own person variants, so a
    // third typed query cannot appear in this list by construction. The place+year question is
    // still asked — on the typed prefix itself, which is where the contract lives.
    expect(typedQueryPrefix(BEAT_3, { forcePerson: "Adolf Hitler" })).toContain("Reichstag 1945");
  });

  it("beat person and supplied person agreeing produces no duplicate", () => {
    const qs = typedQueryPrefix(BEAT_1, { scenePersons: ["Adolf Hitler"] });
    expect(new Set(qs).size).toBe(qs.length);
        // RONDE 88 §4: the bare name+place leads and the year-qualified form follows at position 2
    // (that brief states it with a worked example: "Hitler Poland", then "Hitler Poland 1939").
    // The typed combination still leads and still carries the year.
    expect(qs[0]).toBe("Adolf Hitler Fuhrerbunker");
    expect(qs[1]).toBe("Adolf Hitler Fuhrerbunker 1945");
  });
});

/* ═════════════ §D — end to end, to the provider ═════════════ */

describe("RONDE 78 §D — the context reaches the provider query, not just the extractor", () => {
  const expectations: Array<[string, string, string[]]> = [
    [BEAT_1, "Adolf Hitler Fuhrerbunker",
      ["Adolf Hitler", "Fuhrerbunker", "1945", "political testament"]],
    [BEAT_2, "Brandenburg Gate Battle of Berlin", ["Brandenburg Gate", "Battle of Berlin"]],
    [BEAT_3, "Reichstag 1945", ["Reichstag", "flag", "1945"]],
    [BEAT_4, "Churchill France", ["Churchill", "France"]],
  ];

  for (const [beat, first, mustAppear] of expectations) {
    it(`INTERNET ARCHIVE — "${beat.slice(0, 38)}…"`, () => {
      const qs = iaQueries(beat);
      expect(qs[0]).toBe(first);
      const joined = qs.join(" | ");
      for (const term of mustAppear) expect(joined, `"${term}" never reached IA`).toContain(term);
    });

    it(`WIKIMEDIA — "${beat.slice(0, 38)}…"`, () => {
      const qs = wikiQueries(beat);
      expect(qs[0]).toBe(first);
      const joined = qs.join(" | ");
      for (const term of mustAppear) expect(joined).toContain(term);
    });

    it(`BEAT VISUAL QUERY LIST (Pexels/Pixabay/stock) — "${beat.slice(0, 30)}…"`, () => {
      expect(buildBeatVisualQueryList(beat, SCENE, TITLE, [], 2)[0]).toBe(first);
    });
  }

  it("§7 — the Internet Archive narration query is still a fallback, still uncut", () => {
    const qs = buildInternetArchiveGeoQueries(BEAT_1, TITLE, 0);
    // The 55-character cut used to produce "Adolf Hitler dictated his final political testament
    // in " at positions 1 and 2, losing the place and the date.
    expect(qs[0]).not.toMatch(/^Adolf Hitler dictated/);
    expect(qs[1]).not.toMatch(/^Adolf Hitler dictated/);
    const narrative = qs.find((q) => q.startsWith("Adolf Hitler dictated"));
    if (narrative) {
      expect(narrative, "the narration query lost the place again").toContain("Fuhrerbunker");
      expect(narrative).toContain("April 1945");
      expect(narrative).not.toMatch(/\bin\s+(?:documentary|footage)$/);
    }
    for (const q of qs) expect(q).not.toMatch(/\s{2,}/);
  });

  it("§7 — and the typed queries lead the Internet Archive list on all four beats", () => {
    for (const beat of ALL) {
      const typed = archivalQueries(beat).slice(0, 3);
      const qs = iaQueries(beat);
      expect(qs.slice(0, typed.length), `"${beat.slice(0, 28)}"`).toEqual(typed);
    }
  });

  it("YOUTUBE — the typed query reaches the youtube list too", () => {
    // buildBeatYoutubeQueries is not exported; it composes the celebrity builder, which is.
    for (const [beat, first] of [[BEAT_1, "Adolf Hitler Fuhrerbunker"], [BEAT_4, "Churchill France"]] as Array<[string, string]>) {
      expect(buildPersonCelebrityVideoQueries("Adolf Hitler", beat, 0)[0]).toBe(first);
    }
  });
});

/* ═════════════ §E — nothing was taken away ═════════════ */

describe("RONDE 78 §E — the existing fallbacks all still reach the provider", () => {
  it("INTERNET ARCHIVE — every geo/narration query the path had is still in the list", () => {
    for (const beat of ALL) {
      const before = buildInternetArchiveGeoQueries(beat, TITLE, 0);
      const after = iaQueries(beat);
      const kept = before.filter((q) => after.includes(q));
      expect(kept.length, `only ${kept.length}/${before.length} survived for "${beat.slice(0, 26)}"`)
        .toBeGreaterThanOrEqual(Math.min(before.length, 8) - 3);
      expect(after.length).toBeGreaterThan(3);
    }
  });

  it("the geo-stock phrase is still asked — one place down, never removed", () => {
    const stillThere: Array<[string, string]> = [
      [BEAT_1, "hitler bunker"],
      [BEAT_2, "berlin city skyline"],
      [BEAT_3, "russia aerial video"],
      [BEAT_4, "france aerial video"],
    ];
    for (const [beat, phrase] of stillThere) {
      const qs = buildBeatVisualQueryList(beat, SCENE, TITLE, [], 2);
      expect(qs, `"${phrase}" was dropped`).toContain(phrase);
      expect(qs[0]).not.toBe(phrase);
    }
  });

  it("RONDE 93 — the celebrity rotation survives; its invented media queries do not", () => {
    // The rotation is what stops consecutive beats about one person fetching the same clip, and
    // it is untouched. What it rotates through no longer includes four suffixes appended to every
    // person on earth — see ronde93SearchProvenanceCoverage for why.
    for (const beat of ALL) {
      const qs = buildPersonCelebrityVideoQueries("Adolf Hitler", beat, 0);
      expect(qs.length, `nothing built for "${beat.slice(0, 26)}"`).toBeGreaterThan(0);
      for (const invented of ["red carpet", "talk show", "makeup brand", "celebrity news"]) {
        expect(qs.join(" | "), `"${invented}" invented`).not.toContain(invented);
      }
      expect(new Set(qs).size).toBe(qs.length);
    }
  });
});

/* ═════════════ §F — ranking is untouched ═════════════ */

describe("RONDE 78 §F — no ranking input changed", () => {
  it("extractLocationPhrase and extractEventCue answer exactly as before", () => {
    expect(extractLocationPhrase("…testament in the Fuhrerbunker in April 1945.")).toBe("April");
    expect(extractLocationPhrase(BEAT_2)).toBeNull();
    expect(extractLocationPhrase(BEAT_4)).toBeNull();
    expect(extractEventCue(BEAT_1)).toBeNull();
    expect(extractEventCue(BEAT_2)).toBe("battle");
    expect(extractEventCue(BEAT_3)).toBeNull();
  });

  it("the new extractors are not wired into any ranking classifier", () => {
    // classifyBeatFocus reads extractEventCue/extractLocationPhrase/extractObjectCue and must
    // keep reading exactly those. Proven behaviourally by the assertions above; this pins that
    // the wider answers did not quietly replace them.
    expect(extractEventPhraseForQuery(BEAT_2, "stood")).not.toBe(extractEventCue(BEAT_2));
    expect(extractPeriodPhrase(BEAT_1)).not.toBe(extractLocationPhrase(BEAT_1));
  });
});
