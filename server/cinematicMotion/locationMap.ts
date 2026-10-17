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
  // VIDEO 663 — the places documentaries name most; Brussels/Belgium was missing (render 73 was "Los Angeles vs Belgium").
  // Names only, no nationality adjectives: "the old Spanish plaza" in Los Angeles is not a map of Spain (test film).
  { name: "Brussels, Belgium", keywords: ["brussels", "bruxelles", "brussel", "belgium", "flanders", "wallonia"], normX: 0.512, normY: 0.261, lon: 4.35, lat: 50.85, iso3: "BEL", area: { name: "Belgium", keywords: ["belgium", "flanders", "wallonia"] } },
  { name: "Madrid, Spain", keywords: ["madrid", "spain"], normX: 0.49, normY: 0.31, lon: -3.7, lat: 40.42, iso3: "ESP", area: { name: "Spain", keywords: ["spain"] } },
  { name: "Barcelona, Spain", keywords: ["barcelona", "catalonia"], normX: 0.506, normY: 0.305, lon: 2.17, lat: 41.39, iso3: "ESP", area: { name: "Catalonia", keywords: ["catalonia"] } },
  { name: "Lisbon, Portugal", keywords: ["lisbon", "portugal"], normX: 0.475, normY: 0.318, lon: -9.14, lat: 38.72, iso3: "PRT", area: { name: "Portugal", keywords: ["portugal"] } },
  { name: "Vienna, Austria", keywords: ["vienna", "austria"], normX: 0.545, normY: 0.273, lon: 16.37, lat: 48.21, iso3: "AUT", area: { name: "Austria", keywords: ["austria"] } },
  { name: "Bern, Switzerland", keywords: ["bern", "switzerland", "zurich", "geneva"], normX: 0.521, normY: 0.279, lon: 7.45, lat: 46.95, iso3: "CHE", area: { name: "Switzerland", keywords: ["switzerland"] } },
  { name: "Stockholm, Sweden", keywords: ["stockholm", "sweden"], normX: 0.55, normY: 0.221, lon: 18.07, lat: 59.33, iso3: "SWE", area: { name: "Sweden", keywords: ["sweden"] } },
  { name: "Oslo, Norway", keywords: ["oslo", "norway"], normX: 0.53, normY: 0.218, lon: 10.75, lat: 59.91, iso3: "NOR", area: { name: "Norway", keywords: ["norway"] } },
  { name: "Copenhagen, Denmark", keywords: ["copenhagen", "denmark"], normX: 0.535, normY: 0.238, lon: 12.57, lat: 55.68, iso3: "DNK", area: { name: "Denmark", keywords: ["denmark"] } },
  { name: "Helsinki, Finland", keywords: ["helsinki", "finland"], normX: 0.569, normY: 0.217, lon: 24.94, lat: 60.17, iso3: "FIN", area: { name: "Finland", keywords: ["finland"] } },
  { name: "Dublin, Ireland", keywords: ["dublin", "ireland"], normX: 0.483, normY: 0.249, lon: -6.26, lat: 53.35, iso3: "IRL", area: { name: "Ireland", keywords: ["ireland"] } },
  { name: "Athens, Greece", keywords: ["athens", "greece"], normX: 0.566, normY: 0.321, lon: 23.73, lat: 37.98, iso3: "GRC", area: { name: "Greece", keywords: ["greece"] } },
  { name: "Prague, Czechia", keywords: ["prague", "czechia"], normX: 0.54, normY: 0.265, lon: 14.42, lat: 50.08, iso3: "CZE", area: { name: "Czechia", keywords: ["czechia"] } },
  { name: "Budapest, Hungary", keywords: ["budapest", "hungary"], normX: 0.553, normY: 0.277, lon: 19.04, lat: 47.5, iso3: "HUN", area: { name: "Hungary", keywords: ["hungary"] } },
  { name: "Istanbul, Türkiye", keywords: ["istanbul", "türkiye", "ankara"], normX: 0.581, normY: 0.307, lon: 28.98, lat: 41.01, iso3: "TUR", area: { name: "Türkiye", keywords: ["türkiye"] } },
  { name: "Mexico City", keywords: ["mexico city", "mexico"], normX: 0.225, normY: 0.409, lon: -99.13, lat: 19.43, iso3: "MEX", area: { name: "Mexico", keywords: ["mexico"] } },
  { name: "Toronto, Canada", keywords: ["toronto", "canada", "ottawa", "montreal", "vancouver"], normX: 0.28, normY: 0.295, lon: -79.38, lat: 43.65, iso3: "CAN", area: { name: "Canada", keywords: ["canada"] } },
  { name: "Chicago", keywords: ["chicago"], normX: 0.257, normY: 0.303, lon: -87.63, lat: 41.88, iso3: "USA" },
  { name: "San Francisco", keywords: ["san francisco", "silicon valley"], normX: 0.16, normY: 0.322, lon: -122.42, lat: 37.77, iso3: "USA" },
  { name: "Miami", keywords: ["miami", "florida"], normX: 0.277, normY: 0.379, lon: -80.19, lat: 25.76, iso3: "USA", area: { name: "Florida", keywords: ["florida"] } },
  { name: "Rio de Janeiro, Brazil", keywords: ["rio de janeiro", "brazil", "são paulo", "sao paulo"], normX: 0.38, normY: 0.608, lon: -43.17, lat: -22.91, iso3: "BRA", area: { name: "Brazil", keywords: ["brazil"] } },
  { name: "Buenos Aires, Argentina", keywords: ["buenos aires", "argentina"], normX: 0.338, normY: 0.663, lon: -58.38, lat: -34.6, iso3: "ARG", area: { name: "Argentina", keywords: ["argentina"] } },
  { name: "Mumbai, India", keywords: ["mumbai", "india", "delhi", "new delhi"], normX: 0.702, normY: 0.41, lon: 72.88, lat: 19.08, iso3: "IND", area: { name: "India", keywords: ["india"] } },
  { name: "Seoul, South Korea", keywords: ["seoul", "south korea"], normX: 0.853, normY: 0.323, lon: 126.98, lat: 37.57, iso3: "KOR", area: { name: "South Korea", keywords: ["south korea"] } },
  { name: "Singapore", keywords: ["singapore"], normX: 0.788, normY: 0.494, lon: 103.82, lat: 1.35, iso3: "SGP" },
  { name: "Bangkok, Thailand", keywords: ["bangkok", "thailand"], normX: 0.779, normY: 0.435, lon: 100.5, lat: 13.76, iso3: "THA", area: { name: "Thailand", keywords: ["thailand"] } },
  { name: "Shanghai, China", keywords: ["shanghai"], normX: 0.837, normY: 0.353, lon: 121.47, lat: 31.23, iso3: "CHN" },
  { name: "Hong Kong", keywords: ["hong kong"], normX: 0.817, normY: 0.395, lon: 114.17, lat: 22.32, iso3: "CHN" },
  { name: "Dubai, UAE", keywords: ["dubai", "abu dhabi", "emirates"], normX: 0.654, normY: 0.382, lon: 55.27, lat: 25.2, iso3: "ARE", area: { name: "United Arab Emirates", keywords: ["emirates"] } },
  { name: "Riyadh, Saudi Arabia", keywords: ["riyadh", "saudi arabia"], normX: 0.63, normY: 0.384, lon: 46.68, lat: 24.71, iso3: "SAU", area: { name: "Saudi Arabia", keywords: ["saudi arabia"] } },
  { name: "Sydney, Australia", keywords: ["sydney", "australia", "melbourne"], normX: 0.92, normY: 0.659, lon: 151.21, lat: -33.87, iso3: "AUS", area: { name: "Australia", keywords: ["australia"] } },
  { name: "Lagos, Nigeria", keywords: ["lagos", "nigeria"], normX: 0.509, normY: 0.469, lon: 3.38, lat: 6.52, iso3: "NGA", area: { name: "Nigeria", keywords: ["nigeria"] } },
  { name: "Nairobi, Kenya", keywords: ["nairobi", "kenya"], normX: 0.602, normY: 0.506, lon: 36.82, lat: -1.29, iso3: "KEN", area: { name: "Kenya", keywords: ["kenya"] } },
];
