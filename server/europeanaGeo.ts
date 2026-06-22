/**
 * Europeana sourcing helpers — EU geo titles get priority heritage video fetch.
 */
import { NL_GEO_SLUGS, extractTitleGeoPlaceTags } from "./worldGeoSlugs";
import { asVideoTitleString, toQueryString } from "./stringCoercion";

const EU_GEO_HINTS = new Set([
  ...NL_GEO_SLUGS,
  "germany",
  "berlin",
  "munich",
  "france",
  "paris",
  "italy",
  "rome",
  "spain",
  "madrid",
  "belgium",
  "brussels",
  "austria",
  "vienna",
  "poland",
  "warsaw",
  "sweden",
  "stockholm",
  "norway",
  "oslo",
  "denmark",
  "copenhagen",
  "finland",
  "helsinki",
  "greece",
  "athens",
  "portugal",
  "lisbon",
  "ireland",
  "dublin",
  "switzerland",
  "zurich",
  "europe",
  "european",
  "europa",
  "eu",
  "uk",
  "united kingdom",
  "london",
]);

export function titleSuggestsEuropeana(videoTitle?: string): boolean {
  const hay = asVideoTitleString(videoTitle).toLowerCase();
  if (!hay.trim()) return false;
  if (/\beurope|eu\b|nederland|holland|berlin|amsterdam|brussels|paris/i.test(hay)) return true;
  const tags = extractTitleGeoPlaceTags(videoTitle);
  return tags.some((t) => EU_GEO_HINTS.has(t.toLowerCase()));
}

export function buildEuropeanaBeatQueries(
  beatText: string,
  videoTitle?: string
): string[] {
  const titleGeo = extractTitleGeoPlaceTags(videoTitle).slice(0, 3);
  const queries = [
    ...titleGeo.map((t) => `${t} city documentary`),
    ...titleGeo.map((t) => `${t} urban aerial`),
    `${beatText.slice(0, 60)} documentary`,
    `${beatText.slice(0, 40)} news archive`,
  ];
  return [...new Set(
    queries
      .map((q) => toQueryString(q))
      .filter((q) => q.length >= 4)
  )].slice(0, 6);
}
