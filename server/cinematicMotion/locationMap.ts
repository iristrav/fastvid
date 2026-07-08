// Normalised world coordinates (0–1) for common locations
// normX = longitude mapped 0(180°W) → 1(180°E)
// normY = latitude mapped 0(90°N)  → 1(90°S)

export interface WorldLocation {
  name: string;
  keywords: string[];
  normX: number;
  normY: number;
}

export const WORLD_LOCATIONS: WorldLocation[] = [
  // Europe
  { name: "Normandy, France",   keywords: ["normandy", "normandie", "d-day", "omaha beach", "utah beach"],  normX: 0.505, normY: 0.278 },
  { name: "Paris, France",      keywords: ["paris", "france", "french"],                                    normX: 0.506, normY: 0.270 },
  { name: "Berlin, Germany",    keywords: ["berlin", "germany", "german", "deutschland"],                   normX: 0.525, normY: 0.255 },
  { name: "London, UK",         keywords: ["london", "britain", "england", "uk"],                           normX: 0.495, normY: 0.258 },
  { name: "Moscow, Russia",     keywords: ["moscow", "russia", "russian", "kremlin"],                       normX: 0.567, normY: 0.228 },
  { name: "Rome, Italy",        keywords: ["rome", "italy", "italian"],                                     normX: 0.523, normY: 0.287 },
  { name: "Warsaw, Poland",     keywords: ["warsaw", "poland", "polish"],                                   normX: 0.534, normY: 0.254 },
  { name: "Amsterdam",          keywords: ["amsterdam", "netherlands", "dutch", "holland"],                 normX: 0.508, normY: 0.255 },
  { name: "Kyiv, Ukraine",      keywords: ["kyiv", "kiev", "ukraine", "ukrainian"],                        normX: 0.548, normY: 0.252 },
  // Americas
  { name: "Washington D.C.",    keywords: ["washington", "white house", "pentagon", "d.c."],               normX: 0.287, normY: 0.297 },
  { name: "New York",           keywords: ["new york", "manhattan", "wall street"],                        normX: 0.294, normY: 0.292 },
  { name: "Los Angeles",        keywords: ["los angeles", "hollywood", "california"],                      normX: 0.190, normY: 0.320 },
  { name: "Washington",         keywords: ["united states", "usa", "america", "american"],                 normX: 0.287, normY: 0.297 },
  // Middle East & Asia
  { name: "Jerusalem, Israel",  keywords: ["jerusalem", "israel", "gaza", "tel aviv", "palestin"],        normX: 0.570, normY: 0.318 },
  { name: "Baghdad, Iraq",      keywords: ["baghdad", "iraq", "iraqi"],                                    normX: 0.583, normY: 0.320 },
  { name: "Tehran, Iran",       keywords: ["tehran", "iran", "iranian"],                                   normX: 0.593, normY: 0.305 },
  { name: "Beijing, China",     keywords: ["beijing", "china", "chinese"],                                 normX: 0.710, normY: 0.293 },
  { name: "Tokyo, Japan",       keywords: ["tokyo", "japan", "japanese"],                                  normX: 0.770, normY: 0.295 },
  { name: "Kabul, Afghanistan", keywords: ["kabul", "afghanistan"],                                        normX: 0.620, normY: 0.307 },
  // Africa
  { name: "Cairo, Egypt",       keywords: ["cairo", "egypt", "egyptian"],                                  normX: 0.553, normY: 0.330 },
  { name: "Johannesburg",       keywords: ["south africa", "johannesburg"],                                normX: 0.550, normY: 0.470 },
  // Pacific / Oceania
  { name: "Hiroshima, Japan",   keywords: ["hiroshima", "nagasaki"],                                       normX: 0.762, normY: 0.307 },
  { name: "Pearl Harbor",       keywords: ["pearl harbor", "hawaii"],                                      normX: 0.126, normY: 0.362 },
];
