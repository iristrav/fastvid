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

/* ═════════════ ranking must be untouched ═════════════ */

describe("RONDE 75 — ranking inputs are not on this path", () => {
  it("extractLocationPhrase still answers exactly as before", async () => {
    const { extractLocationPhrase } = await import("./mediaResearchEngine");
    expect(extractLocationPhrase("…testament in the Fuhrerbunker in April 1945.")).toBe("April");
    expect(extractLocationPhrase(BEAT_2)).toBeNull();
    expect(extractLocationPhrase(BEAT_4)).toBeNull();
  });
});
