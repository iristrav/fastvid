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
