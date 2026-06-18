/**
 * Wikimedia Commons geosearch — GPS-anchored images near title city (free API).
 */
import { lookupGeoCoord } from "./worldGeoCoords";
import { extractTitleGeoPlaceTags } from "./worldGeoSlugs";

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
