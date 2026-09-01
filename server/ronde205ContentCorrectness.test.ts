/**
 * RONDE 205 — does the pipeline ask for the RIGHT PICTURE, on historically loaded beats?
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────────────────
 *
 * Content correctness is the largest unproven area in this project, and it is unproven for a
 * reason that will not go away on its own: judging whether a finished video shows the right person
 * in the right year needs a finished video, and this environment has no credentials to make one.
 *
 * But half the question can be settled WITHOUT a provider, and that half is where the damage
 * starts. A beat that asks the wrong question cannot get a right answer, so before any ranking or
 * any gate runs there is already a fact of the matter about whether the pipeline understood the
 * sentence. That is what these tests measure: intent, evidence, provenance and the ten questions
 * R205 asks, against the real extractors and the real search contract.
 *
 * ── What this file cannot do, stated plainly ─────────────────────────────────────────────────
 *
 * It does not prove that a returned clip SHOWS what it claims. That needs a provider response and
 * a human looking at frames. Nothing here should be read as evidence of that, and the round's
 * matrix records it as UNPROVEN.
 *
 * ── The examples ────────────────────────────────────────────────────────────────────────────
 *
 * Real documentary sentences, chosen so each carries a different trap: a person who must not be
 * inferred, a year that must not drift, a place whose modern name differs, an object that is not
 * the subject, and an organisation that is not a person.
 */
import { describe, expect, it } from "vitest";

import {
  buildPrioritisedQueries,
  checkPersonName,
  isProductionWord,
  provenPersonNames,
  validateSearchQuery,
  type VerifiedQueryContext,
} from "./searchQueryContract";
import {
  buildVerifiedQueryContextForBeat,
  beatNamedEntitiesByKind,
  extractActionCue,
  extractPersonNamesFromText,
  extractVisualPlacePhrase,
} from "./videoPipeline";
import { extractEventPhraseForQuery, extractObjectCue, extractPeriodPhrase } from "./mediaResearchEngine";
import { intentFrom } from "./cinematicPipelineInputs";

/* ═══════════════════════ the corpus ═══════════════════════ */

type Beat = {
  id: string;
  text: string;
  /** What a person reading the sentence would say the picture must show. */
  wants: { period?: string; person?: string; place?: string; event?: string; object?: string };
};

const CORPUS: readonly Beat[] = [
  {
    id: "event+year",
    text: "In April 1945 the Battle of Berlin reached the city centre.",
    wants: { period: "April 1945", place: "Berlin", event: "Battle of Berlin" },
  },
  {
    id: "person+event",
    text: "Dwight Eisenhower approved the landings in Normandy in 1944.",
    wants: { period: "1944", person: "Dwight Eisenhower", place: "Normandy" },
  },
  {
    id: "place+period",
    text: "By 1961 the city of Leningrad had rebuilt its shipyards.",
    wants: { period: "1961", place: "Leningrad" },
  },
  {
    id: "object+period",
    text: "The pistol was recovered from the bunker in 1945.",
    wants: { period: "1945", object: "pistol" },
  },
  {
    id: "organisation",
    text: "Tesla opened a factory outside Berlin in 2022.",
    wants: { period: "2022", place: "Berlin" },
  },
  {
    id: "no-entities",
    text: "The decision was harder than anyone had expected.",
    wants: {},
  },
];

const EXTRACTORS = {
  people: (t: string) => extractPersonNamesFromText(t),
  place: (t: string) => extractVisualPlacePhrase(t),
  action: (t: string) => extractActionCue(t),
  namedEntities: (t: string) => beatNamedEntitiesByKind(t),
};

const intentOf = (text: string) =>
  intentFrom(
    { index: 0, text, searchQuery: "", powerWord: "", keywords: [], holdSec: 4, visualDescription: "" },
    0, 0, null, EXTRACTORS
  );

const ctxOf = (b: Beat): VerifiedQueryContext =>
  buildVerifiedQueryContextForBeat(b.text, { scenePersons: [], sceneText: b.text });

/* ═══════════════════════ Q1 — is the right intent extracted? ═══════════════════════ */

describe("R205 Q1 — the intent matches what the sentence says", () => {
  for (const beat of CORPUS) {
    it(`${beat.id}: period`, () => {
      const got = intentOf(beat.text).visualTime;
      if (beat.wants.period) expect(got).toBe(beat.wants.period);
      /** No year in the sentence means no year in the intent — never a plausible one. */
      else expect(got).toBe("");
    });
  }

  it("event+year: the NAMED event, not the bare verb", () => {
    expect(intentOf(CORPUS[0]!.text).events[0]).toBe("Battle of Berlin");
  });

  it("object+period: the object is the object, and the year is not mistaken for one", () => {
    const intent = intentOf(CORPUS[3]!.text);
    expect(intent.objects).toContain("pistol");
    expect(intent.visualTime).toBe("1945");
  });

  /**
   * The trap in "The decision was harder than anyone had expected." Nothing concrete is named, so
   * every content field must stay empty. A pipeline that invents a subject here searches for
   * something the script never mentioned.
   */
  it("no-entities: a sentence naming nothing produces nothing", () => {
    const intent = intentOf(CORPUS[5]!.text);
    expect(intent.visualTime).toBe("");
    expect(intent.objects).toEqual([]);
    expect(intent.brands).toEqual([]);
    expect(intent.companies).toEqual([]);
    expect(intent.people).toEqual([]);
  });
});

/* ═══════════════════════ Q2/Q3 — the query terms, and their provenance ═══════════════════════ */

describe("R205 Q2/Q3 — every query term is proven by the beat", () => {
  /**
   * The contract's own rule, exercised on real sentences: a term reaches a provider PROVEN or it
   * does not reach one. This is the guarantee that makes every other content question tractable —
   * a query cannot ask for something the script never said.
   */
  for (const beat of CORPUS) {
    it(`${beat.id}: every prioritised query validates against the beat's own evidence`, () => {
      const ctx = ctxOf(beat);
      const queries = buildPrioritisedQueries(ctx);
      for (const q of queries) {
        const verdict = validateSearchQuery(q.query, ctx);
        expect(verdict.ok, `"${q.query}" — ${verdict.ok ? "" : verdict.reason}`).toBe(true);
      }
    });
  }

  it("a term the beat never said is refused", () => {
    const ctx = ctxOf(CORPUS[0]!);
    /** "tank" is plausible for a 1945 Berlin beat and is not in the sentence. */
    expect(validateSearchQuery("Berlin tank column", ctx).ok).toBe(false);
  });

  it("and the refusal names a reason rather than silently dropping the word", () => {
    const verdict = validateSearchQuery("Berlin tank column", ctxOf(CORPUS[0]!));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(String(verdict.reason).length).toBeGreaterThan(0);
  });
});

/* ═══════════════════════ Q4 — can a title introduce content? ═══════════════════════ */

describe("R205 Q4 — an LLM-written title cannot smuggle a term into a query", () => {
  /**
   * The specific attack this asks about. A video title is written by a model and is not evidence
   * about any BEAT: if a title could license a term, every beat in a video called "Hitler's Last
   * Days" could search for Hitler regardless of what the beat says.
   */
  it("a person named only in the title is not proven for a beat", () => {
    const beat = "The corridor was quiet that morning.";
    const ctx = buildVerifiedQueryContextForBeat(beat, { scenePersons: [], sceneText: beat });
    expect(validateSearchQuery("Adolf Hitler corridor", ctx).ok).toBe(false);
  });

  it("a beat that DOES name the person proves it", () => {
    const beat = "Dwight Eisenhower walked the corridor that morning.";
    expect(provenPersonNames(beat).join(" ")).toContain("Eisenhower");
  });

  /**
   * A scene-level person hint is a claim about the SCENE. It may only become a search term when
   * the beat's own text supports it — otherwise the hint is doing the LLM's smuggling for it.
   */
  it("a scene-level person hint does not license a term the beat never said", () => {
    const beat = "The corridor was quiet that morning.";
    const ctx = buildVerifiedQueryContextForBeat(beat, {
      scenePersons: ["Dwight Eisenhower"],
      sceneText: "Dwight Eisenhower arrived at headquarters. " + beat,
    });
    const queries = buildPrioritisedQueries(ctx).map((q) => q.query);
    for (const q of queries) expect(validateSearchQuery(q, ctx).ok).toBe(true);
  });
});

/* ═══════════════════════ Q5/Q6/Q7/Q8 — the exclusions ═══════════════════════ */

describe("R205 Q5–Q8 — wrong person, wrong year, wrong place, modern terms", () => {
  /** Q6 — a year the beat did not state cannot enter a query. */
  it("a year the beat never stated is refused", () => {
    const ctx = ctxOf(CORPUS[0]!);        // says April 1945
    expect(validateSearchQuery("Berlin 1943", ctx).ok).toBe(false);
    expect(validateSearchQuery("Berlin 1945", ctx).ok).toBe(true);
  });

  /** Q7 — and so is a place. */
  it("a place the beat never stated is refused", () => {
    const ctx = ctxOf(CORPUS[0]!);        // says Berlin
    expect(validateSearchQuery("Dresden ruins", ctx).ok).toBe(false);
  });

  /** Q6 — a person the beat never named is refused, whatever the event. */
  it("a person the beat never named is refused", () => {
    const ctx = ctxOf(CORPUS[0]!);
    expect(validateSearchQuery("Georgy Zhukov Berlin", ctx).ok).toBe(false);
  });

  /**
   * Q5 — the modern-mismatch question, at the level this file can answer. A generic modern
   * production word is not a beat's evidence, so it cannot be added to a historical query.
   */
  it("a modern production word is not licensed by a historical beat", () => {
    const ctx = ctxOf(CORPUS[0]!);
    expect(validateSearchQuery("Berlin 4k drone footage", ctx).ok).toBe(false);
  });

  /**
   * The counterpart, and the reason `PRODUCTION_VOCABULARY` exists: a technical word that describes
   * the KIND of footage is allowed, because it asks for a format rather than for content.
   */
  it("a technical footage word is allowed, because it names a format and not a subject", () => {
    expect(isProductionWord("archival")).toBe(true);
    expect(isProductionWord("footage")).toBe(true);
    /** But a subject word is not a format word, however common. */
    expect(isProductionWord("tank")).toBe(false);
  });

  /**
   * Q8 — the "same period is not the same picture" rule, stated as the check that enforces it: a
   * 1945 beat about Berlin must not license a 1945 query about somewhere else.
   */
  it("the right period does not license the wrong place", () => {
    const ctx = ctxOf(CORPUS[0]!);
    expect(validateSearchQuery("1945 Normandy landings", ctx).ok).toBe(false);
  });
});

/* ═══════════════════════ Q9 — is the object weighed at all? ═══════════════════════ */

describe("R205 Q9 — a named object reaches the query and the plan", () => {
  it("the object is in the intent the planners read", () => {
    expect(intentOf(CORPUS[3]!.text).objects).toContain("pistol");
  });

  it("and the beat's own object is a term a query may use", () => {
    const ctx = ctxOf(CORPUS[3]!);
    expect(validateSearchQuery("pistol 1945", ctx).ok).toBe(true);
  });

  /** An object the beat did not name is refused, even one from the same scene type. */
  it("an object the beat never named is refused", () => {
    expect(validateSearchQuery("rifle 1945", ctxOf(CORPUS[3]!)).ok).toBe(false);
  });
});

/* ═══════════════════════ Q10 — can one keyword dominate? ═══════════════════════ */

describe("R205 Q10 — one strong word cannot become the whole query", () => {
  /**
   * The failure this asks about: a beat mentioning a famous name or place produces a ladder of
   * queries that are all that one word, so every beat in the video searches for the same thing and
   * the montage repeats. The ladder must carry the beat's OTHER evidence too.
   */
  it("the ladder for a rich beat is not all one term", () => {
    const ctx = ctxOf(CORPUS[0]!);
    const queries = buildPrioritisedQueries(ctx).map((q) => q.query.toLowerCase());
    expect(queries.length).toBeGreaterThan(1);
    const distinct = new Set(queries);
    expect(distinct.size, `the ladder is ${queries.length} copies of the same idea`).toBeGreaterThan(1);
    /** And more than one of the beat's facts appears somewhere in the ladder. */
    const joined = queries.join(" | ");
    const facts = ["berlin", "1945"].filter((f) => joined.includes(f));
    expect(facts.length, `only ${facts.join(",")} reached the ladder`).toBeGreaterThanOrEqual(2);
  });

  it("two different beats of one scene do not produce identical ladders", () => {
    const a = buildPrioritisedQueries(ctxOf(CORPUS[0]!)).map((q) => q.query).join("|");
    const b = buildPrioritisedQueries(ctxOf(CORPUS[3]!)).map((q) => q.query).join("|");
    expect(a).not.toBe(b);
  });

  /**
   * A beat with nothing concrete must not fall back to the loudest word available. Its ladder is
   * allowed to be empty — an empty ladder is a beat that gets generic coverage, which is honest;
   * a ladder built from a word the beat never said is not.
   */
  it("a beat naming nothing does not borrow a term from anywhere", () => {
    const ctx = ctxOf(CORPUS[5]!);
    for (const q of buildPrioritisedQueries(ctx)) {
      expect(validateSearchQuery(q.query, ctx).ok, `"${q.query}" is unproven`).toBe(true);
    }
  });
});

/* ═══════════════════════ the person checker, on real names ═══════════════════════ */

describe("R205 — a person is a person, and a place is not", () => {
  it("accepts a real two-part name the beat states", () => {
    expect(checkPersonName("Dwight Eisenhower").ok).toBe(true);
  });

  /** The specific confusion that puts a city's face on a person beat. */
  it("does not accept a bare place as a person", () => {
    expect(provenPersonNames("The city of Berlin was quiet.")).not.toContain("Berlin");
  });

  it("does not accept a pronoun as a person", () => {
    expect(checkPersonName("He").ok).toBe(false);
    expect(checkPersonName("They").ok).toBe(false);
  });
});
