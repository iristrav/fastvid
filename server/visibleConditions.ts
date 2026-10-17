/**
 * VIDEO 663 — A PICTURE THAT SHOWS THE OPPOSITE OF WHAT THE LINE SAYS.
 *
 * Render 72, s1b2: "Los Angeles basks under relentless sun, inviting beachgoers year-round." The
 * picture editor refused a frame — depicts="A night scene on a Los Angeles street with
 * graffiti-covered shutters", reason "…doesn't match the narration about the city basking under
 * relentless sun" — and the abstract-line rule (beatImageRelevanceGate) admitted it as b-roll: its
 * contradiction words name a title card or another country, not night under a line about sun. The
 * viewer heard "sun" over a night street.
 *
 * Some things every viewer sees at once, whatever the subject: day or night, sun or rain, summer or
 * snow. When the line says one and what the picture shows (the model's own `depicts`) says the
 * other, the picture contradicts the line. Deliberately narrow: only these visible conditions, only
 * words, and only the frame's own description — "unlike a night scene" in a reason decides nothing.
 */

type Condition = { name: string; line: RegExp; clashesWith: RegExp };

const w = (words: string): RegExp => new RegExp(`\\b(?:${words})\\b`, "i");

const CONDITIONS: Condition[] = [
  {
    name: "daylight",
    line: w("sun|suns|sunny|sunshine|sunlit|sunlight|sun-drenched|sun-soaked|daylight|daytime|midday|noon|broad day|bright day"),
    clashesWith: w("night|nighttime|night-time|at night|midnight|after dark|darkness|neon-lit|moonlit|moonlight"),
  },
  {
    name: "night",
    line: w("night|nighttime|night-time|midnight|after dark|moonlit|moonlight"),
    clashesWith: w("daylight|daytime|midday|noon|sunny|sunshine|sunlit|bright sun|broad daylight"),
  },
  {
    name: "rain or grey skies",
    line: w("rain|rains|rainy|raining|rainfall|drizzle|drizzling|downpour|storm|stormy|overcast|grey skies|gray skies|grey sky|gray sky|fog|foggy|mist|misty|shrouded|umbrellas?"),
    clashesWith: w("clear skies|clear sky|cloudless|blue skies|blue sky|sunny|sunshine|bright sun|sun-drenched"),
  },
  {
    name: "snow or winter cold",
    line: w("snow|snows|snowy|snowfall|snow-covered|blizzard|frozen|freezing|icy|frost|frosty"),
    clashesWith: w("summer|beach|beaches|sunbathing|sunbathers|swimsuits?|palm trees?|tropical|heatwave"),
  },
  {
    name: "summer heat or the beach",
    line: w("summer|heatwave|heat wave|scorching|beach|beaches|beachgoers|sunbathing|sunbathers|tropical"),
    clashesWith: w("snow|snowy|snow-covered|snowfall|blizzard|frozen|icy|winter coats?"),
  },
];

/**
 * The condition the line names that the picture shows the opposite of, as `"daylight vs night"`,
 * or null. `saw` is what the picture editor said the frame shows (`depicts`).
 */
export function conditionClash(lineText: string | null | undefined, saw: string | null | undefined): string | null {
  const line = lineText ?? "";
  const seen = saw ?? "";
  if (!line.trim() || !seen.trim()) return null;
  for (const c of CONDITIONS) {
    if (!c.line.test(line)) continue;
    const hit = seen.match(c.clashesWith);
    /** the frame shows both (a sunny day that ends at night): not a contradiction */
    if (hit && !c.line.test(seen)) return `${c.name} vs "${hit[0].toLowerCase()}"`;
  }
  return null;
}
