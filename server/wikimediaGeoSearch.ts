/**
 * Wikimedia Commons geosearch — GPS-anchored images near title city (free API).
 */
import { lookupGeoCoord } from "./worldGeoCoords";
import { extractTitleGeoPlaceTags } from "./worldGeoSlugs";
import { searchGateDecision } from "./searchQueryContract";

const UA = { "User-Agent": "Fastvid/1.0 (video generation; geosearch)" };

export function wikimediaGeosearchEnabled(): boolean {
  return process.env.ENABLE_WIKIMEDIA_GEOSEARCH !== "false";
}

type GeoSearchItem = { title: string; dist?: number };

/** Commons geosearch within radius meters (default 12 km). */
export async function fetchWikimediaGeoImageTitles(
  placeSlug: string,
  limit = 10,
  radiusM = 12_000
): Promise<string[]> {
  const coord = lookupGeoCoord(placeSlug);
  if (!coord) return [];
  /**
   * RONDE 91 (§4) — a coordinate is a content claim wearing a different coat.
   *
   * This request carries no words, so it looked exempt: no query string, nothing to validate. But
   * the latitude and longitude are looked up FROM `placeSlug`, and that slug is derived from the
   * video's title (fetchWikimediaTitlesForVideoGeo below). §8 is explicit that a title is not
   * evidence — so a geosearch anchored on a title-derived place asks Commons for pictures of a
   * place the script may never mention, which is exactly the claim the invariant forbids. It is
   * gated on the place name, because that name is what the request actually asserts.
   */
  if (!searchGateDecision("wikimedia", placeSlug.replace(/[-_]+/g, " "), "wikimediaGeosearch").admitted) {
    return [];
  }

  const gscoord = `${coord.lat}|${coord.lon}`;
  const url =
    `https://commons.wikimedia.org/w/api.php?action=query&list=geosearch` +
    `&gscoord=${encodeURIComponent(gscoord)}&gsradius=${radiusM}&gslimit=${limit}` +
    `&gsnamespace=6&gsprop=type|dist&format=json&origin=*`;

  try {
    const resp = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { query?: { geosearch?: GeoSearchItem[] } };
    return (data.query?.geosearch ?? [])
      .map((g) => g.title)
      .filter((t) => t && /File:/i.test(t));
  } catch {
    return [];
  }
}

/** Build geosearch title list from video title geography. */
export async function fetchWikimediaTitlesForVideoGeo(
  videoTitle?: string,
  limitPerPlace = 6
): Promise<string[]> {
  if (!wikimediaGeosearchEnabled()) return [];
  const places = extractTitleGeoPlaceTags(videoTitle).slice(0, 3);
  if (places.length === 0) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const place of places) {
    const titles = await fetchWikimediaGeoImageTitles(place, limitPerPlace);
    for (const t of titles) {
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out.slice(0, 18);
}
