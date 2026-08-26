import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  extractVisualPlacePhrase,
  extractPersonNamesFromText,
  scriptStockSearchQueries,
} from "./videoPipeline";
import {
  buildMediaSearchIntent,
  buildHistoricalArchivalQueries,
  anchorQueriesToHistoricalContext,
} from "./mediaResearchEngine";
import {
  buildInternetArchiveGeoQueries,
  buildWikimediaVideoGeoQueries,
} from "./geoDocumentarySources";
import { buildGeoStockSearchQueries } from "./curatedMediaSourcing";
import { beatVisualSearchSubjects } from "./scriptVisualKeywords";
import { uniqueQueryStrings, toQueryString } from "./stringCoercion";

/**
 * RONDE 75 — the two retrieval paths that were still asking the wrong question.
 *
 * RONDE 73 combined the typed fields and reached four call sites with them. The RONDE 74 trace
 * proved those four work — and that adoptInternetArchiveBeatClip and adoptWikimediaBeatClip
 * build their own query lists from the geo/stock builders, so on the very same beats they were
 * still asking:
 *
 *     "…in the Führerbunker in April 1945."            -> "hitler bunker"
 *     "The Brandenburg Gate stood in ruins…"           -> "berlin city skyline"
 *     "…their flag over the Reichstag in April 1945."  -> "russia aerial video"
 *     "Churchill … after the fall of France."          -> "france aerial video"
 *
 * These tests reproduce each path's real query assembly from the real builders, so they measure
 * what the provider is handed rather than what the source says.
 */

const TITLE = "The final days of Hitler in the Fuhrerbunker — April 1945";

const BEAT_1 = "Adolf Hitler dictated his final political testament in the Fuhrerbunker in April 1945.";
const BEAT_2 = "The Brandenburg Gate stood in ruins after the Battle of Berlin.";
const BEAT_3 = "Soviet soldiers raised their flag over the Reichstag in April 1945.";
const BEAT_4 = "Churchill addressed the nation after the fall of France.";

/** Exactly what typedRetrievalQueriesForBeat returns for a beat. */
function typedQueries(beat: string): string[] {
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
  return buildHistoricalArchivalQueries(intent, beat, { place: extractVisualPlacePhrase(beat) });
}

/** The geo fallback adoptInternetArchiveBeatClip had before this round, unchanged. */
function iaFallback(beat: string): string[] {
  const geo = buildInternetArchiveGeoQueries(beat, TITLE, 0);
  const anchored = anchorQueriesToHistoricalContext({
    primaryQuery: geo[0] ?? "",
    extraQueries: geo.slice(1),
    sceneText: beat,
    videoTitle: TITLE,
    primaryPerson: undefined,
  });
  return anchored.anchored ? [anchored.primaryQuery, ...anchored.extraQueries] : geo;
}

/** The list adoptInternetArchiveBeatClip now hands to fetchInternetArchiveClips. */
function iaQueries(beat: string): string[] {
  return uniqueQueryStrings([...typedQueries(beat).slice(0, 3), ...iaFallback(beat)], 3).slice(0, 11);
}

/** The list adoptWikimediaBeatClip now iterates for Wikimedia video. */
function wikiVideoQueries(beat: string, fastMode = false): string[] {
  const geo = buildGeoStockSearchQueries(beat, TITLE).slice(0, 3);
  return uniqueQueryStrings(
    [
      ...typedQueries(beat).slice(0, 3),
      ...geo,
      ...buildWikimediaVideoGeoQueries(beat, TITLE),
      toQueryString(""),
    ],
    3
  ).slice(0, fastMode ? 8 : 11);
}

/* ═════════════ query priority ═════════════ */

describe("RONDE 75 — the typed query is #1 on both paths", () => {
  const cases: Array<[string, string, string[]]> = [
    // RONDE 88 §4: the bare name+place leads, the year-qualified form follows at position 2.
    // Both still lead the list, and all three terms still reach the provider.
    [BEAT_1, "Adolf Hitler Fuhrerbunker", ["Adolf Hitler", "Fuhrerbunker", "1945"]],
    // RONDE 78 named the event rather than reducing it to its verb: "battle" -> "Battle of Berlin".
    [BEAT_2, "Brandenburg Gate Battle of Berlin", ["Brandenburg Gate", "Battle of Berlin"]],
    [BEAT_3, "Reichstag 1945", ["Reichstag", "1945"]],
    [BEAT_4, "Churchill France", ["Churchill", "France"]],
  ];

  for (const [beat, expectedFirst, mustAppear] of cases) {
    it(`INTERNET ARCHIVE — "${beat.slice(0, 42)}…" leads with "${expectedFirst}"`, () => {
      const qs = iaQueries(beat);
      expect(qs[0]).toBe(expectedFirst);
      const joined = qs.join(" | ");
      for (const term of mustAppear) expect(joined).toContain(term);
    });

    it(`WIKIMEDIA — "${beat.slice(0, 42)}…" leads with "${expectedFirst}"`, () => {
      const qs = wikiVideoQueries(beat);
      expect(qs[0]).toBe(expectedFirst);
      const joined = qs.join(" | ");
      for (const term of mustAppear) expect(joined).toContain(term);
    });
  }

  it("BEAT 1 — the full person + place + time combination reaches both providers", () => {
    for (const qs of [iaQueries(BEAT_1), wikiVideoQueries(BEAT_1)]) {
      const combined = qs.find(
        (q) => q.includes("Adolf Hitler") && q.includes("Fuhrerbunker") && q.includes("1945")
      );
      expect(combined).toBeDefined();
      // Position 1 rather than 0 since RONDE 88 — "Adolf Hitler Fuhrerbunker" leads it.
      expect(qs.indexOf(combined!)).toBe(1);
      expect(qs[0]).toBe("Adolf Hitler Fuhrerbunker");
    }
  });

  it("BEAT 3 — the object survives into the family on both paths", () => {
    for (const qs of [iaQueries(BEAT_3), wikiVideoQueries(BEAT_3)]) {
      expect(qs.some((q) => q.includes("Reichstag") && q.includes("flag") && q.includes("1945")))
        .toBe(true);
    }
  });

  it("fast mode keeps the typed queries at the head too", () => {
    const qs = wikiVideoQueries(BEAT_3, true);
    expect(qs[0]).toBe("Reichstag 1945");
    expect(qs[1]).toBe("Reichstag flag 1945");
  });
});

/* ═════════════ negative tests ═════════════ */

describe("RONDE 75 — what must NOT be the primary query", () => {
  it("the geo-stock phrase is no longer #1 on either path", () => {
    const banned: Array<[string, string]> = [
      [BEAT_1, "hitler bunker"],
      [BEAT_2, "berlin city skyline"],
      [BEAT_3, "russia aerial video"],
      [BEAT_4, "france aerial video"],
    ];
    for (const [beat, phrase] of banned) {
      expect(iaQueries(beat)[0], `IA #1 for "${beat.slice(0, 30)}"`).not.toBe(phrase);
      expect(wikiVideoQueries(beat)[0]).not.toBe(phrase);
      // Nor anywhere in the leading three.
      expect(iaQueries(beat).slice(0, 3)).not.toContain(phrase);
      expect(wikiVideoQueries(beat).slice(0, 3)).not.toContain(phrase);
    }
  });

  it("April is never used as the place on either path", () => {
    for (const beat of [BEAT_1, BEAT_3]) {
      expect(extractVisualPlacePhrase(beat)).not.toContain("April");
      for (const qs of [iaQueries(beat), wikiVideoQueries(beat)]) {
        // "April 1945" is a legitimate period query from the anchor; a query that treats April
        // as the SUBJECT — "April archival footage" — is not.
        expect(qs).not.toContain("April archival footage");
        expect(qs.slice(0, 3).join(" | ")).not.toContain("April");
      }
    }
  });

  it("no query carries undefined, null, a double space or stray whitespace", () => {
    for (const beat of [BEAT_1, BEAT_2, BEAT_3, BEAT_4, "The war changed everything.", ""]) {
      for (const qs of [iaQueries(beat), wikiVideoQueries(beat), typedQueries(beat)]) {
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
});

/* ═════════════ the fallbacks must survive ═════════════ */

describe("RONDE 75 — added to the existing breadth, not swapped for it", () => {
  it("INTERNET ARCHIVE — every fallback query the path had before is still in the list", () => {
    for (const beat of [BEAT_1, BEAT_2, BEAT_3, BEAT_4]) {
      const before = iaFallback(beat);
      const after = iaQueries(beat);
      for (const q of before) {
        expect(after, `"${q}" was dropped for "${beat.slice(0, 30)}"`).toContain(q);
      }
      expect(after.length).toBeGreaterThan(before.length);
    }
  });

  it("WIKIMEDIA — the geo and video builders still contribute", () => {
    for (const beat of [BEAT_1, BEAT_2, BEAT_3, BEAT_4]) {
      const qs = wikiVideoQueries(beat).join(" | ");
      const geo = buildGeoStockSearchQueries(beat, TITLE).slice(0, 3);
      expect(geo.length).toBeGreaterThan(0);
      expect(geo.some((g) => qs.includes(g)), `no geo query survived for "${beat.slice(0, 30)}"`)
        .toBe(true);
    }
  });

  it("the caps grew by exactly the number of typed entries added", () => {
    // 3 typed on the IA path (8 -> 10 leaves room), 3 on Wikimedia video (8 -> 11),
    // 2 on Openverse (6 -> 8 / 4 -> 6). Pinned so a later edit cannot quietly re-evict them.
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(src).toContain("dedup.perf.fastStockMode ? 8 : 11");
    expect(src).toContain("geoDoc ? 8 : 6");
  });

  it("the typed helper is one adapter, not a third query architecture", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const start = src.indexOf("function typedRetrievalQueriesForBeat(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start));
    // It assembles the existing intent and calls the existing builder. Nothing else.
    expect(body).toContain("buildMediaSearchIntent({");
    expect(body).toContain("buildHistoricalArchivalQueries(intent, beat.text, {");
    expect(body).toContain("place: extractVisualPlacePhrase(beat.text)");
    for (const forbidden of ["fetch(", "invokeLLM", "new RegExp", "match(", "replace("]) {
      expect(body).not.toContain(forbidden);
    }
  });
});

/* ═════════════ ranking must be untouched ═════════════ */

describe("RONDE 75 — ranking inputs are not on this path", () => {
  it("extractLocationPhrase still answers exactly as before", async () => {
    const { extractLocationPhrase } = await import("./mediaResearchEngine");
    expect(extractLocationPhrase("…testament in the Fuhrerbunker in April 1945.")).toBe("April");
    expect(extractLocationPhrase(BEAT_2)).toBeNull();
    expect(extractLocationPhrase(BEAT_4)).toBeNull();
  });

  it("the two changed functions contain no ranking call", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    for (const fn of ["async function adoptInternetArchiveBeatClip("]) {
      const start = src.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, start + 4000);
      for (const banned of [
        "entityMatchTierScore(",
        "historicalDateAlignmentScore(",
        "classifyBeatFocus(",
        "beatFocusPenalty(",
        "compareBeatCandidates(",
      ]) {
        expect(body, `${fn} must not touch ${banned}`).not.toContain(banned);
      }
    }
  });
});
