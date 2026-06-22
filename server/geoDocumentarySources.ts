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

export function isGeoDocumentaryContext(beatText: string, videoTitle?: string): boolean {
  if (inferVideoVisualTopic(videoTitle, beatText) === "geography_urban") return true;
  const region = inferBeatGeoRegion(beatText, videoTitle);
  if (region === "nl" || region === "us" || region === "both") return true;
  return (
    extractBeatGeoPlaceTags(beatText).length > 0 ||
    extractTitleGeoPlaceTags(videoTitle).length > 0
  );
}

/** Internet Archive advancedsearch queries — free, no API key. */
export function buildInternetArchiveGeoQueries(
  beatText: string,
  videoTitle?: string,
  beatIndex = 0
): string[] {
  const titleGeo = extractTitleGeoPlaceTags(videoTitle);
  const beatGeo = buildGeoStockSearchQueries(beatText, videoTitle);
  const region = inferBeatGeoRegion(beatText, videoTitle);
  const raw: unknown[] = [];

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

  for (const q of beatGeo.slice(0, 8)) {
    raw.push(q);
    raw.push(`${q} documentary`);
  }

  const beatAnchored: unknown[] = [];
  const narration = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim().slice(0, 55);
  if (narration.length >= 8) {
    beatAnchored.push(`${narration} documentary`, `${narration} footage`);
  }

  return uniqueQueryStrings([...beatAnchored, ...raw], 4).slice(0, 8);
}

/** Wikimedia Commons video search — beat/geo anchored. */
export function buildWikimediaVideoGeoQueries(beatText: string, videoTitle?: string): string[] {
  return buildGeoStockSearchQueries(beatText, videoTitle).slice(0, 7);
}
