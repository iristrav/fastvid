import { describe, expect, it } from "vitest";
import {
  actionMatchScore,
  beatContextMatchScore,
  beatFocusPenalty,
  classifyBeatFocus,
  classifyEntityMatchTier,
  compareBeatCandidates,
  entityMatchTierScore,
  eventMatchScore,
  eventPhraseMatchScore,
  extractSecondaryEntities,
  genericPersonPenalty,
  historicalDateAlignmentScore,
  locationMatchScore,
  modernContextPenalty,
  objectMatchScore,
  placeMatchScore,
  rankingContextForBeat,
  secondaryEntityMatchScore,
  typedQueryPrefix,
} from "./videoPipeline";

/**
 * RONDE 79 — the candidate sort, scored on the whole beat instead of one name.
 *
 * The audit's worked example, measured on the real functions before this round:
 *
 *     beat: "Adolf Hitler dictated his final political testament in the Führerbunker in April 1945."
 *       A "Adolf Hitler in Berlin, 1945"        =   6
 *       B "Adolf Hitler speaking, 1939"         =   4
 *       C "Führerbunker Berlin April 1945"      = -10
 *       D "Winston Churchill in London, 1945"   = -10
 *
 * C is the beat. It names the place, the month and the year, and it lost to a generic portrait
 * from the right decade — and tied with a candidate showing the wrong man in the wrong city.
 *
 * Three causes, all measured, all fixed here:
 *
 *   1. the beat's PLACE was not a ranking signal at all. locationMatchScore reads
 *      dedup.assetDirectorActiveLocation, a per-scene value that is null on most renders, so
 *      "Führerbunker" — already extracted, already sent to the providers — never reached the sort.
 *   2. UNKNOWN was scored as WRONG. A caption that named no person was "general" (-6); a caption
 *      that did not repeat the event verb was -2. Both punished archive stills for being terse.
 *   3. the period was worth -3..+2 beside a +12 name, so six years of error cost nothing.
 *
 * No test below hardcodes a beat or a caption into the scoring. The four beats are regression
 * measurements; §G drives the same functions with synthetic single-signal candidates.
 */

type PT = { title?: string; description?: string; tags?: string; dateHint?: string };

const BEAT_1 = "Adolf Hitler dictated his final political testament in the Fuhrerbunker in April 1945.";
const BEAT_2 = "The Brandenburg Gate stood in ruins after the Battle of Berlin.";
const BEAT_3 = "Soviet soldiers raised their flag over the Reichstag in April 1945.";
const BEAT_4 = "Churchill addressed the nation after the fall of France.";

/**
 * adoptClip's candidate score, minus the terms that need a real file on disk (visual relevance
 * and narration match read the path). Every semantic term is here, summed exactly as
 * nextLevelScore sums them, so what this measures is what the sort measures.
 */
function score(beat: string, primaryPerson: string, pt: PT, videoTitle?: string): number {
  const ctx = rankingContextForBeat(beat);
  const focus = classifyBeatFocus(beat, primaryPerson, videoTitle);
  const tier = classifyEntityMatchTier(primaryPerson, pt);
  const event = eventMatchScore(beat, pt);
  const location = locationMatchScore(null, pt);
  const object = objectMatchScore(beat, pt);
  const secondary = secondaryEntityMatchScore(extractSecondaryEntities(beat, primaryPerson), pt);
  const context = beatContextMatchScore(ctx, pt);
  const hasText = Boolean(pt.title || pt.description || pt.tags);
  const specific = Math.max(event, location, context.place, context.eventPhrase);
  return (
    historicalDateAlignmentScore(pt, beat, videoTitle) +
    entityMatchTierScore(tier) +
    Math.max(event, context.eventPhrase) +
    location +
    object +
    secondary +
    context.place +
    context.action +
    context.modern +
    beatFocusPenalty(focus, tier, event, specific, hasText, object) +
    genericPersonPenalty(focus, tier, event, specific, object, hasText)
  );
}

/** Candidates ranked best-first, the way the pool is sorted. */
function rank(beat: string, person: string, cands: Array<[string, PT]>): string[] {
  return [...cands]
    .sort((a, b) => score(beat, person, b[1]) - score(beat, person, a[1]))
    .map(([label]) => label);
}

/* ═════════════ §A — the audit's beat ═════════════ */

describe("RONDE 79 §A — BEAT 1, the case the whole round is about", () => {
  const A: PT = { title: "Adolf Hitler in Berlin, 1945" };
  const B: PT = { title: "Adolf Hitler speaking, 1939" };
  const C: PT = { title: "Fuhrerbunker Berlin April 1945" };
  const D: PT = { title: "Winston Churchill in London, 1945" };
  const s = (pt: PT) => score(BEAT_1, "Adolf Hitler", pt);

  it("C — the place, the month and the year — is now the strongest candidate", () => {
    expect(s(C)).toBeGreaterThan(s(A));
    expect(s(C)).toBeGreaterThan(s(B));
    expect(s(C)).toBeGreaterThan(s(D));
    expect(rank(BEAT_1, "Adolf Hitler", [["A", A], ["B", B], ["C", C], ["D", D]]))
      .toEqual(["C", "A", "B", "D"]);
  });

  it("A still ranks high — a real person match is still worth a lot", () => {
    expect(s(A)).toBeGreaterThan(0);
    expect(s(A)).toBeGreaterThan(s(B));
    expect(s(A)).toBeGreaterThan(s(D));
  });

  it("B is punished for 1939, and it is the YEAR that punishes it", () => {
    // A and B are the same person, the same tier, the same everything except the date.
    expect(classifyEntityMatchTier("Adolf Hitler", A)).toBe(classifyEntityMatchTier("Adolf Hitler", B));
    expect(s(A) - s(B)).toBe(
      historicalDateAlignmentScore(A, BEAT_1) - historicalDateAlignmentScore(B, BEAT_1)
    );
    expect(s(B)).toBeLessThan(s(A));
  });

  it("D is punished twice — wrong person AND no support for the beat's place", () => {
    expect(classifyEntityMatchTier("Adolf Hitler", D)).toBe("wrong");
    expect(entityMatchTierScore("wrong")).toBeLessThan(0);
    expect(placeMatchScore("Fuhrerbunker", "political testament", D)).toBe(0);
    expect(s(D)).toBeLessThan(0);
    expect(s(D)).toBeLessThan(s(B));
  });

  it("C is NOT read as showing the wrong person just because its caption is a fragment", () => {
    // "Fuhrerbunker Berlin April 1945" comes back from the sentence-tuned person extractor as
    // the "person" Fuhrerbunker Berlin April. Treating that as a competing name put -12 on the
    // single most relevant candidate the beat can have.
    expect(classifyEntityMatchTier("Adolf Hitler", C)).toBe("general");
    expect(entityMatchTierScore("general")).toBe(0);
  });
});

/* ═════════════ §B — a beat with no person at all ═════════════ */

describe("RONDE 79 §B — BEAT 2, ranked without a person to lean on", () => {
  const cands: Array<[string, PT]> = [
    ["exactPlace", { title: "Brandenburg Gate Berlin in ruins 1945" }],
    ["exactEvent", { title: "Battle of Berlin Soviet artillery" }],
    ["genericCity", { title: "Berlin street scene" }],
    ["wrongLocation", { title: "Winston Churchill in London, 1945" }],
    ["modernCity", { title: "Modern Berlin skyline 2019" }],
  ];
  const s = (pt: PT) => score(BEAT_2, "", pt);

  it("exact place and exact event both rank above a generic city", () => {
    const order = rank(BEAT_2, "", cands);
    expect(order.slice(0, 2).sort()).toEqual(["exactEvent", "exactPlace"]);
    expect(order.indexOf("genericCity")).toBeGreaterThan(order.indexOf("exactPlace"));
    expect(order.indexOf("genericCity")).toBeGreaterThan(order.indexOf("exactEvent"));
  });

  it("the full order is exact > generic city > wrong period > wrong location", () => {
    expect(rank(BEAT_2, "", cands))
      .toEqual(["exactEvent", "exactPlace", "genericCity", "modernCity", "wrongLocation"]);
  });

  it("a beat naming no person is not handicapped by that", () => {
    // Every candidate's entity tier is "unknown" and every one of them scores 0 for it.
    for (const [, pt] of cands) {
      expect(classifyEntityMatchTier("", pt)).toBe("unknown");
      expect(entityMatchTierScore(classifyEntityMatchTier("", pt))).toBe(0);
    }
    expect(s(cands[0]![1])).toBeGreaterThan(0);
  });

  it("the NAMED event is what scores, where the old verb cue says nothing at all", () => {
    // BEAT 1's event is "political testament", which is in no verb vocabulary — extractEventCue
    // returns null for it, so eventMatchScore contributes nothing and the phrase term is the
    // only thing that can recognise a candidate about the testament.
    expect(eventMatchScore(BEAT_1, { title: "Hitler's political testament, 1945" })).toBe(0);
    expect(eventPhraseMatchScore("political testament", { title: "Hitler's political testament, 1945" }))
      .toBe(8);
    const withEvent: PT = { title: "Adolf Hitler political testament" };
    const withoutEvent: PT = { title: "Adolf Hitler portrait" };
    expect(score(BEAT_1, "Adolf Hitler", withEvent))
      .toBeGreaterThan(score(BEAT_1, "Adolf Hitler", withoutEvent));
  });

  it("an exact event phrase outscores one whose words are merely all present", () => {
    expect(eventPhraseMatchScore("Battle of Berlin", { title: "Battle of Berlin, 1945" })).toBe(8);
    expect(eventPhraseMatchScore("Battle of Berlin", { title: "Berlin under fire, the final battle" }))
      .toBe(5);
    expect(eventPhraseMatchScore("Battle of Berlin", { title: "Berlin street scene" })).toBe(0);
  });

  it("the modern candidate is marked down on evidence, not on absence", () => {
    expect(modernContextPenalty("", "Battle of Berlin", { title: "Modern Berlin skyline 2019" }))
      .toBeLessThan(0);
    // A candidate that gives no year at all is untouched.
    expect(modernContextPenalty("", "Battle of Berlin", { title: "Berlin street scene" })).toBe(0);
  });
});

/* ═════════════ §C — the proven tie ═════════════ */

describe("RONDE 79 §C — BEAT 3, where Churchill/London used to tie with Reichstag/Berlin", () => {
  const reichstagFlag: PT = { title: "Soviet flag over the Reichstag, April 1945" };
  const reichstag: PT = { title: "Reichstag Berlin 1945" };
  const churchill: PT = { title: "Winston Churchill in London, 1945" };
  const wrongYear: PT = { title: "Soviet soldiers marching 1943" };
  const s = (pt: PT) => score(BEAT_3, "", pt);

  it("the tie is gone, and by a wide margin", () => {
    expect(s(reichstag)).toBeGreaterThan(s(churchill));
    expect(s(reichstag) - s(churchill)).toBeGreaterThan(10);
  });

  it("place, time and object stack — the flag candidate wins on all three", () => {
    expect(rank(BEAT_3, "", [
      ["flag", reichstagFlag], ["reichstag", reichstag],
      ["churchill", churchill], ["wrongYear", wrongYear],
    ])).toEqual(["flag", "reichstag", "churchill", "wrongYear"]);
    expect(placeMatchScore("Reichstag", "", reichstagFlag)).toBeGreaterThan(0);
    expect(objectMatchScore(BEAT_3, reichstagFlag)).toBeGreaterThan(0);
    expect(historicalDateAlignmentScore(reichstagFlag, BEAT_3)).toBeGreaterThan(
      historicalDateAlignmentScore(reichstag, BEAT_3)
    );
  });

  it("the month is what separates the two Reichstag candidates", () => {
    // "April 1945" against "1945": both are the right year, one is the right month too.
    expect(historicalDateAlignmentScore({ title: "Reichstag, April 1945" }, BEAT_3)).toBe(8);
    expect(historicalDateAlignmentScore({ title: "Reichstag, 1945" }, BEAT_3)).toBe(6);
  });
});

/* ═════════════ §D — the right person, the wrong era ═════════════ */

describe("RONDE 79 §D — BEAT 4, a person beat", () => {
  const churchill1940: PT = { title: "Winston Churchill addresses parliament 1940" };
  const hitler: PT = { title: "Adolf Hitler in Paris, 1940" };
  const fallOfFrance: PT = { title: "Fall of France German troops 1940" };
  const churchill1955: PT = { title: "Winston Churchill in 1955" };
  const s = (pt: PT) => score(BEAT_4, "Churchill", pt);

  it("Churchill beats Hitler, decisively", () => {
    expect(s(churchill1940)).toBeGreaterThan(s(hitler));
    expect(classifyEntityMatchTier("Churchill", hitler)).toBe("wrong");
    expect(s(hitler)).toBeLessThan(0);
  });

  it("a Churchill clip from the wrong context does not score as if it were perfect", () => {
    expect(s(churchill1955)).toBeLessThan(s(churchill1940));
    // Both are exact person matches; the action is what separates them.
    expect(classifyEntityMatchTier("Churchill", churchill1955))
      .toBe(classifyEntityMatchTier("Churchill", churchill1940));
    expect(actionMatchScore("addressed", churchill1940)).toBeGreaterThan(0);
    expect(actionMatchScore("addressed", churchill1955)).toBe(0);
  });

  it("the event candidate is a genuine rival, within the sort's tie margin", () => {
    // "Fall of France German troops 1940" matches place AND event and names nobody. It is a
    // legitimate answer to this beat, and the sort treats it as comparable rather than better.
    expect(Math.abs(s(fallOfFrance) - s(churchill1940))).toBeLessThanOrEqual(3);
    expect(compareBeatCandidates(s(churchill1940), false, s(fallOfFrance), true)).toBeLessThan(0);
  });

  it("the action stem matches across conjugations, without a conjugation table", () => {
    expect(actionMatchScore("addressed", { title: "Churchill addresses the nation" })).toBe(4);
    expect(actionMatchScore("addressed", { title: "Churchill addressing the nation" })).toBe(4);
    expect(actionMatchScore("raised", { title: "soldiers raising a flag" })).toBe(4);
  });
});

/* ═════════════ §E — UNKNOWN is not WRONG ═════════════ */

describe("RONDE 79 §E — missing metadata is never evidence against a candidate", () => {
  const silent: PT = { title: "Untitled archive reel" };
  const nothing: PT = {};

  it("no person named is neutral, not negative", () => {
    expect(entityMatchTierScore(classifyEntityMatchTier("Adolf Hitler", silent))).toBe(0);
    expect(entityMatchTierScore(classifyEntityMatchTier("Adolf Hitler", nothing))).toBe(0);
  });

  it("no date is not a wrong date", () => {
    expect(historicalDateAlignmentScore(silent, BEAT_1)).toBe(0);
    expect(historicalDateAlignmentScore(nothing, BEAT_1)).toBe(0);
    expect(historicalDateAlignmentScore({ dateHint: "1945" }, "A calm walk through the park")).toBe(0);
  });

  it("no event, place, action or object is not a wrong one", () => {
    expect(eventMatchScore(BEAT_2, silent)).toBe(0);
    expect(eventPhraseMatchScore("Battle of Berlin", silent)).toBe(0);
    expect(objectMatchScore(BEAT_3, silent)).toBe(0);
    expect(actionMatchScore("raised", silent)).toBe(0);
    expect(placeMatchScore("Reichstag", "", silent)).toBe(0);
    expect(beatContextMatchScore(rankingContextForBeat(BEAT_1), silent).total).toBe(0);
    expect(beatContextMatchScore(rankingContextForBeat(BEAT_1), nothing).total).toBe(0);
  });

  it("a silent caption outranks one that shows the wrong person", () => {
    expect(score(BEAT_1, "Adolf Hitler", silent))
      .toBeGreaterThan(score(BEAT_1, "Adolf Hitler", { title: "Winston Churchill in London, 1945" }));
  });

  it("an undefined context scores nothing at all rather than throwing", () => {
    expect(beatContextMatchScore(undefined, silent))
      .toEqual({ place: 0, action: 0, eventPhrase: 0, modern: 0, total: 0 });
  });
});

/* ═════════════ §F — the negative signals ═════════════ */

describe("RONDE 79 §F — a wrong signal is allowed to be wrong", () => {
  it("a candidate naming a different person is penalised", () => {
    expect(classifyEntityMatchTier("Adolf Hitler", { title: "Winston Churchill portrait" })).toBe("wrong");
    expect(entityMatchTierScore("wrong")).toBeLessThan(entityMatchTierScore("general"));
    expect(entityMatchTierScore("wrong")).toBe(-entityMatchTierScore("exact"));
  });

  it("a wrong place is penalised only when both sides are recognisable geography", () => {
    // Beat place is a country, candidate names a different country: provable.
    expect(placeMatchScore("France", "", { title: "Adolf Hitler in Berlin, 1940" })).toBeLessThan(0);
    // Beat place is a building. That a candidate says "London" does not prove it is the wrong
    // building — the building may well be filed under a city — so this stays unknown.
    expect(placeMatchScore("Fuhrerbunker", "", { title: "Winston Churchill in London, 1945" })).toBe(0);
  });

  it("a clearly wrong period is penalised, a near one is not", () => {
    expect(historicalDateAlignmentScore({ dateHint: "1889" }, BEAT_1)).toBeLessThan(0);
    // The four rungs, in order: exact, close (<=2y), uncertain (<=10y), clearly wrong.
    expect(historicalDateAlignmentScore({ dateHint: "1945" }, BEAT_1)).toBe(6);
    expect(historicalDateAlignmentScore({ dateHint: "1943" }, BEAT_1)).toBe(3);
    expect(historicalDateAlignmentScore({ dateHint: "1950" }, BEAT_1)).toBe(0);
    expect(historicalDateAlignmentScore({ dateHint: "1946" }, BEAT_1)).toBeGreaterThan(0);
  });

  it("a 1945 date does not rescue a candidate showing the wrong person", () => {
    // The audit's own example: "expliciet Churchill voor een Hitler-beat mag niet hoog eindigen
    // alleen omdat hij uit 1945 komt."
    const churchill1945: PT = { title: "Winston Churchill in London, 1945" };
    expect(historicalDateAlignmentScore(churchill1945, BEAT_1)).toBeGreaterThan(0);
    expect(score(BEAT_1, "Adolf Hitler", churchill1945)).toBeLessThan(0);
  });
});

/* ═════════════ §G — no signal is dominant ═════════════ */

describe("RONDE 79 §G — the score rises with combined context, and nothing decides alone", () => {
  // One beat, seven synthetic candidates, each carrying a named combination of signals. No
  // caption here appears anywhere else in this file: this measures the weights, not the beats.
  const BEAT = "Adolf Hitler dictated his final political testament in the Fuhrerbunker in April 1945.";
  const s = (pt: PT) => score(BEAT, "Adolf Hitler", pt);

  const personOnly: PT = { title: "Adolf Hitler portrait" };
  const placeOnly: PT = { title: "Fuhrerbunker interior" };
  const timeOnly: PT = { title: "Wartime footage, April 1945" };
  const personWrongTime: PT = { title: "Adolf Hitler, 1933" };
  const placeCorrectTime: PT = { title: "Fuhrerbunker, April 1945" };
  const personPlaceTime: PT = { title: "Adolf Hitler in the Fuhrerbunker, April 1945" };
  const wrongPerson: PT = { title: "Winston Churchill portrait" };

  it("person+place+time is the best of them", () => {
    for (const other of [personOnly, placeOnly, timeOnly, personWrongTime, placeCorrectTime, wrongPerson]) {
      expect(s(personPlaceTime)).toBeGreaterThan(s(other));
    }
  });

  it("two signals beat one", () => {
    expect(s(placeCorrectTime)).toBeGreaterThan(s(placeOnly));
    expect(s(placeCorrectTime)).toBeGreaterThan(s(timeOnly));
  });

  it("a correct place with the correct time beats the person alone", () => {
    // This is the inversion the round exists for. Before RONDE 79 the person won outright.
    expect(s(placeCorrectTime)).toBeGreaterThan(s(personOnly));
  });

  it("a person in the wrong period scores below the same person in no stated period", () => {
    expect(s(personWrongTime)).toBeLessThan(s(personOnly));
  });

  it("the wrong person is last, below every candidate that merely says little", () => {
    for (const other of [personOnly, placeOnly, timeOnly, personWrongTime, placeCorrectTime, personPlaceTime]) {
      expect(s(wrongPerson)).toBeLessThan(s(other));
    }
  });

  it("no single term can carry a candidate on its own", () => {
    // Each individual signal is bounded below the sum of the other four, so removing any one of
    // them cannot by itself decide the pool.
    const person = entityMatchTierScore("exact");
    const place = placeMatchScore("Fuhrerbunker", "", { title: "Fuhrerbunker" });
    const time = historicalDateAlignmentScore({ dateHint: "April 1945" }, BEAT);
    const event = eventPhraseMatchScore("political testament", { title: "political testament" });
    const action = actionMatchScore("dictated", { title: "dictating" });
    const all = [person, place, time, event, action];
    for (const term of all) {
      const others = all.reduce((a, b) => a + b, 0) - term;
      expect(term, `a single term (${term}) outweighs the other four (${others})`)
        .toBeLessThan(others);
    }
  });
});

/* ═════════════ §H — one semantic truth ═════════════ */

describe("RONDE 79 §H — ranking and retrieval read the same context", () => {
  it("rankingContextForBeat is the RONDE 78 context, not a second extraction layer", () => {
    for (const beat of [BEAT_1, BEAT_2, BEAT_3, BEAT_4]) {
      const ctx = rankingContextForBeat(beat);
      // Everything the sort scores against also appears in the queries the providers were sent.
      const queries = typedQueryPrefix(beat).join(" | ");
      if (ctx.place) expect(queries, `place "${ctx.place}" was never queried`).toContain(ctx.place);
      if (ctx.person) expect(queries).toContain(ctx.person);
      if (ctx.year) expect(queries).toContain(ctx.year);
    }
  });

  it("the context carries all five categories for BEAT 1", () => {
    const c = rankingContextForBeat(BEAT_1);
    expect(c.person).toBe("Adolf Hitler");
    expect(c.place).toBe("Fuhrerbunker");
    expect(c.time).toBe("April 1945");
    expect(c.event).toContain("political testament");
    expect(c.action).toBe("dictated");
  });

  it("scoring costs no network call and no per-candidate extraction", () => {
    // The context is built once per pool; scoring a candidate is string comparison only.
    const ctx = rankingContextForBeat(BEAT_1);
    const before = Date.now();
    for (let i = 0; i < 2000; i += 1) {
      beatContextMatchScore(ctx, { title: `Fuhrerbunker Berlin April 1945 take ${i}` });
    }
    expect(Date.now() - before).toBeLessThan(2000);
  });
});
