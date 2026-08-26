import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildBeatVisualQueryList,
  buildPersonCelebrityVideoQueries,
  extractActionCue,
  extractVisualPlacePhrase,
  typedQueryPrefix,
} from "./videoPipeline";
import {
  buildHistoricalArchivalQueries,
  buildMediaSearchIntent,
  combinedTypedQueriesForBeat,
  extractLocationPhrase,
} from "./mediaResearchEngine";
import { buildGeoStockSearchQueries } from "./curatedMediaSourcing";
import { beatVisualSearchSubjects } from "./scriptVisualKeywords";
import { extractPersonNamesFromText, scriptStockSearchQueries } from "./videoPipeline";
import type { Scene } from "@shared/schema";

/**
 * RONDE 77 — the typed context, from the central levers outward.
 *
 * The RONDE 76 audit counted it: 102 leaf provider call sites, 34 of them typed. The other 68
 * were not reached because the four RONDE 73 call sites and the two RONDE 75 ones each hold a
 * SceneBeat, a Scene and the dedup state, and the builders underneath them hold a string. So the
 * same beat asked two different questions depending on which path happened to run:
 *
 *     "Soviet soldiers raised their flag over the Reichstag in April 1945."
 *        typed path      -> "Reichstag 1945"
 *        buildBeatVisualQueryList -> "russia aerial video"
 *
 * This round adds `action` to the typed representation and puts the combination in front of the
 * two builders the audit named as the widest: buildBeatVisualQueryList (7 callers) and
 * buildPersonCelebrityVideoQueries (12). Nothing is removed from either list — both caps grow by
 * exactly what was prepended, and §G and §I measure that rather than trusting it.
 *
 * Every test runs the real functions on real narration.
 */

const TITLE = "The final days of Hitler in the Fuhrerbunker — April 1945";

const BEAT_1 = "Adolf Hitler dictated his final political testament in the Fuhrerbunker in April 1945.";
const BEAT_2 = "The Brandenburg Gate stood in ruins after the Battle of Berlin.";
const BEAT_3 = "Soviet soldiers raised their flag over the Reichstag in April 1945.";
const BEAT_4 = "Churchill addressed the nation after the fall of France.";
const PRONOUN_BEAT = "He then gave the order to hold the line.";

/** buildBeatVisualQueryList reads no field of the scene; it is threaded through for its callers. */
const SCENE = { text: "", beats: [] } as unknown as Scene;

const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

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

/** The body of a top-level function in videoPipeline.ts, for the structural tests only. */
function bodyOf(signature: string): string {
  const start = SRC.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const end = SRC.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

/* ═════════════ §A — the action exists ═════════════ */

describe("RONDE 77 §A — extractActionCue answers for the beats that had no verb at all", () => {
  const cases: Array<[string, string]> = [
    [BEAT_1, "dictated"],
    [BEAT_2, "stood"],
    [BEAT_3, "raised"],
    [BEAT_4, "addressed"],
  ];

  for (const [beat, verb] of cases) {
    it(`"${beat.slice(0, 40)}…" -> ${verb}`, () => {
      expect(extractActionCue(beat)).toBe(verb);
    });
  }

  it("RAISED is the case the whole round turns on", () => {
    // "raised" is in NARRATION_VERB_WORDS, which is exactly why it used to come back empty:
    // extractActionCue excluded the whole NON_VISUAL_QUERY_WORDS union, and that union is where
    // the verbs live. A verb is a bad thing to photograph and a good thing to say something is
    // doing, and the split exists to hold both statements at once.
    expect(extractActionCue(BEAT_3)).toBe("raised");
  });
});

describe("RONDE 77 §B — generic morphology, not a second hardcoded list", () => {
  it("recognises verbs nobody listed anywhere", () => {
    // If this were a list, these would fail. They are not in PERSON_ACTION_VERBS, not in
    // EVENT_CUE_RE and not in the RONDE 71 vocabulary.
    expect(extractActionCue("The engineers catapulted the aircraft from the carrier deck."))
      .toBe("catapulted");
    expect(extractActionCue("Crowds thronged the square as the parade passed.")).toBe("thronged");
    expect(extractActionCue("The barricades were reinforced overnight.")).toBe("reinforced");
  });

  it("PERSON_ACTION_VERBS is reused, not rewritten", () => {
    // RONDE 72 built it as person evidence and entityMatchTierScore depends on that meaning.
    // This round reads it and adds nothing to it.
    const body = bodyOf("export function extractActionCue(");
    expect(body).toContain("PERSON_ACTION_VERBS.has(lower)");
    expect(SRC).not.toContain("PERSON_ACTION_VERBS.add(");
    // And the verb group it also reads is the union's member, not a copy of it.
    expect(SRC).toContain("...NARRATION_VERB_WORDS,");
  });
});

describe("RONDE 77 §C — what is not an action", () => {
  it("copulas and auxiliaries are never actions", () => {
    for (const beat of [
      "The city was quiet.",
      "It had been eight metres deep.",
      "There were three of them.",
      "Berlin was under constant bombardment in April 1945.",
    ]) {
      expect(extractActionCue(beat), `"${beat}"`).toBe("");
    }
  });

  it("time, quantity and abstraction words stay excluded", () => {
    // These are the groups NON_ACTION_QUERY_WORDS keeps, and they must keep being kept.
    for (const beat of [
      "Later, in the last week, and once again the next morning.",
      "Several hundred metres beyond them.",
      "The psychological effect on the city was already almost constant.",
    ]) {
      expect(extractActionCue(beat), `"${beat}"`).toBe("");
    }
  });

  it("a capitalised word mid-sentence is a name, not a verb", () => {
    expect(extractActionCue("The United States entered the war.")).toBe("entered");
    expect(extractActionCue("The United States and the United Kingdom.")).toBe("");
  });

  it("empty and junk input is safe", () => {
    expect(extractActionCue("")).toBe("");
    expect(extractActionCue("   ")).toBe("");
    expect(extractActionCue("[visual: a bunker corridor]")).toBe("");
    expect(() => extractActionCue("... !!! ???")).not.toThrow();
  });
});

/* ═════════════ §D/§E — the action reaches the combination ═════════════ */

describe("RONDE 77 §D — action becomes a query, after the entities and never before them", () => {
  it("BEAT 3 — place + action + time exists as one query", () => {
    const qs = typedQueryPrefix(BEAT_3);
    expect(qs).toContain("Reichstag raised 1945");
    // But it does not lead: a verb narrows a search, it does not anchor one.
    expect(qs[0]).toBe("Reichstag 1945");
    expect(qs.indexOf("Reichstag raised 1945")).toBeGreaterThan(0);
  });

  it("BEAT 1 — person + place + action exists, behind person + place + time", () => {
    const qs = typedQueryPrefix(BEAT_1);
    // RONDE 88 §4: the bare name+place now leads and the year-qualified form follows at
    // position 2. That brief states the ordering with a worked example ("Hitler Poland",
    // then "Hitler Poland 1939"). What RONDE 73/77 established — the typed combination
    // leads and carries the year — still holds across the first two queries.
    expect(qs[0]).toBe("Adolf Hitler Fuhrerbunker");
    expect(qs[1]).toBe("Adolf Hitler Fuhrerbunker 1945");
    expect(qs).toContain("Adolf Hitler Fuhrerbunker dictated");
    expect(qs).toContain("Adolf Hitler dictated 1945");
  });

  it("BEAT 4 — person + place + action, with no year in the beat", () => {
    const qs = typedQueryPrefix(BEAT_4);
    expect(qs[0]).toBe("Churchill France");
    expect(qs).toContain("Churchill France addressed");
    // No year in the narration, so no year in any query — not a blank slot and not the title's.
    expect(qs.join(" | ")).not.toMatch(/\b(?:18|19|20)\d{2}\b/);
  });

  it("the RONDE 73/75 provider paths get the action too, not only the new prefix", () => {
    // typedRetrievalQueriesForBeat and the five other buildHistoricalArchivalQueries call sites
    // pass { place, action }. Drop the action out of that opts object and the six paths RONDE 73
    // and RONDE 75 wired go back to asking without a verb while the new prefix still has one.
    expect(archivalQueries(BEAT_3)).toContain("Reichstag raised 1945");
    expect(archivalQueries(BEAT_1)).toContain("Adolf Hitler Fuhrerbunker dictated");
    expect(archivalQueries(BEAT_4)).toContain("Churchill France addressed");
    // And the entity combination still leads on that path, exactly as RONDE 73 measured it.
    expect(archivalQueries(BEAT_1).slice(0, 2))
      .toEqual(["Adolf Hitler Fuhrerbunker", "Adolf Hitler Fuhrerbunker 1945"]);
    expect(archivalQueries(BEAT_3)[0]).toBe("Reichstag 1945");
  });

  it("EVERY buildHistoricalArchivalQueries call site passes the action", () => {
    // The call sites live inside adopt* functions that need a SceneBeat, a Scene and the dedup
    // state, so they cannot be driven from a test — but a call site that quietly stops passing
    // { action } is exactly the regression this round exists to prevent, and it is countable.
    const calls = [...SRC.matchAll(/buildHistoricalArchivalQueries\(intent, beat\.text, \{/g)];
    expect(calls.length, "call sites found").toBeGreaterThanOrEqual(5);
    for (const m of calls) {
      const opts = SRC.slice(m.index!, SRC.indexOf("}", m.index! + m[0].length));
      expect(opts, `call site at ${m.index} passes no action`)
        .toContain("action: extractActionCue(beat.text)");
      expect(opts).toContain("place: extractVisualPlacePhrase(beat.text)");
    }
  });

  it("a beat with no action gets no action query on the provider path either", () => {
    const beat = "Berlin was under constant bombardment in April 1945.";
    expect(extractActionCue(beat)).toBe("");
    for (const q of archivalQueries(beat)) {
      expect(q).not.toMatch(/\s{2,}/);
      expect(q).toBe(q.trim());
    }
  });

  it("the action only appears where an entity anchors it", () => {
    // A verb on its own is not a query. Every action query carries a person or a place.
    for (const beat of [BEAT_1, BEAT_2, BEAT_3, BEAT_4]) {
      const action = extractActionCue(beat);
      expect(action).not.toBe("");
      for (const q of typedQueryPrefix(beat).filter((x) => x.includes(action))) {
        expect(q, `"${q}" is a bare verb`).not.toBe(action);
        expect(q.split(/\s+/).length).toBeGreaterThan(1);
      }
    }
  });
});

describe("RONDE 77 §E — a missing action leaves no gap", () => {
  it("a beat with no action produces no action query and no empty slot", () => {
    const beat = "Berlin was under constant bombardment in April 1945.";
    expect(extractActionCue(beat)).toBe("");
    const qs = typedQueryPrefix(beat);
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      expect(q).not.toMatch(/\s{2,}/);
      expect(q).toBe(q.trim());
      expect(q).not.toContain("undefined");
    }
  });

  it("no query anywhere carries undefined, null or stray whitespace", () => {
    const beats = [BEAT_1, BEAT_2, BEAT_3, BEAT_4, PRONOUN_BEAT, "The war changed everything.", ""];
    for (const beat of beats) {
      const lists = [
        typedQueryPrefix(beat),
        typedQueryPrefix(beat, { scenePersons: ["Adolf Hitler"] }),
        typedQueryPrefix(beat, { forcePerson: "Adolf Hitler" }),
        buildBeatVisualQueryList(beat, SCENE, TITLE, ["Adolf Hitler"], 4),
        buildPersonCelebrityVideoQueries("Adolf Hitler", beat, 0),
      ];
      for (const qs of lists) {
        for (const q of qs) {
          expect(q, `"${q}" from "${beat}"`).not.toContain("undefined");
          expect(q).not.toContain("null");
          expect(q).not.toMatch(/\s{2,}/);
          expect(q).toBe(q.trim());
          expect(q.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("empty beat text produces nothing at all, on every entry point", () => {
    expect(typedQueryPrefix("")).toEqual([]);
    expect(typedQueryPrefix("   ")).toEqual([]);
    expect(typedQueryPrefix("", { forcePerson: "Adolf Hitler" })).toEqual([]);
    expect(typedQueryPrefix("", { scenePersons: ["Adolf Hitler"] })).toEqual([]);
  });
});

/* ═════════════ §F/§G — the first central lever ═════════════ */

describe("RONDE 77 §F — buildBeatVisualQueryList asks the typed question first", () => {
  const cases: Array<[string, string]> = [
    [BEAT_1, "Adolf Hitler Fuhrerbunker"],
    [BEAT_2, "Brandenburg Gate Battle of Berlin"],
    [BEAT_3, "Reichstag 1945"],
    [BEAT_4, "Churchill France"],
  ];

  for (const [beat, first] of cases) {
    it(`"${beat.slice(0, 38)}…" leads with "${first}"`, () => {
      expect(buildBeatVisualQueryList(beat, SCENE, TITLE, [], 2)[0]).toBe(first);
      expect(buildBeatVisualQueryList(beat, SCENE, TITLE, ["Adolf Hitler"], 4)[0]).toBe(first);
    });
  }

  it("the geo-stock phrase is no longer the primary query on this path", () => {
    const banned: Array<[string, string]> = [
      [BEAT_1, "hitler bunker"],
      [BEAT_2, "berlin city skyline"],
      [BEAT_3, "russia aerial video"],
      [BEAT_4, "france aerial video"],
    ];
    for (const [beat, phrase] of banned) {
      const qs = buildBeatVisualQueryList(beat, SCENE, TITLE, [], 2);
      expect(qs[0], `"${beat.slice(0, 30)}"`).not.toBe(phrase);
      expect(qs).toContain(phrase); // still asked, one place down
    }
  });

  it("the scene's person is context, and the beat's own answer outranks it", () => {
    // BEAT_3 is about Soviet soldiers. The scene's protagonist is Hitler, and before this round
    // his bare name was query #1 for this beat. Both angles now go, in the honest order.
    // RONDE 88 §7/§11 REVERSES the second half of this. scenePersons is assembled from the scene
    // AND from the video's title, so on a beat that names nobody it is an inference — and this
    // beat is about Soviet soldiers, not about Hitler. The scene's person no longer enters the
    // beat's typed queries without the scene text proving the connection. The first assertion,
    // which is what this test is really about, is unchanged.
    const qs = buildBeatVisualQueryList(BEAT_3, SCENE, TITLE, ["Adolf Hitler"], 4);
    expect(qs[0]).toBe("Reichstag 1945");
    expect(qs.slice(0, 3).join(" | ")).not.toContain("Adolf Hitler Reichstag");
  });

  it("a beat with nothing typed to say adds nothing — the list is untouched", () => {
    const beat = "The war changed everything.";
    expect(typedQueryPrefix(beat)).toEqual([]);
    const qs = buildBeatVisualQueryList(beat, SCENE, TITLE, [], 2);
    expect(qs.length).toBe(2);
    expect(qs).toEqual(["war changed", "war historical"]);
  });
});

describe("RONDE 77 §G — added to the list, never swapped into it", () => {
  const beats = [BEAT_1, BEAT_2, BEAT_3, BEAT_4];

  it("the number of non-typed queries is exactly what the cap always allowed", () => {
    // This is the mutation guard on the cap. Drop the `+ typedKept` growth and the typed entries
    // start evicting the geo and person queries from the tail, and this count falls below what
    // the cap allows. The supply is measured at a cap that cannot bind, so a beat that simply
    // has fewer queries to give is not read as an eviction.
    for (const beat of beats) {
      for (const [persons, max] of [[[], 2], [["Adolf Hitler"], 4]] as Array<[string[], number]>) {
        const typed = typedQueryPrefix(beat, { scenePersons: persons }).slice(0, 2);
        const supply = buildBeatVisualQueryList(beat, SCENE, TITLE, persons, 99)
          .filter((q) => !typed.includes(q)).length;
        const qs = buildBeatVisualQueryList(beat, SCENE, TITLE, persons, max);
        const nonTyped = qs.filter((q) => !typed.includes(q));
        expect(nonTyped.length, `"${beat.slice(0, 28)}" max=${max}`)
          .toBe(Math.min(Math.max(2, max), supply));
      }
    }
  });

  it("the scene person and the geo builder both still reach the provider", () => {
    for (const beat of beats) {
      const qs = buildBeatVisualQueryList(beat, SCENE, TITLE, ["Adolf Hitler"], 4);
      expect(qs, `person dropped for "${beat.slice(0, 28)}"`).toContain("Adolf Hitler");
      const geo = buildGeoStockSearchQueries(beat, TITLE).slice(0, 2);
      expect(geo.length).toBeGreaterThan(0);
      expect(geo.some((g) => qs.includes(g)), `no geo query survived for "${beat.slice(0, 28)}"`)
        .toBe(true);
    }
  });

  it("the list still has no duplicates and still honours its minimum of two", () => {
    for (const beat of [...beats, PRONOUN_BEAT, "The war changed everything."]) {
      const qs = buildBeatVisualQueryList(beat, SCENE, TITLE, ["Adolf Hitler"], 1);
      expect(new Set(qs).size).toBe(qs.length);
      expect(qs.length).toBeGreaterThanOrEqual(2);
    }
  });
});

/* ═════════════ §H/§I — the second central lever ═════════════ */

describe("RONDE 77 §H — buildPersonCelebrityVideoQueries leads with the typed combination", () => {
  it("the typed combination leads", () => {
    // BEAT_1 names the same person the caller asked for, so both answers agree.
    expect(buildPersonCelebrityVideoQueries("Adolf Hitler", BEAT_1, 0).slice(0, 2))
      .toEqual(["Adolf Hitler Fuhrerbunker", "Adolf Hitler Fuhrerbunker 1945"]);
    // BEAT_3 names nobody, so the caller's person is the only one there is.
    // RONDE 88 §1: a PROVEN person leads. BEAT_3 names nobody, and an explicit celebrity fetch
    // for Adolf Hitler is proven context about that person, so his name now leads this beat's
    // list rather than following the place. Both angles are still asked.
    const b3 = buildPersonCelebrityVideoQueries("Adolf Hitler", BEAT_3, 0);
    expect(b3[0]).toBe("Adolf Hitler Reichstag");
    // RONDE 88: buildPersonCelebrityVideoQueries takes only the FIRST TWO typed queries
    // (videoPipeline.ts, `.slice(0, 2)`) and fills the rest with its own person variants, so a
    // third typed query cannot appear in this list by construction. The place+year question is
    // still asked — on the typed prefix itself, which is where the contract lives.
    expect(typedQueryPrefix(BEAT_3, { forcePerson: "Adolf Hitler" })).toContain("Reichstag 1945");
  });

  it("RONDE 78 — the person the BEAT names is not displaced by the person requested", () => {
    // RONDE 77 had this the other way round: the caller's name replaced the beat's, so a fetch
    // for Hitler on a Churchill beat asked "Adolf Hitler France" first. A beat that names
    // Churchill is about Churchill; the requested name follows at position 2 rather than leading.
    const qs = buildPersonCelebrityVideoQueries("Adolf Hitler", BEAT_4, 0);
    expect(qs[0]).toBe("Churchill France");
    expect(qs[1]).toBe("Adolf Hitler France");
  });

  it("the beat's place and year reach the celebrity provider", () => {
    const qs = buildPersonCelebrityVideoQueries("Adolf Hitler", BEAT_1, 0).join(" | ");
    expect(qs).toContain("Fuhrerbunker");
    expect(qs).toContain("1945");
  });

  it("a beat with no place adds no typed query — the rotation is untouched", () => {
    expect(extractVisualPlacePhrase(PRONOUN_BEAT)).toBe("");
    const qs = buildPersonCelebrityVideoQueries("Adolf Hitler", PRONOUN_BEAT, 0);
    // RONDE 93: five, not seven. buildPersonMediaQueries used to append "interview", "speech",
    // "news conference" and "red carpet" to every person unconditionally, and those four are the
    // reason "Adolf Hitler red carpet" was measured going out to a provider. The rotation itself
    // is untouched — what shrank is the number of guesses it rotates through.
    expect(qs.length).toBe(5);
    expect(qs[0]).toBe("Adolf Hitler gave");
  });
});

describe("RONDE 77 §I — the rotation and the existing query set survive", () => {
  it("RONDE 93 — the builder no longer invents a media event for every person", () => {
    /**
     * This test used to require the opposite: that "Adolf Hitler interview" and "Adolf Hitler
     * speech" appear for EVERY beat, whatever it said. That requirement is the defect — a real
     * render produced "Adolf Hitler red carpet", "Adolf Hitler talk show", "Adolf Hitler makeup
     * brand" and "Adolf celebrity news" from these same constants, none of which any script had
     * asked for.
     *
     * The terms are not gone; they are earned. scriptEventSearchQueries emits "interview" for a
     * beat that mentions one, and nothing for a beat that does not.
     */
    for (const beat of [BEAT_1, BEAT_2, BEAT_3, BEAT_4]) {
      const qs = buildPersonCelebrityVideoQueries("Adolf Hitler", beat, 0);
      const typed = typedQueryPrefix(beat, { forcePerson: "Adolf Hitler" }).slice(0, 2);
      const nonTyped = qs.filter((q) => !typed.includes(q));
      expect(nonTyped.length, `"${beat.slice(0, 28)}"`).toBeGreaterThan(0);
      for (const invented of ["red carpet", "talk show", "makeup brand", "celebrity news"]) {
        expect(qs.join(" | "), `"${invented}" invented for "${beat.slice(0, 28)}"`).not.toContain(invented);
      }
      // Every remaining query is drawn from the beat or the caller's own person — never from a
      // constant. (A beat that names a second person legitimately yields a query about them.)
      const evidence = `${beat} Adolf Hitler`.toLowerCase();
      for (const q of qs) {
        for (const word of q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3)) {
          expect(evidence, `"${word}" in "${q}" is not in the beat`).toContain(word.slice(0, 5));
        }
      }
    }
  });

  it("consecutive beats still get different search angles", () => {
    const typed = typedQueryPrefix(BEAT_1, { forcePerson: "Adolf Hitler" }).slice(0, 2);
    const at = (i: number) =>
      buildPersonCelebrityVideoQueries("Adolf Hitler", BEAT_1, i).filter((q) => !typed.includes(q));
    expect(at(0)).not.toEqual(at(3));
    // RONDE 93: the rotation still gives consecutive beats a different leading angle. With four
    // invented suffixes removed the pool it rotates through is smaller, so two offsets can now
    // cover the same set — the order differing is what stops two beats fetching one clip.
    expect(at(0)[0]).not.toBe(at(3)[0]);
  });

  it("the result never contains a duplicate", () => {
    for (const beat of [BEAT_1, BEAT_2, BEAT_3, BEAT_4, PRONOUN_BEAT]) {
      for (const i of [0, 1, 2, 5]) {
        const qs = buildPersonCelebrityVideoQueries("Adolf Hitler", beat, i);
        expect(new Set(qs).size, `"${beat.slice(0, 24)}" idx=${i}`).toBe(qs.length);
      }
    }
  });
});

/* ═════════════ §J — the recursion the round had to avoid ═════════════ */

describe("RONDE 77 §J — the central lever cannot re-enter its own caller", () => {
  it("typedQueryPrefix calls extractors only, never a query builder", () => {
    const body = bodyOf("export function typedQueryPrefix(");
    for (const forbidden of [
      "buildBeatVisualQueryList(",
      "buildPersonCelebrityVideoQueries(",
      "beatMediaSearchQueries(",
      "buildHistoricalArchivalQueries(",
      "typedRetrievalQueriesForBeat(",
      "buildGeoStockSearchQueries(",
      "scriptStockSearchQueries(",
      "enrichStockQuery(",
      "resolveBeatScriptVisualAnchor(",
    ]) {
      expect(body, `typedQueryPrefix must not call ${forbidden}`).not.toContain(forbidden);
    }
    // RONDE 88: the combination step moved into searchQueryContract, which is dependency-free and
    // therefore cannot re-enter any query builder either — the property this test guards.
    expect(body).toContain("buildPrioritisedQueries(");
  });

  it("the two builders it was wired into terminate", () => {
    // A recursive edge would blow the stack rather than fail an assertion, so this is a real test.
    for (const beat of [BEAT_1, BEAT_2, BEAT_3, BEAT_4, PRONOUN_BEAT]) {
      expect(() => buildBeatVisualQueryList(beat, SCENE, TITLE, ["Adolf Hitler"], 4)).not.toThrow();
      expect(() => buildPersonCelebrityVideoQueries("Adolf Hitler", beat, 0)).not.toThrow();
    }
  });

  it("beatMediaSearchQueries stays untyped, because the typed path calls it", () => {
    // typedRetrievalQueriesForBeat -> buildMediaSearchIntent -> beatMediaSearchQueries. Wiring
    // the typed prefix into it would close the loop.
    const body = bodyOf("function beatMediaSearchQueries(");
    expect(body).not.toContain("typedQueryPrefix(");
  });
});

/* ═════════════ §K — ranking is not on this path ═════════════ */

describe("RONDE 77 §K — nothing here touches how a candidate is scored", () => {
  it("extractLocationPhrase still answers exactly as it did", () => {
    expect(extractLocationPhrase("…testament in the Fuhrerbunker in April 1945.")).toBe("April");
    expect(extractLocationPhrase(BEAT_2)).toBeNull();
    expect(extractLocationPhrase(BEAT_4)).toBeNull();
  });

  it("the two wired builders contain no ranking call", () => {
    for (const fn of [
      "export function buildBeatVisualQueryList(",
      "export function buildPersonCelebrityVideoQueries(",
      "export function typedQueryPrefix(",
      "export function extractActionCue(",
    ]) {
      const body = bodyOf(fn);
      for (const banned of [
        "entityMatchTierScore(",
        "historicalDateAlignmentScore(",
        "classifyBeatFocus(",
        "beatFocusPenalty(",
        "compareBeatCandidates(",
        "scoreCuratedAsset(",
      ]) {
        expect(body, `${fn} must not touch ${banned}`).not.toContain(banned);
      }
    }
  });

  it("the vocabulary split changed no subject, only made the verbs addressable", () => {
    // NON_VISUAL_QUERY_WORDS is what the subject extractor uses; the union is unchanged, and
    // NON_ACTION_QUERY_WORDS is the same set minus the verbs.
    expect(SRC).toContain("const NON_VISUAL_QUERY_WORDS = new Set([");
    expect(SRC).toContain("const NON_ACTION_QUERY_WORDS = new Set([");
    const nonAction = bodyOf("const NON_ACTION_QUERY_WORDS = new Set([");
    expect(nonAction).not.toContain("NARRATION_VERB_WORDS");
    for (const group of [
      "NARRATION_PRONOUN_WORDS",
      "TIME_QUANTITY_WORDS",
      "ABSTRACTION_WORDS",
      "NUMERAL_UNIT_WORDS",
    ]) {
      expect(nonAction).toContain(group);
    }
  });

  it("combinedTypedQueriesForBeat with no action returns what RONDE 73 returned", () => {
    // The action parameter defaults to "", and a defaulted action must add nothing at all.
    const withoutAction = combinedTypedQueriesForBeat(BEAT_3, [], "Reichstag");
    const withAction = combinedTypedQueriesForBeat(BEAT_3, [], "Reichstag", "raised");
    // RONDE 88 reordered this family and added the place+object+time form; the RONDE 73 members
    // are all still present, which is what this test exists to hold.
    for (const q of ["Reichstag 1945", "Reichstag flag 1945", "Reichstag archival footage"]) {
      expect(withoutAction).toContain(q);
    }
    for (const q of withoutAction) expect(withAction).toContain(q);
    expect(withAction.length).toBeGreaterThan(withoutAction.length);
  });
});
