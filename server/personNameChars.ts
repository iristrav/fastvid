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
  // RONDE 125: `el-Sisi`, `al-Assad` — a particle bound to the name with a hyphen, which is part
  // of the name rather than a separate word.
  `(?:${NAME_UPPER}${NAME_APOSTROPHE}|(?:de|del|della|der|den|des|di|do|dos|du|da|van|von|vom|zu|ten|ter|la|le|les|bin|ibn|bint|al|el|ben|bar|abu|af|av)-)?` +
  `${NAME_UPPER}${NAME_REST}+` +
  `(?:(?:${NAME_APOSTROPHE}${NAME_UPPER}|-${NAME_UPPER}?)${NAME_REST}+)*`;

/**
 * RONDE 125 — the word boundary that hid every non-ASCII name.
 *
 * RONDE 123 fixed the character CLASS and the fix worked for "Hermann Göring" — because "Hermann"
 * begins with an ASCII H. It did nothing for "Łukasz Fabiański", "İsmet İnönü" or "Иосиф Сталин",
 * and the reason is one token in the pattern that nobody had reason to suspect: `\b`.
 *
 * JavaScript's `\b` is defined on ASCII word characters — `[A-Za-z0-9_]` — and the `u` flag does
 * NOT change that. So `\bŁ` is not a boundary at all, and a name STARTING with a non-ASCII letter
 * is invisible to the pattern however good the character class behind it is. Measured:
 *
 *     /\bŁ/.test(" Łukasz")   →  false
 *     /\bG/.test(" Göring")   →  true
 *
 *     "Łukasz Fabiański saved"  with \b  →  null
 *                               with these lookarounds  →  ["Łukasz Fabiański"]
 *
 * These lookarounds say the same thing `\b` was meant to say, for every alphabet: the character
 * before the run is not a letter, mark, digit or underscore, and neither is the one after it.
 */
export const NAME_BOUNDARY_LEFT = "(?<![\\p{L}\\p{M}\\p{N}_])";
export const NAME_BOUNDARY_RIGHT = "(?![\\p{L}\\p{M}\\p{N}_])";

/**
 * RONDE 125 — the lower-case words that live INSIDE a surname.
 *
 * "Charles de Gaulle" and "Vincent van Gogh" were not near-misses: they produced NOTHING, because
 * a run of capitalised tokens breaks at "de" and each half is then a single token, below the
 * two-token minimum. The measurement, before this list existed:
 *
 *     "The famous French president Charles de Gaulle"  →  []
 *     "Vincent van Gogh painted Starry Night"          →  ["Starry Night", "Gogh"]
 *
 * — the second one being worse than nothing, since it named a painting as a person and reduced
 * the painter to his surname.
 *
 * Deliberately a short, closed list of true name particles rather than "any lower-case word": the
 * whole point of a capitalised run is that the capitals carry the evidence, and letting arbitrary
 * lower-case words through would let "Hermann of the Reich" become a name. Nothing here is a word
 * that carries meaning on its own in the middle of a name.
 */
export const NAME_PARTICLES = [
  // Romance and Germanic
  "de", "del", "della", "der", "den", "des", "di", "do", "dos", "du", "da",
  "van", "von", "vom", "zu", "ten", "ter", "la", "le", "les",
  // Arabic and Hebrew
  "bin", "ibn", "bint", "al", "el", "ben", "bar", "abu",
  // Nordic
  "af", "av",
] as const;

const PARTICLE_ALT = `(?:${NAME_PARTICLES.join("|")})`;

/**
 * A run of capitalised tokens, particles included.
 *
 * The particle may appear between two capitalised tokens ("Charles de Gaulle") or attached to one
 * with a hyphen ("Abdel Fattah el-Sisi") — the second form is handled inside NAME_TOKEN. A run may
 * never START or END with a particle, which is what keeps "de" from becoming a name on its own.
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
  const sep = `\\s+(?:${PARTICLE_ALT}\\s+)*`;
  return (
    `${NAME_BOUNDARY_LEFT}(${NAME_TOKEN}(?:${sep}${NAME_TOKEN})${quantifier})${NAME_BOUNDARY_RIGHT}`
  );
}

/** Is this lower-case word a name particle rather than an ordinary word? */
export function isNameParticle(token: string): boolean {
  return (NAME_PARTICLES as readonly string[]).includes(token.trim().toLowerCase());
}

/** A fresh regex for a run of capitalised tokens. Fresh, because /g regexes carry lastIndex. */
export function nameRunRegex(minExtra: number, maxExtra?: number): RegExp {
  return new RegExp(nameRunPattern(minExtra, maxExtra), "gu");
}

/** A single capitalised token of at least `minLength` characters. */
export function singleNameTokenRegex(minLength = 3): RegExp {
  // RONDE 125: same ASCII-`\b` trap as the run pattern — see NAME_BOUNDARY_LEFT.
  return new RegExp(
    `${NAME_BOUNDARY_LEFT}${NAME_UPPER}${NAME_REST}{${Math.max(1, minLength - 1)},}${NAME_BOUNDARY_RIGHT}`,
    "gu"
  );
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
