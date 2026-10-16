// Normalised world coordinates (0–1) for common locations
// normX = longitude mapped 0(180°W) → 1(180°E)
// normY = latitude mapped 0(90°N)  → 1(90°S)
//
// OCTOBER 2026 — every place also carries its real longitude and latitude and the ISO 3166 alpha-3
// code of its country, so the map graphic can draw the real coastline (Natural Earth, bundled with
// the Remotion composition) and highlight the country. normX/normY stay for the abstract map and
// for every payload written before this; they were hand-placed and are not precise.

export interface WorldLocation {
  name: string;
  keywords: string[];
  normX: number;
  normY: number;
  lon: number;
  lat: number;
  /** The country to highlight, as Natural Earth's ADM0_A3 spells it. */
  iso3: string;
  /**
   * VIDEO 661 — the wider place some keywords name. "the Netherlands" is not Amsterdam: render 70
   * pinned "Amsterdam" under a sentence that only said the country. When the keyword the sentence
   * says is one of these, the map names `area.name` — the place the voice said — not the city.
   */
  area?: { name: string; keywords: string[] };
}

/**
 * Whether the text says this keyword as a whole word ("uk" is not in "ukraine"). `lowerText` is
 * already lower-case. Shared by the map planner and the location tag, so both read a place the same way.
 */
export function saysWholeWord(lowerText: string, keyword: string): boolean {
  const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(lowerText);
}

/** VIDEO 661 — the name the map writes for a location found by `keyword`: the city, or the area the voice said. */
export function spokenLocationName(loc: WorldLocation, keyword: string): string {
  return loc.area?.keywords.includes(keyword) ? loc.area.name : loc.name;
}

export const WORLD_LOCATIONS: WorldLocation[] = [
  // Europe
  { name: "Normandy, France",   keywords: ["normandy", "normandie", "d-day", "omaha beach", "utah beach"],  normX: 0.505, normY: 0.278, lon: -0.37, lat: 49.18, iso3: "FRA" },
  { name: "Paris, France",      keywords: ["paris", "france", "french"],                                    normX: 0.506, normY: 0.270, lon: 2.35, lat: 48.86, iso3: "FRA", area: { name: "France", keywords: ["france", "french"] } },
  { name: "Berlin, Germany",    keywords: ["berlin", "germany", "german", "deutschland"],                   normX: 0.525, normY: 0.255, lon: 13.40, lat: 52.52, iso3: "DEU", area: { name: "Germany", keywords: ["germany", "german", "deutschland"] } },
  { name: "London, UK",         keywords: ["london", "britain", "england", "uk"],                           normX: 0.495, normY: 0.258, lon: -0.13, lat: 51.51, iso3: "GBR", area: { name: "United Kingdom", keywords: ["britain", "england", "uk"] } },
  { name: "Moscow, Russia",     keywords: ["moscow", "russia", "russian", "kremlin"],                       normX: 0.567, normY: 0.228, lon: 37.62, lat: 55.76, iso3: "RUS", area: { name: "Russia", keywords: ["russia", "russian"] } },
  { name: "Rome, Italy",        keywords: ["rome", "italy", "italian"],                                     normX: 0.523, normY: 0.287, lon: 12.50, lat: 41.90, iso3: "ITA", area: { name: "Italy", keywords: ["italy", "italian"] } },
  { name: "Warsaw, Poland",     keywords: ["warsaw", "poland", "polish"],                                   normX: 0.534, normY: 0.254, lon: 21.01, lat: 52.23, iso3: "POL", area: { name: "Poland", keywords: ["poland", "polish"] } },
  { name: "Amsterdam",          keywords: ["amsterdam", "netherlands", "dutch", "holland"],                 normX: 0.508, normY: 0.255, lon: 4.90, lat: 52.37, iso3: "NLD", area: { name: "Netherlands", keywords: ["netherlands", "dutch", "holland"] } },
  { name: "Kyiv, Ukraine",      keywords: ["kyiv", "kiev", "ukraine", "ukrainian"],                        normX: 0.548, normY: 0.252, lon: 30.52, lat: 50.45, iso3: "UKR", area: { name: "Ukraine", keywords: ["ukraine", "ukrainian"] } },
  // Americas
  { name: "Washington D.C.",    keywords: ["washington", "white house", "pentagon", "d.c."],               normX: 0.287, normY: 0.297, lon: -77.04, lat: 38.91, iso3: "USA" },
  { name: "New York",           keywords: ["new york", "manhattan", "wall street"],                        normX: 0.294, normY: 0.292, lon: -74.01, lat: 40.71, iso3: "USA" },
  { name: "Los Angeles",        keywords: ["los angeles", "hollywood", "california"],                      normX: 0.190, normY: 0.320, lon: -118.24, lat: 34.05, iso3: "USA", area: { name: "California", keywords: ["california"] } },
  { name: "Washington",         keywords: ["united states", "usa", "america", "american"],                 normX: 0.287, normY: 0.297, lon: -77.04, lat: 38.91, iso3: "USA", area: { name: "United States", keywords: ["united states", "usa", "america", "american"] } },
  // Middle East & Asia
  { name: "Jerusalem, Israel",  keywords: ["jerusalem", "israel"],                                      normX: 0.570, normY: 0.318, lon: 35.21, lat: 31.77, iso3: "ISR", area: { name: "Israel", keywords: ["israel"] } },
  { name: "Baghdad, Iraq",      keywords: ["baghdad", "iraq", "iraqi"],                                    normX: 0.583, normY: 0.320, lon: 44.37, lat: 33.31, iso3: "IRQ", area: { name: "Iraq", keywords: ["iraq", "iraqi"] } },
  { name: "Tehran, Iran",       keywords: ["tehran", "iran", "iranian"],                                   normX: 0.593, normY: 0.305, lon: 51.39, lat: 35.69, iso3: "IRN", area: { name: "Iran", keywords: ["iran", "iranian"] } },
  { name: "Beijing, China",     keywords: ["beijing", "china", "chinese"],                                 normX: 0.710, normY: 0.293, lon: 116.41, lat: 39.90, iso3: "CHN", area: { name: "China", keywords: ["china", "chinese"] } },
  { name: "Tokyo, Japan",       keywords: ["tokyo", "japan", "japanese"],                                  normX: 0.770, normY: 0.295, lon: 139.69, lat: 35.69, iso3: "JPN", area: { name: "Japan", keywords: ["japan", "japanese"] } },
  { name: "Kabul, Afghanistan", keywords: ["kabul", "afghanistan"],                                        normX: 0.620, normY: 0.307, lon: 69.21, lat: 34.56, iso3: "AFG", area: { name: "Afghanistan", keywords: ["afghanistan"] } },
  // Africa
  { name: "Cairo, Egypt",       keywords: ["cairo", "egypt", "egyptian"],                                  normX: 0.553, normY: 0.330, lon: 31.24, lat: 30.04, iso3: "EGY", area: { name: "Egypt", keywords: ["egypt", "egyptian"] } },
  { name: "Johannesburg",       keywords: ["south africa", "johannesburg"],                                normX: 0.550, normY: 0.470, lon: 28.05, lat: -26.20, iso3: "ZAF", area: { name: "South Africa", keywords: ["south africa"] } },
  // Pacific / Oceania
  { name: "Hiroshima, Japan",   keywords: ["hiroshima", "nagasaki"],                                       normX: 0.762, normY: 0.307, lon: 132.46, lat: 34.39, iso3: "JPN", area: { name: "Japan", keywords: ["nagasaki"] } },
  { name: "Pearl Harbor",       keywords: ["pearl harbor", "hawaii"],                                      normX: 0.126, normY: 0.362, lon: -157.95, lat: 21.35, iso3: "USA", area: { name: "Hawaii", keywords: ["hawaii"] } },
];
