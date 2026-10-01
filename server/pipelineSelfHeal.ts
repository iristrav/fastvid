/**
 * Geo stock queries, script expansion, and the pre-render refusal of an indefensible render.
 */
import { hasContentAnchor } from "./searchQueryContract";

/** Pexels/Pixabay queries anchored to beat + title geography (wrong-country stock avoided). */
export function buildDocumentaryShotQueries(baseQuery: string, beatIndex: number): string[] {
  const q = baseQuery.trim();
  if (q.length < 4) return [];
  /**
   * RONDE 88A P4 — a camera instruction needs something to point at.
   *
   * Every variant below is `<subject> <shot vocabulary>`, so the whole query is only as much of a
   * question as its subject. When the subject has already collapsed to a genre word upstream —
   * `stubPowerWordFromSceneText` ends in `|| "documentary"`, and so do two of the archive pool's
   * own fallbacks — this produced "documentary wide establishing aerial", which asks for aerial
   * footage of the world in general.
   *
   * Render 568 built 128 such queries and the gate refused all 128: documentary x68,
   * establishing x40, historical x20. The gate was right every time; being right 128 times after
   * the work is done is not the same as the work not being done. `hasContentAnchor` is that same
   * check, asked here first — the length test above was the only thing this ever asked, and
   * "documentary" is ten characters long.
   *
   * Returning nothing is the honest answer, and the one RONDE 100B already established for the
   * same situation: "nothing left, so ask for nothing". Every caller of this function spreads the
   * result into a list, so an empty answer asks one fewer provider rather than asking wrongly.
   */
  if (!hasContentAnchor(q)) return [];
  const variants = [
    `${q} wide establishing aerial`,
    `${q} medium street level documentary`,
    `${q} detail close up architecture`,
  ];
  const start = beatIndex % variants.length;
  return [variants[start]!, variants[(start + 1) % variants.length]!];
}

export type ScriptExpandFn = (userPrompt: string) => Promise<string>;

