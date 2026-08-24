/**
 * Diacritic folding for search text.
 *
 * Every keyword/tag builder in this codebase ends with some form of
 * `.toLowerCase().replace(/[^a-z0-9\s]/g, " ")`. That is correct for punctuation and wrong for
 * accented letters: the character is not punctuation, it is part of a word, and replacing it with
 * a space cuts the word in half.
 *
 * Render 530 shows exactly what that costs. "Führerbunker" lowercases to "führerbunker"; the
 * `ü` is outside `[a-z0-9\s]`, so the strip produced "f hrerbunker", the one-letter fragment was
 * dropped by the minimum-length filter, and the search ran on:
 *
 *     beatTags: [claustrophobic, depths, hrerbunker]
 *
 * "hrerbunker" matches nothing anywhere. The single most distinctive term of that video was
 * destroyed before any provider was asked. The same fate awaits Führer, Göring, Dönitz, München,
 * Białystok, Škoda — the vocabulary of exactly the historical topics this pipeline targets.
 *
 * Folding first turns it into "fuhrerbunker", which is what an English-language archive, Commons
 * title or stock tag actually contains.
 */

/**
 * Lowercased, diacritic-folded text. `ü`→`u`, `é`→`e`, `ß`→`ss`, `ø`→`o`, `æ`→`ae`.
 *
 * NFD splits a composed letter into its base plus a combining mark, so stripping the combining
 * range leaves the base letter. The few letters that carry no combining mark (ß, ø, æ, đ, ł) are
 * mapped explicitly — NFD leaves those untouched and they would otherwise still be stripped by
 * the caller's ASCII filter.
 */
export function foldSearchText(input: string): string {
  return input
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ø/g, "o")
    .replace(/đ/g, "d")
    .replace(/ð/g, "d")
    .replace(/þ/g, "th")
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Fold, then reduce to `[a-z0-9]` plus the separators the caller asked to keep.
 *
 * This is the whole pattern the keyword builders were open-coding, with the folding step they
 * were all missing. `keep` is a character-class fragment, e.g. `"-"` to preserve hyphens.
 */
export function foldToSearchTokensText(input: string, keep = ""): string {
  const cls = new RegExp(`[^a-z0-9\\s${keep}]`, "g");
  return foldSearchText(input).replace(cls, " ").replace(/\s+/g, " ").trim();
}
