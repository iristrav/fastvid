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
