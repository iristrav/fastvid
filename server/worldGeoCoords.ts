/**
 * Lat/lon lookup for Wikimedia Commons geosearch (city slug → coordinates).
 */
import { ALL_GEO_SLUGS } from "./worldGeoSlugs";

export type GeoCoord = { lat: number; lon: number };

/** Major cities / places — extend as needed; unknown slugs fall back to Nominatim-free heuristics. */
const CITY_COORDS: Record<string, GeoCoord> = {
  singapore: { lat: 1.3521, lon: 103.8198 },
  netherlands: { lat: 52.1326, lon: 5.2913 },
  holland: { lat: 52.1326, lon: 5.2913 },
  dutch: { lat: 52.1326, lon: 5.2913 },
  nederland: { lat: 52.1326, lon: 5.2913 },
  amsterdam: { lat: 52.3676, lon: 4.9041 },
  rotterdam: { lat: 51.9244, lon: 4.4777 },
  "the hague": { lat: 52.0705, lon: 4.3007 },
  "den haag": { lat: 52.0705, lon: 4.3007 },
  utrecht: { lat: 52.0907, lon: 5.1214 },
  eindhoven: { lat: 51.4416, lon: 5.4697 },
  groningen: { lat: 53.2194, lon: 6.5665 },
  maastricht: { lat: 50.8514, lon: 5.691 },
  berlin: { lat: 52.52, lon: 13.405 },
  germany: { lat: 51.1657, lon: 10.4515 },
  munich: { lat: 48.1351, lon: 11.582 },
  hamburg: { lat: 53.5511, lon: 9.9937 },
  paris: { lat: 48.8566, lon: 2.3522 },
  france: { lat: 46.2276, lon: 2.2137 },
  london: { lat: 51.5074, lon: -0.1278 },
  "united kingdom": { lat: 55.3781, lon: -3.436 },
  uk: { lat: 55.3781, lon: -3.436 },
  rome: { lat: 41.9028, lon: 12.4964 },
  italy: { lat: 41.8719, lon: 12.5674 },
  madrid: { lat: 40.4168, lon: -3.7038 },
  spain: { lat: 40.4637, lon: -3.7492 },
  brussels: { lat: 50.8503, lon: 4.3517 },
  belgium: { lat: 50.5039, lon: 4.4699 },
  vienna: { lat: 48.2082, lon: 16.3738 },
  austria: { lat: 47.5162, lon: 14.5501 },
  warsaw: { lat: 52.2297, lon: 21.0122 },
  poland: { lat: 51.9194, lon: 19.1451 },
  prague: { lat: 50.0755, lon: 14.4378 },
  stockholm: { lat: 59.3293, lon: 18.0686 },
  oslo: { lat: 59.9139, lon: 10.7522 },
  copenhagen: { lat: 55.6761, lon: 12.5683 },
  helsinki: { lat: 60.1699, lon: 24.9384 },
  athens: { lat: 37.9838, lon: 23.7275 },
  lisbon: { lat: 38.7223, lon: -9.1393 },
  dublin: { lat: 53.3498, lon: -6.2603 },
  zurich: { lat: 47.3769, lon: 8.5417 },
  geneva: { lat: 46.2044, lon: 6.1432 },
  "united states": { lat: 39.8283, lon: -98.5795 },
  usa: { lat: 39.8283, lon: -98.5795 },
  america: { lat: 39.8283, lon: -98.5795 },
  "new york": { lat: 40.7128, lon: -74.006 },
  "new york city": { lat: 40.7128, lon: -74.006 },
  nyc: { lat: 40.7128, lon: -74.006 },
  philadelphia: { lat: 39.9526, lon: -75.1652 },
  "los angeles": { lat: 34.0522, lon: -118.2437 },
  chicago: { lat: 41.8781, lon: -87.6298 },
  houston: { lat: 29.7604, lon: -95.3698 },
  phoenix: { lat: 33.4484, lon: -112.074 },
  "san francisco": { lat: 37.7749, lon: -122.4194 },
  seattle: { lat: 47.6062, lon: -122.3321 },
  boston: { lat: 42.3601, lon: -71.0589 },
  miami: { lat: 25.7617, lon: -80.1918 },
  dallas: { lat: 32.7767, lon: -96.797 },
  "washington dc": { lat: 38.9072, lon: -77.0369 },
  tokyo: { lat: 35.6762, lon: 139.6503 },
  japan: { lat: 36.2048, lon: 138.2529 },
  beijing: { lat: 39.9042, lon: 116.4074 },
  shanghai: { lat: 31.2304, lon: 121.4737 },
  china: { lat: 35.8617, lon: 104.1954 },
  "hong kong": { lat: 22.3193, lon: 114.1694 },
  seoul: { lat: 37.5665, lon: 126.978 },
  "south korea": { lat: 35.9078, lon: 127.7669 },
  mumbai: { lat: 19.076, lon: 72.8777 },
  delhi: { lat: 28.7041, lon: 77.1025 },
  india: { lat: 20.5937, lon: 78.9629 },
  bangkok: { lat: 13.7563, lon: 100.5018 },
  thailand: { lat: 15.87, lon: 100.9925 },
  jakarta: { lat: -6.2088, lon: 106.8456 },
  indonesia: { lat: -0.7893, lon: 113.9213 },
  sydney: { lat: -33.8688, lon: 151.2093 },
  melbourne: { lat: -37.8136, lon: 144.9631 },
  australia: { lat: -25.2744, lon: 133.7751 },
  toronto: { lat: 43.6532, lon: -79.3832 },
  vancouver: { lat: 49.2827, lon: -123.1207 },
  canada: { lat: 56.1304, lon: -106.3468 },
  "mexico city": { lat: 19.4326, lon: -99.1332 },
  mexico: { lat: 23.6345, lon: -102.5528 },
  "sao paulo": { lat: -23.5505, lon: -46.6333 },
  brazil: { lat: -14.235, lon: -51.9253 },
  buenos_aires: { lat: -34.6037, lon: -58.3816 },
  "buenos aires": { lat: -34.6037, lon: -58.3816 },
  cairo: { lat: 30.0444, lon: 31.2357 },
  egypt: { lat: 26.8206, lon: 30.8025 },
  dubai: { lat: 25.2048, lon: 55.2708 },
  "united arab emirates": { lat: 23.4241, lon: 53.8478 },
  istanbul: { lat: 41.0082, lon: 28.9784 },
  turkey: { lat: 38.9637, lon: 35.2433 },
  moscow: { lat: 55.7558, lon: 37.6173 },
  russia: { lat: 61.524, lon: 105.3188 },
  kyiv: { lat: 50.4501, lon: 30.5234 },
  ukraine: { lat: 48.3794, lon: 31.1656 },
  johannesburg: { lat: -26.2041, lon: 28.0473 },
  "south africa": { lat: -30.5595, lon: 22.9375 },
  nairobi: { lat: -1.2921, lon: 36.8219 },
  kenya: { lat: -0.0236, lon: 37.9062 },
};

export function lookupGeoCoord(slug: string): GeoCoord | null {
  const key = slug.toLowerCase().trim();
  if (CITY_COORDS[key]) return CITY_COORDS[key]!;
  for (const [k, v] of Object.entries(CITY_COORDS)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return null;
}

/** Resolve coordinates for title/geo slugs (first hit wins). */
export function coordsForGeoSlugs(slugs: string[]): GeoCoord | null {
  for (const slug of slugs) {
    const c = lookupGeoCoord(slug);
    if (c) return c;
  }
  return null;
}

export function isKnownGeoSlug(slug: string): boolean {
  const key = slug.toLowerCase().trim();
  return key in CITY_COORDS || ALL_GEO_SLUGS.includes(key);
}
