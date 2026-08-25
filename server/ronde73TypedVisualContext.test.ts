import { describe, expect, it } from "vitest";
import {
  extractVisualPlacePhrase,
  extractPersonNamesFromText,
  scriptStockSearchQueries,
} from "./videoPipeline";
import {
  buildMediaSearchIntent,
  buildHistoricalArchivalQueries,
  extractBeatVisualTargets,
  extractLocationPhrase,
  extractEventCue,
  extractObjectCue,
} from "./mediaResearchEngine";
import { buildInternetArchiveGeoQueries } from "./geoDocumentarySources";
import { beatVisualSearchSubjects } from "./scriptVisualKeywords";

/**
 * RONDE 73 — the typed fields the pipeline already had, combined before retrieval.
 *
 * The audit traced one beat end to end and found the meaning was already being lost before any
 * provider was called. Measured on the real functions, before this round:
 *
 *     "Adolf Hitler dictated his final political testament in the Führerbunker in April 1945."
 *       place  -> "April"                     the month read as a location
 *       queries-> "Adolf Hitler archival footage" AND "hitler bunker 1945", never together
 *
 * The typed representation was not missing — VisualTargetType has had person/event/location/
 * object since the visual-selection hardening round. It was filled wrongly and never combined.
 *
 * Every test below runs the real functions on real narration. None inspects source strings.
 */

const TITLE = "The final days of Hitler in the Fuhrerbunker — April 1945";

/** The whole query path a beat travels, exactly as videoPipeline's four call sites drive it. */
function queriesForBeat(beat: string) {
  const persons = extractPersonNamesFromText(beat);
  const place = extractVisualPlacePhrase(beat);
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
  return {
    persons,
    place,
    targets: extractBeatVisualTargets(beat, intent, TITLE, { place }),
    queries: buildHistoricalArchivalQueries(intent, beat, { place }),
  };
}

/* ═════════════ D1 — the place, isolated from ranking ═════════════ */

describe("RONDE 73 §D1 — the beat's place, and never a month", () => {
  it("finds a place introduced by a preposition and an article", () => {
    expect(extractVisualPlacePhrase("…dictated his testament in the Fuhrerbunker in April 1945."))
      .toBe("Fuhrerbunker");
  });

  it("finds a building that is the sentence's subject, with no preposition at all", () => {
    expect(extractVisualPlacePhrase("The Brandenburg Gate stood in ruins after the Battle of Berlin."))
      .toBe("Brandenburg Gate");
    expect(extractVisualPlacePhrase("Above them the Reich Chancellery garden was a field of craters."))
      .toBe("Reich Chancellery");
  });

  it("handles 'over the X' and 'of X'", () => {
    expect(extractVisualPlacePhrase("Soviet soldiers raised their flag over the Reichstag in April 1945."))
      .toBe("Reichstag");
    expect(extractVisualPlacePhrase("Churchill addressed the nation after the fall of France."))
      .toBe("France");
  });

  it("falls back to a bare place name the beat opens with", () => {
    expect(extractVisualPlacePhrase("Berlin was under constant bombardment in April 1945."))
      .toBe("Berlin");
  });

  it("NEGATIVE — a month is never a place", () => {
    for (const beat of [
      "Adolf Hitler dictated his testament in April 1945.",
      "He arrived in Munich in March.",
      "They met at the gate in December 1944.",
      "The order came in August.",
      "Fighting continued in May and June.",
    ]) {
      const place = extractVisualPlacePhrase(beat);
      for (const month of ["April", "March", "December", "August", "May", "June"]) {
        expect(place, `"${beat}" must not resolve to a month`).not.toContain(month);
      }
    }
  });

  it("NEGATIVE — an organisation is not a place", () => {
    // "army" is in the vocabulary as an ORGANISATION, deliberately not as a structure.
    expect(extractVisualPlacePhrase("The Red Army encircled the city.")).toBe("");
  });

  it("NEGATIVE — a beat naming no place returns an empty string, not a fragment", () => {
    expect(extractVisualPlacePhrase("Nothing here at all.")).toBe("");
    expect(extractVisualPlacePhrase("")).toBe("");
    expect(extractVisualPlacePhrase("   ")).toBe("");
  });

  it("RANKING IS UNTOUCHED — extractLocationPhrase still returns exactly what it did", () => {
    // It feeds classifyBeatFocus. This round fixes the query path around it, never through it.
    expect(extractLocationPhrase("…testament in the Fuhrerbunker in April 1945.")).toBe("April");
    expect(extractLocationPhrase("The Brandenburg Gate stood in ruins after the Battle of Berlin."))
      .toBeNull();
    expect(extractLocationPhrase("Churchill addressed the nation after the fall of France."))
      .toBeNull();
  });
});

/* ═════════════ D2 — the object cue reaches the targets ═════════════ */

describe("RONDE 73 §D2 — extractObjectCue's answer now arrives", () => {
  it("a flag the beat centres on becomes an object target", () => {
    const beat = "Soviet soldiers raised their flag over the Reichstag in April 1945.";
    expect(extractObjectCue(beat)).toBe("flag");
    const { targets } = queriesForBeat(beat);
    expect(targets.find((t) => t.type === "object")?.text).toBe("flag");
  });

  it("a beat naming no object produces no object target — no invented field", () => {
    const { targets } = queriesForBeat("Churchill addressed the nation after the fall of France.");
    expect(targets.some((t) => t.type === "object")).toBe(false);
  });

  it("the corrected place reaches the location target too", () => {
    const { targets } = queriesForBeat(
      "Adolf Hitler dictated his final political testament in the Fuhrerbunker in April 1945."
    );
    expect(targets.find((t) => t.type === "location")?.text).toBe("Fuhrerbunker");
    expect(targets.map((t) => t.text)).not.toContain("April");
  });
});

/* ═════════════ D3 — the fields, combined ═════════════ */

describe("RONDE 73 §D3 — person, place and time in one query", () => {
  it("BEAT 1 — Adolf Hitler + Führerbunker + 1945", () => {
    const { persons, place, queries } = queriesForBeat(
      "Adolf Hitler dictated his final political testament in the Fuhrerbunker in April 1945."
    );
    expect(persons).toContain("Adolf Hitler");
    expect(place).toBe("Fuhrerbunker");
    expect(place).not.toBe("April");

    const combined = queries.find(
      (q) => q.includes("Adolf Hitler") && q.includes("Fuhrerbunker") && q.includes("1945")
    );
    expect(combined, "person + place + time must exist as ONE query").toBeDefined();
    // And it leads: the archive is asked the specific question first.
    expect(queries[0]).toBe("Adolf Hitler Fuhrerbunker 1945");
  });

  it("BEAT 2 — Brandenburg Gate and the battle survive into the family", () => {
    const { place, queries } = queriesForBeat(
      "The Brandenburg Gate stood in ruins after the Battle of Berlin."
    );
    expect(place).toBe("Brandenburg Gate");
    expect(extractEventCue("The Brandenburg Gate stood in ruins after the Battle of Berlin."))
      .toBe("battle");
    const joined = queries.join(" | ").toLowerCase();
    expect(joined).toContain("brandenburg gate");
    expect(joined).toContain("battle");
    expect(queries.some((q) => /brandenburg gate/i.test(q) && /battle/i.test(q))).toBe(true);
  });

  it("BEAT 3 — Reichstag + 1945, with the flag", () => {
    const { place, queries } = queriesForBeat(
      "Soviet soldiers raised their flag over the Reichstag in April 1945."
    );
    expect(place).toBe("Reichstag");
    expect(queries[0]).toBe("Reichstag 1945");
    expect(queries.some((q) => q.includes("Reichstag") && q.includes("flag") && q.includes("1945")))
      .toBe(true);
  });

  it("BEAT 4 — Churchill is kept and combined with the place", () => {
    const { persons, queries } = queriesForBeat(
      "Churchill addressed the nation after the fall of France."
    );
    expect(persons).toContain("Churchill");
    expect(queries.join(" | ")).toContain("Churchill");
    expect(queries[0]).toBe("Churchill France");
  });

  it("NEGATIVE — a missing field never leaves a gap, a null or an undefined", () => {
    const beats = [
      "Adolf Hitler dictated his final political testament in the Fuhrerbunker in April 1945.",
      "The Brandenburg Gate stood in ruins after the Battle of Berlin.",
      "Soviet soldiers raised their flag over the Reichstag in April 1945.",
      "Churchill addressed the nation after the fall of France.",
      "The war changed everything.",
      "",
    ];
    for (const beat of beats) {
      for (const q of queriesForBeat(beat).queries) {
        expect(q, `"${q}" from "${beat}"`).not.toContain("undefined");
        expect(q).not.toContain("null");
        expect(q).not.toMatch(/\s{2,}/);
        expect(q).toBe(q.trim());
        expect(q.length).toBeGreaterThan(0);
      }
    }
  });

  it("NEGATIVE — no event or action is invented where the extractors say nothing", () => {
    // "political testament" is not in the documentary-event vocabulary and must not be faked.
    const beat = "Adolf Hitler dictated his final political testament in the Fuhrerbunker in April 1945.";
    expect(extractEventCue(beat)).toBeNull();
    const { queries } = queriesForBeat(beat);
    expect(queries.join(" | ").toLowerCase()).not.toContain("dictated");
  });

  it("the existing generic fallbacks are still there — added to, not replaced", () => {
    const { queries } = queriesForBeat(
      "Adolf Hitler dictated his final political testament in the Fuhrerbunker in April 1945."
    );
    for (const generic of [
      "hitler bunker archival footage",
      "hitler bunker historical documentary",
      "hitler bunker original footage",
      "hitler bunker historical footage",
    ]) {
      expect(queries, "the F3-39 breadth set must survive").toContain(generic);
    }
    expect(queries.length).toBeLessThanOrEqual(12);
  });
});

/* ═════════════ Internet Archive ═════════════ */

describe("RONDE 73 — the Internet Archive narration query is a fallback again", () => {
  const BEAT = "Adolf Hitler dictated his final political testament in the Fuhrerbunker in April 1945.";

  it("the truncated sentence no longer leads", () => {
    const qs = buildInternetArchiveGeoQueries(BEAT, TITLE, 0);
    // It used to be positions 1 and 2, cut at character 55.
    expect(qs[0]).not.toMatch(/^Adolf Hitler dictated/);
    expect(qs[1]).not.toMatch(/^Adolf Hitler dictated/);
    expect(qs[0]).toBe("hitler bunker");
  });

  it("nothing is cut mid-word, and no query ends on a dangling preposition", () => {
    for (const beat of [
      BEAT,
      "Soviet soldiers raised their flag over the Reichstag in April 1945.",
      "The Brandenburg Gate stood in ruins after the Battle of Berlin.",
    ]) {
      for (const q of buildInternetArchiveGeoQueries(beat, TITLE, 0)) {
        expect(q).not.toMatch(/\s{2,}/);
        expect(q).not.toMatch(/\b(?:in|at|on|of|to|the|a|an|and|or|for|from|with|by|into)\s+(?:documentary|footage)$/i);
      }
    }
  });

  it("the narration query, when it appears, carries the whole clause", () => {
    // 55 characters cut "…testament in " — the place and the date were lost.
    const long = "Adolf Hitler dictated his final political testament in the Fuhrerbunker in April 1945.";
    const qs = buildInternetArchiveGeoQueries(long, TITLE, 0);
    const narrative = qs.find((q) => q.startsWith("Adolf Hitler dictated"));
    if (narrative) {
      expect(narrative).toContain("Fuhrerbunker");
      expect(narrative).not.toMatch(/\bin\s+(?:documentary|footage)$/);
    }
  });
});
