/**
 * RONDE 649 — A YOUTUBE RESULT WHOSE TITLE SAYS IT IS NOT FOOTAGE IS NOT DOWNLOADED.
 *
 * Render 606 searched YouTube for its lines about Hitler's fate and downloaded, among others:
 *
 *     "Hitler Reacts to The Last Guardian Being 'Cancelled'"
 *     "Hitler is informed Jane Withers has died"
 *     "Last Days of Hitler, 7th Edition Audiobook by Hugh Trevor-Roper"
 *
 * A parody with subtitles, a meme, an audiobook with a still cover. Each cost a download slot, a
 * text check and a refusal (BAKED_EDIT_TEXT) — and none of them could ever have been a shot. The
 * title said so before a byte moved.
 *
 * The words below name a GENRE of video that is never archive footage, whatever its subject. None
 * of them is about a topic, so the list does not grow with the films FastVid makes. A word that
 * could title a real documentary ("finds out", "explained", "story") is deliberately not here: the
 * picture editor judges those, as before.
 */

const NOT_FOOTAGE: ReadonlyArray<[RegExp, string]> = [
  [/\bparod(y|ies)\b/i, "parody"],
  [/\breacts?\b|\breaction\b/i, "reaction"],
  [/\baudio ?books?\b/i, "audiobook"],
  [/\bmemes?\b/i, "meme"],
  [/\bpodcasts?\b/i, "podcast"],
  [/\bgameplay\b|\bwalkthrough\b|\blet'?s play\b/i, "gameplay"],
  [/\blyrics?\b/i, "lyrics"],
  [/\bytp\b|\byoutube poop\b/i, "youtube poop"],
  /** The Downfall-parody format: "<name> is informed …" / "<name> gets informed …". */
  [/\b(is|gets) informed\b/i, "parody"],
];

/** The genre a title announces when it is not footage, or null when it may be. */
export function youtubeTitleIsNotFootage(title: string | null | undefined): string | null {
  const t = (title ?? "").trim();
  if (!t) return null;
  for (const [re, genre] of NOT_FOOTAGE) if (re.test(t)) return genre;
  return null;
}

/**
 * Video 613 — A YOUTUBE SHORT IS NEVER DOWNLOADED.
 *
 * Render 613 downloaded "Oh No khloe even didn't Notice kim kardashian Revenge😂 #yts" — a 360x640
 * vertical Short with captions — and several like it. The operator's rule is absolute: no Short is
 * fetched at all. A Short is at most three minutes long; before a download, what can be known is
 * its length (from the video's details) and the hashtag its uploader gave it.
 */
export const YOUTUBE_SHORT_MAX_SEC = 180;

const SHORTS_TAG = /#(?:shorts?|ytshorts?|youtubeshorts?|yts)\b/i;

/** Why this search result is (or may be) a Short, or null when it is not. */
export function youtubeResultIsShort(
  title: string | null | undefined,
  description?: string | null,
  durationSec?: number | null
): string | null {
  if (SHORTS_TAG.test(`${title ?? ""} ${description ?? ""}`)) return "shorts hashtag";
  if (durationSec != null && durationSec > 0 && durationSec <= YOUTUBE_SHORT_MAX_SEC) return `${durationSec}s — Short length`;
  return null;
}

/**
 * RONDE 650 — A YOUTUBE QUERY SAYS WHO OR WHAT IT IS ABOUT.
 *
 * Render 607 sent "escape archival footage" and "suicide archival footage" to YouTube — a beat's
 * power word with the footage suffix and nothing else. YouTube answered with a mobile game
 * ("Granny 3 … Escape Full Gameplay") and a memes compilation. The same beat also asked
 * "Adolf Hitler suicide archival footage", which is the question that could find the picture.
 *
 * Prefixing the video's subject was considered and rejected: 607's person lock read "Hitler Kill"
 * (from its title), and "Hitler Kill escape" would have been no better. So a query that names
 * nobody is simply not sent while the list holds queries that do — which also spends less of the
 * daily search quota. A list where nothing names anybody (a topic film) is kept whole.
 *
 * "Names something": one of the subject's words is in it, or it carries a capitalised word of its
 * own ("Joseph Goebbels Führerbunker", "Third Reich", "hitler Rumors").
 */
export function queryNamesSomething(query: string, subject?: string | null): boolean {
  const q = query.trim();
  if (!q) return false;
  if (/(^|\s)\p{Lu}/u.test(q)) return true;
  const lower = q.toLowerCase();
  return (subject ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .some((w) => lower.split(/\s+/).includes(w));
}

/** Keeps the queries that name something; all of them when none does. */
export function queriesThatNameSomething(queries: string[], subject?: string | null): string[] {
  const named = queries.filter((q) => queryNamesSomething(q, subject));
  return named.length > 0 ? named : queries;
}

/** Words that already ask for footage; a query carrying one is left as it is. */
const FOOTAGE_WORD = /\b(footage|archival|archive|newsreels?|documentary|film|filmed|news report|video|reel)\b/i;

/**
 * RONDE 649 — a YouTube query that names only a subject ("hitler rumors") also finds every talk,
 * parody and slideshow about it. "archival footage" asks for the picture; it is production
 * vocabulary the search gate accepts without proof (`TECHNICAL_ARCHIVAL_TERM`).
 */
export function askForFootage(query: string): string {
  const q = query.trim();
  if (!q || FOOTAGE_WORD.test(q)) return q;
  return `${q} archival footage`;
}

/** Filler words that say nothing about what is on screen ("citizenship instead"). */
const FILLER_WORDS = new Set([
  "instead", "also", "even", "just", "only", "still", "already", "again", "ever", "never", "too",
  "very", "rather", "quite", "then", "now", "yet", "once", "soon", "later", "really", "simply",
]);

/** Small words a query may keep inside a name ("Battle of Zama"), never at its ends or on their own. */
const GLUE_WORDS = new Set(["of", "the", "a", "an", "and", "in", "on", "at", "de", "von", "van", "bin", "al"]);

/** Pronouns and function words: they name nothing a camera could film, so they are never sent. */
const FUNCTION_WORDS = new Set([
  "its", "it", "this", "that", "these", "those", "his", "her", "hers", "their", "our", "your", "my",
  "he", "she", "they", "we", "i", "you", "him", "them", "is", "was", "were", "are", "be", "been",
  "by", "for", "with", "from", "to", "as", "into", "but", "or", "so", "not", "no", "why", "how",
  "what", "when", "where", "who", "which", "despite", "every", "all", "some", "any",
]);

function sentenceWords(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}'’-]+/u)
    .map((w) => w.replace(/['’]s$/, "").replace(/^['’-]+|['’-]+$/g, ""))
    .filter(Boolean);
}

/**
 * Video 614 — the words a sentence writes as NAMES.
 *
 * A capital in the middle of a sentence is a name ("… Kourtney Kardashian in Los Angeles").
 * A capital on the sentence's FIRST word is only grammar ("Let's", "Centuries later", "Yet"),
 * unless the scene writes that word as a name elsewhere too — with a capital in the middle of a
 * sentence, or with a capital more than once ("Rome offered … Rome was small").
 */
export function sentenceNameWords(sentence: string, sceneText = "", knownNames: Iterable<string> = []): Set<string> {
  const names = new Set<string>();
  const openers = new Set<string>();
  const capitalCount = new Map<string, number>();
  const read = (text: string, own: boolean) => {
    for (const part of (text ?? "").split(/(?<=[.!?])\s+/)) {
      part.split(/\s+/).filter(Boolean).forEach((raw, i) => {
        if (!/^[^\p{L}\p{N}]*\p{Lu}/u.test(raw)) return;
        const w = sentenceWords(raw)[0] ?? "";
        if (!w || FILLER_WORDS.has(w) || FUNCTION_WORDS.has(w) || GLUE_WORDS.has(w)) return;
        capitalCount.set(w, (capitalCount.get(w) ?? 0) + 1);
        if (i > 0) names.add(w);
        else if (own) openers.add(w);
      });
    }
  };
  const scene = (sceneText ?? "").trim();
  read(sentence, true);
  if (scene && scene !== (sentence ?? "").trim()) read(scene.replace((sentence ?? "").trim(), " "), false);
  /** Also a name when FastVid already knows it as one — a place its geography recognises ("Rome"). */
  const known = new Set([...knownNames].flatMap((k) => sentenceWords(k)));
  for (const w of openers) if ((capitalCount.get(w) ?? 0) > 1 || known.has(w)) names.add(w);
  /** An era or unit abbreviation is not a subject: "146 BC", "AD 79", "TV". */
  for (const w of ["bc", "ad", "bce", "ce", "tv"]) names.delete(w);
  /** Only the sentence's own words count: a name from elsewhere in the scene was only evidence. */
  const own = new Set(sentenceWords(sentence));
  return new Set([...names].filter((w) => own.has(w)));
}

/**
 * Video 612/613 — A YOUTUBE QUERY FOR A SENTENCE HOLDS ONLY WORDS FROM THAT SENTENCE.
 *
 * The builders add words of their own: "archival footage", "documentary footage", "news report",
 * the video's title, a person the scene names but this sentence does not. None of that is said in
 * the sentence, so none of it is sent. Words are only ever REMOVED here, never added:
 *   - every word the sentence does not contain;
 *   - the sentence's verb ("Scipio Africanus led", "Kim Kardashian built");
 *   - filler words ("citizenship instead") and pronouns ("Its");
 *   - a question that names nobody and nothing ("examining true", "Let", "Empire").
 * What is left is deduplicated, and short questions go first: a query of more than four words
 * ("Scipio Africanus Hannibal Barca Tunisia") is asked after the shorter ones.
 */
export function sentenceOnlyYoutubeQueries(
  queries: readonly string[],
  sentence: string,
  verb = "",
  sceneText = "",
  knownNames: Iterable<string> = []
): string[] {
  const allowed = new Set(sentenceWords(sentence));
  /** The names the sentence writes (who, where, which brand): see `sentenceNameWords`. */
  const named = sentenceNameWords(sentence, sceneText, knownNames);
  const verbWord = verb.trim().toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const kept = (q ?? "")
      .split(/\s+/)
      .filter((raw) => {
        const w = sentenceWords(raw)[0];
        if (!w) return false;
        if (FILLER_WORDS.has(w) || FUNCTION_WORDS.has(w)) return false;
        if (verbWord && w === verbWord) return false;
        return allowed.has(w);
      });
    while (kept.length && GLUE_WORDS.has(sentenceWords(kept[0]!)[0] ?? "")) kept.shift();
    while (kept.length && GLUE_WORDS.has(sentenceWords(kept[kept.length - 1]!)[0] ?? "")) kept.pop();
    if (!kept.some((raw) => !GLUE_WORDS.has(sentenceWords(raw)[0] ?? ""))) continue;
    /**
     * Video 614 — every question names someone or something: a person, a place, a brand.
     * "examining true", "climax uncovers" and "Let" (the first word of "Let's …") name nothing,
     * find nothing and still cost a search. A one-word "Empire" is dropped by the same rule.
     */
    if (!kept.some((raw) => named.has(sentenceWords(raw)[0] ?? ""))) continue;
    const query = kept.join(" ").trim();
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  const words = (q: string) => q.split(/\s+/).length;
  return [...out.filter((q) => words(q) <= 4), ...out.filter((q) => words(q) > 4)];
}

/**
 * The sentence right before and right after `sentence` inside its scene's own text. Nothing when
 * the sentence cannot be found there: then there is no neighbour to borrow from.
 */
export function neighbourSentences(sceneText: string | undefined, sentence: string | undefined): { previous?: string; next?: string } {
  const scene = (sceneText ?? "").replace(/\s+/g, " ").trim();
  const own = (sentence ?? "").replace(/\s+/g, " ").trim();
  if (!scene || !own) return {};
  const at = scene.indexOf(own);
  if (at < 0) return {};
  const split = (t: string) => t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const before = split(scene.slice(0, at));
  const after = split(scene.slice(at + own.length));
  return { previous: before[before.length - 1], next: after[0] };
}

/**
 * The names a sentence writes: runs of capitalised words ("Kim Kardashian", "Battle of Zama").
 * A lone capital at the very start of the sentence is only a capital ("Centuries later …"), unless
 * one of `alsoNamedIn` carries the same word too, or the scene writes it as a name elsewhere: with a
 * capital in the middle of a sentence, or with a capital more than once ("Rome was … Rome sealed").
 */
export function namesInSentence(sentence: string, alsoNamedIn: readonly string[] = [], sceneText = ""): string[] {
  const tokens = (sentence ?? "").split(/\s+/).filter(Boolean);
  const known = new Set(alsoNamedIn.flatMap((q) => sentenceWords(q)));
  const capitalCount = new Map<string, number>();
  for (const part of (sceneText ?? "").split(/(?<=[.!?])\s+/)) {
    part.split(/\s+/).filter(Boolean).forEach((raw, i) => {
      if (!/^[^\p{L}\p{N}]*\p{Lu}/u.test(raw)) return;
      const w = sentenceWords(raw)[0] ?? "";
      if (!w) return;
      if (i > 0) known.add(w);
      capitalCount.set(w, (capitalCount.get(w) ?? 0) + 1);
    });
  }
  for (const [w, n] of capitalCount) if (n > 1) known.add(w);
  const runs: string[] = [];
  let run: string[] = [];
  let runStart = -1;
  const close = () => {
    while (run.length && GLUE_WORDS.has(sentenceWords(run[run.length - 1]!)[0] ?? "")) run.pop();
    const first = sentenceWords(run[0] ?? "")[0] ?? "";
    const loneOpening = run.length === 1 && runStart === 0 && !known.has(first);
    if (run.length && !loneOpening) runs.push(run.map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/['’]s$/, "")).join(" "));
    run = [];
    runStart = -1;
  };
  tokens.forEach((raw, i) => {
    const w = sentenceWords(raw)[0] ?? "";
    const capital = /^[^\p{L}\p{N}]*\p{Lu}/u.test(raw) && !FILLER_WORDS.has(w) && !FUNCTION_WORDS.has(w) && !GLUE_WORDS.has(w);
    if (capital) {
      if (!run.length) runStart = i;
      run.push(raw);
    } else if (run.length && GLUE_WORDS.has(w) && /^\p{Ll}/u.test(raw)) {
      run.push(raw);
    } else if (run.length) close();
    if (run.length && /[.,;:!?)]$/.test(raw)) close();
  });
  if (run.length) close();
  return [...new Set(runs.filter(Boolean))];
}
