/**
 * RONDE 123 — the person extractor could not read a diacritic, and that one gap did three things
 * at once.
 *
 * From the render of "The real reason Hermann Göring joined Hitler", the log printed:
 *
 *     [persons: Adolf Hitler, Carin, Join Hitler, Influential Choice Hermann]
 *
 * Two of those are not people, and the film's actual subject is missing. All three symptoms come
 * from the same character class. Every name pattern in the pipeline was written as
 *
 *     /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/
 *
 * and `[a-z]` does not contain `ö`. So in a Title Case line like
 *
 *     "The Influential Choice Hermann Göring Made To Join Hitler"
 *
 * the run does not merely lose Göring — it BREAKS THERE, and the two halves are then matched
 * separately. Measured:
 *
 *     current  →  ["The Influential Choice Hermann", "Made To Join Hitler"]
 *     fixed    →  ["The Influential Choice Hermann Göring Made To Join Hitler"]
 *
 * After the framing words are split off, the first list yields exactly the two fabricated names
 * from production and no real one. The diacritic did not just delete Hermann Göring; it
 * MANUFACTURED "Influential Choice Hermann" and "Join Hitler" by cutting the sentence in half at
 * the one point where both halves look like names.
 *
 * The second half of the same bug is the cleaning step in front of those patterns:
 *
 *     text.replace(/[^\w\s:'-]/g, " ")
 *
 * `\w` is ASCII too, so "Göring" arrives at the pattern as "G ring" — a name already destroyed
 * before any matching happens.
 *
 * ── What this module is ──────────────────────────────────────────────────────────────────────
 *
 * The character classes those patterns should have used, in one place, so the answer to "which
 * letters can appear in a person's name" is stated once instead of re-typed at six call sites.
 * It changes only which CHARACTERS count as letters. Every downstream judgement — the framing-word
 * split, checkPersonName's grammar rules, the thing/place vetoes, the historical blocklist — is
 * untouched and still runs on whatever this lets through.
 */

/**
 * Upper- and lower-case letters as Unicode understands them.
 *
 * `\p{Lu}` / `\p{Ll}` rather than a hand-written range: a list of accented characters is a list
 * somebody has to remember to extend, and this pipeline already learned that lesson from
 * TITLE_NON_NAME_WORDS. Names reach it in Latin, Cyrillic and Greek script.
 */
export const NAME_UPPER = "\\p{Lu}";
/** Lower-case letters and the combining marks that sit on them. */
export const NAME_REST = "[\\p{Ll}\\p{M}]";
/** Both apostrophes real names are written with. */
const NAME_APOSTROPHE = "['’]";

/**
 * One capitalised token: "Hermann", "Göring", "O'Neill", "Ben-Gurion", "Đoković".
 *
 * Three parts, each earning its place:
 *
 *  · an optional single-letter prefix with an apostrophe, for "O'Neill" and "D'Angelo";
 *  · a capital followed by at least one lower-case letter — the same requirement `[A-Z][a-z]+`
 *    made, so a lone initial is still not a name and "BRAUN" is still not a name;
 *  · further segments after an apostrophe or hyphen, for "Ben-Gurion" and "Sant'Anna".
 *
 * The capital is allowed only immediately after an apostrophe or hyphen, never mid-word, so
 * "McDonald" is still refused exactly as it was before — this widens the alphabet, not the rules.
 *
 * A segment after an APOSTROPHE must begin with a capital, and that requirement is load-bearing
 * rather than tidy: without it "Hitler's" is one token and the surname anchor resolves to
 * "Hitler's" instead of "Hitler". A possessive is not part of a name, and the old ASCII pattern
 * excluded it for the accidental reason that it stopped at any non-`[a-z]` character. A hyphen
 * needs no such rule — nothing attaches a possessive with one.
 */
export const NAME_TOKEN =
  `(?:${NAME_UPPER}${NAME_APOSTROPHE})?${NAME_UPPER}${NAME_REST}+` +
  `(?:(?:${NAME_APOSTROPHE}${NAME_UPPER}|-${NAME_UPPER}?)${NAME_REST}+)*`;

/**
 * A run of capitalised tokens.
 *
 * @param minExtra how many tokens must follow the first. `1` is the two-or-more-word form the
 *   full-name patterns use; `0` allows a single token where the caller wants one.
 * @param maxExtra optional upper bound, for the callers that cap the run length.
 */
export function nameRunPattern(minExtra: number, maxExtra?: number): string {
  const quantifier =
    maxExtra === undefined
      ? minExtra <= 0
        ? "*"
        : minExtra === 1
          ? "+"
          : `{${minExtra},}`
      : `{${minExtra},${maxExtra}}`;
  return `\\b(${NAME_TOKEN}(?:\\s+${NAME_TOKEN})${quantifier})\\b`;
}

/** A fresh regex for a run of capitalised tokens. Fresh, because /g regexes carry lastIndex. */
export function nameRunRegex(minExtra: number, maxExtra?: number): RegExp {
  return new RegExp(nameRunPattern(minExtra, maxExtra), "gu");
}

/** A single capitalised token of at least `minLength` characters. */
export function singleNameTokenRegex(minLength = 3): RegExp {
  return new RegExp(`\\b${NAME_UPPER}${NAME_REST}{${Math.max(1, minLength - 1)},}\\b`, "gu");
}

/** The token pattern on its own, for callers that want to match one name rather than a run. */
export function nameTokenRegex(): RegExp {
  return new RegExp(`^${NAME_TOKEN}$`, "u");
}

/**
 * Reduce text to what a name pattern can read, without destroying names in the process.
 *
 * Replaces the `/[^\w\s:'-]/g` strip that preceded several of these patterns. Same intent —
 * punctuation becomes whitespace so runs break at sentence boundaries — but letters stay letters
 * whatever alphabet they are written in, and the marks that belong inside a surname survive.
 */
export function stripToNameSafeText(text: string): string {
  return text
    .replace(/[^\p{L}\p{M}\p{N}\s:'’_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is this token name-shaped — a capital followed by letters?
 *
 * Note for anyone tracing this bug: searchQueryContract's own `isNameShapedToken`, which
 * checkPersonName consults, was ALREADY Unicode-aware (`/^\p{Lu}[\p{Ll}'’‐-―-]+$/u`). The
 * validator could always have accepted Göring — the extraction patterns simply never handed it
 * one. That is why the fix belongs here and not there.
 */
export function isNameShapedToken(token: string): boolean {
  return new RegExp(`^${NAME_TOKEN}$`, "u").test(token);
}
