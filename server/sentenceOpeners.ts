/**
 * VIDEO 623 — WHAT A SENTENCE OPENS WITH IS NOT A NAME, WHEREVER A NAME IS READ.
 *
 * Render 623 searched YouTube for "Let" and listed it among the scene's people:
 *
 *     [persons: Elon Musk, Tesla, Let, elon musk]
 *     [VisualIntent] s1b2 subject=Let evidence=soft people=Let
 *
 * "Let's look at…" read as a possessive ("Musk's"), and "Let Musk explain" / "Now Musk says" as
 * two-word names. The planner already knew its openers (VIDEO 621) and the subject extractor its
 * own (RONDE 614); the person reader knew neither. One list now, for every reader.
 *
 * Language, not subject matter: words that open a sentence and are never a person's name in that
 * position — function words, adverbs of time, place and manner, connectives, and the imperatives
 * narration opens with ("Let's", "Imagine", "Meet").
 */
export const SENTENCE_OPENERS: ReadonlySet<string> = new Set(
  (
    // articles, pronouns, determiners, conjunctions, prepositions
    "the a an it he she they we you i this that these those there then but and or as if so " +
    "in on at by for with from after before above below during when while what who why how where which " +
    "most many some every each one two all any both either neither no yes " +
    "within behind along amid despite without around inside across beyond against toward towards upon " +
    "until unless whether among like unlike " +
    // time, place and manner
    "now today tonight yesterday tomorrow soon later once finally eventually recently suddenly " +
    "ultimately meanwhile back ago still yet even just only also next first last " +
    "here deep deeper far further high low long elsewhere everywhere nowhere somewhere alone together " +
    "slowly quickly quietly barely " +
    // connectives
    "however although though because since instead thus therefore perhaps nevertheless nonetheless " +
    "moreover furthermore indeed whatever whenever wherever whoever " +
    // imperatives narration opens with
    "let lets imagine consider remember picture look listen meet enter think " +
    // Dutch — narration may be written in it (see scriptWriter's LANGUAGE rule). Not "van", "de",
    // "den", "ter", "ten" (name particles: "Van Gogh"), nor "dan" and "elke" (also first names).
    "het een deze dit dat die er hij zij ze wij jij je ik op bij met voor tijdens toen nu vandaag " +
    "gisteren morgen hier daar maar want omdat hoewel toch ook zelfs pas eerst later ooit ondertussen " +
    "intussen kijk stel laten laat denk ontmoet waarom hoe wat wie waar wanneer welke nog alle iedere " +
    "geen niet zo " +
    // German — likewise. Not "von", "zu", "der", "du", "das", "na" (name particles or surnames:
    // "von Braun", "van der Waals", "Du Bois", "Das").
    "ein eine es sie wir ich im am auf mit nach vor während jetzt heute gestern dort dann aber " +
    "und oder wenn weil obwohl doch auch sogar erst später einst inzwischen schau stell lass lasst " +
    "warum wie was wer wo wann welche alle jede kein nicht"
  ).split(" ")
);

/** The word as a sentence opener would be looked up: lower case, a contraction's `'s` dropped. */
function bare(word: string): string {
  return word
    .trim()
    .replace(/^[\p{P}]+|[\p{P}]+$/gu, "")
    .replace(/['’]s$/i, "")
    .toLowerCase();
}

export function isSentenceOpener(word: string): boolean {
  return SENTENCE_OPENERS.has(bare(word));
}

/** Does `index` in `text` sit at the start of a sentence (after any opening quote)? */
export function atSentenceStart(text: string, index: number): boolean {
  const before = text.slice(0, index).replace(/["“'‘(\[]+$/u, "").trimEnd();
  return before.length === 0 || /[.!?:;]$/.test(before);
}

/**
 * A run of capitalised words, with the sentence opener in front of it removed: "Let Musk" is
 * "Musk", "Now Elon Musk" is "Elon Musk". Only the first word, and only at a sentence start.
 */
export function withoutSentenceOpener(run: string, text: string, index: number): string {
  const words = run.trim().split(/\s+/);
  if (words.length === 0 || !atSentenceStart(text, index) || !isSentenceOpener(words[0]!)) return run.trim();
  return words.slice(1).join(" ");
}
