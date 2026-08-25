/**
 * Extra documentary sources for geography / urban beats (NL, US, EU comparisons).
 * Queries are beat- and title-anchored so CLIP can gate per narration line.
 */
import { buildGeoStockSearchQueries } from "./curatedMediaSourcing";
import { buildDocumentaryShotQueries } from "./pipelineSelfHeal";
import { uniqueQueryStrings } from "./stringCoercion";
import { inferBeatGeoRegion } from "./vidrushQuality";
import { extractBeatGeoPlaceTags, inferVideoVisualTopic } from "./visualBeatTags";
import { extractTitleGeoPlaceTags } from "./worldGeoSlugs";
import { beatVisualSearchSubjects } from "./scriptVisualKeywords";

export function isGeoDocumentaryContext(beatText: string, videoTitle?: string): boolean {
  if (inferVideoVisualTopic(videoTitle, beatText) === "geography_urban") return true;
  const region = inferBeatGeoRegion(beatText, videoTitle);
  if (region === "nl" || region === "us" || region === "both") return true;
  return (
    extractBeatGeoPlaceTags(beatText).length > 0 ||
    extractTitleGeoPlaceTags(videoTitle).length > 0
  );
}

/**
 * RONDE 73: a length bound the archive's query parser can live with, applied on a word boundary.
 * Raised from 55 because 55 cut the example beat in half; a whole clause is the point.
 */
const NARRATION_QUERY_MAX_CHARS = 90;

/** Cuts at the last whole word that fits, and never leaves a dangling function word behind. */
function truncateOnWordBoundary(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const words = trimmed.slice(0, maxChars + 1).split(/\s+/);
  words.pop();
  while (words.length > 1 && /^(?:in|at|on|of|to|the|a|an|and|or|for|from|with|by|into)$/i.test(words[words.length - 1]!)) {
    words.pop();
  }
  return words.join(" ").trim();
}

/** Internet Archive advancedsearch queries — free, no API key. */
export function buildInternetArchiveGeoQueries(
  beatText: string,
  videoTitle?: string,
  beatIndex = 0
): string[] {
  const scriptSubjects = beatVisualSearchSubjects(beatText);
  const titleGeo = extractTitleGeoPlaceTags(videoTitle);
  const beatGeo = buildGeoStockSearchQueries(beatText, videoTitle);
  const region = inferBeatGeoRegion(beatText, videoTitle);
  const raw: unknown[] = [...scriptSubjects];

  for (const t of titleGeo.slice(0, 3)) {
    raw.push(`title:(${t}) AND mediatype:movies`);
    raw.push(`${t} documentary film`);
    raw.push(...buildDocumentaryShotQueries(`${t} city`, beatIndex));
  }

  if (
    region === "nl" ||
    titleGeo.some((t) => /netherlands|holland|dutch|amsterdam|nederland|rotterdam/.test(t))
  ) {
    raw.push(
      "netherlands cycling documentary",
      "amsterdam city documentary",
      "dutch cycling infrastructure",
      "title:(netherlands) AND mediatype:movies",
      "collection:opensource_movies AND netherlands"
    );
  }
  if (region === "us" || titleGeo.some((t) => /america|united states|usa/.test(t))) {
    raw.push("united states city documentary", "american suburban sprawl documentary");
  }

  for (const q of beatGeo.slice(0, 4)) {
    raw.push(q);
    raw.push(`${q} documentary`);
  }

  // RONDE 73 — the narration query is a fallback, not the opening move.
  //
  // This used to `slice(0, 55)` and `unshift`. Both were wrong. The cut landed mid-sentence:
  //
  //     "Adolf Hitler dictated his final political testament in the Führerbunker in April 1945."
  //  -> "Adolf Hitler dictated his final political testament in "
  //
  // — losing the place and the date, and leaving a trailing preposition and a doubled space. And
  // `unshift` put those two truncated fragments at the FRONT, so Internet Archive spent the
  // beat's budget on them before reaching "hitler bunker" at position four.
  //
  // The cut is now on a word boundary and the query goes to the BACK, behind the semantic ones.
  // Nothing is removed: the same two narration queries are still produced and still searched.
  const narration = truncateOnWordBoundary(
    beatText.replace(/\[visual:[^\]]+\]/gi, " ").replace(/\s+/g, " ").trim(),
    NARRATION_QUERY_MAX_CHARS
  );
  if (narration.length >= 8) {
    raw.push(`${narration} documentary`, `${narration} footage`);
  }

  return uniqueQueryStrings(raw, 4).slice(0, 8);
}

/** Wikimedia Commons video search — beat/geo anchored. */
export function buildWikimediaVideoGeoQueries(beatText: string, videoTitle?: string): string[] {
  const subjects = beatVisualSearchSubjects(beatText);
  return uniqueQueryStrings(
    [...subjects, ...buildGeoStockSearchQueries(beatText, videoTitle)],
    3
  ).slice(0, 7);
}
