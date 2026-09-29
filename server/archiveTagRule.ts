/**
 * VIDEO 619 — AN ARCHIVE ASSET CARRIES AT MOST TWO TAGS: WHO, AND WHAT OR WHEN.
 *
 * The operator's rule, with their own example: `kylie jenner, interview`. The person's name in
 * full first, then what the footage is or when it is from. Two tags a person can read at a glance
 * and search by, instead of a dozen words from a YouTube title.
 *
 * ── How the two are chosen ───────────────────────────────────────────────────────────────────
 *
 *   who    a person's full name: a name recognised in the picture or named as a person entity
 *          first, else the first tag of two or more words that is not a generic phrase. A single
 *          word is never promoted to a name — "kardashian" does not say which one.
 *   what   a year (the "when") or a kind of footage (interview, speech, concert, …) when one is
 *          there, else the first remaining tag that says something. Never a word already inside
 *          the name, never a word that describes every clip ("footage", "video", "hd").
 *
 * With no name, the two best "what/when" tags are kept. Nothing is invented: a tag that is not in
 * what the asset already carried is never written.
 */

/** Words that describe every clip and therefore describe none. */
const GENERIC = new Set([
  "footage", "video", "videos", "clip", "clips", "hd", "4k", "1080p", "720p", "official", "full",
  "archive", "archival", "stock", "youtube", "news", "new", "best", "top", "watch", "live", "the",
  "and", "of", "in", "on", "at", "for", "with", "a", "an", "vs", "part", "episode", "ep",
  "compilation", "highlights", "moments", "shorts", "short", "tiktok", "viral", "trending",
]);

/** Kinds of footage — the "what" the operator's example names. */
const KINDS = new Set([
  "interview", "speech", "press conference", "red carpet", "concert", "performance", "trial",
  "parade", "protest", "rally", "launch", "wedding", "funeral", "premiere", "award", "awards",
  "documentary", "newsreel", "debate", "podcast", "photoshoot", "runway", "fashion show", "match",
  "game", "race", "battle", "war", "ceremony", "celebration", "meeting", "visit", "tour",
  "behind the scenes", "backstage", "vlog", "reunion", "announcement", "keynote", "testimony",
]);

const YEAR = /^(1[89]\d{2}|20\d{2})s?$/;

export const MAX_ARCHIVE_TAGS = 2;

function clean(tag: string): string {
  return tag.toLowerCase().replace(/[#_]+/g, " ").replace(/[^\p{L}\p{N}\s'-]+/gu, " ").replace(/\s+/g, " ").trim();
}

function isGeneric(tag: string): boolean {
  return tag.split(" ").every((w) => GENERIC.has(w) || w.length < 2);
}

/** Two or more words, each a word of letters, and not a generic phrase. */
export function looksLikeFullName(tag: string): boolean {
  const words = tag.split(" ");
  if (words.length < 2 || words.length > 4) return false;
  if (!words.every((w) => /^\p{L}[\p{L}'-]+$/u.test(w))) return false;
  if (words.some((w) => GENERIC.has(w) || KINDS.has(w))) return false;
  return !KINDS.has(tag);
}

export function archiveTagsAtMostTwo(
  tags: readonly string[],
  _title = "",
  persons: readonly string[] = []
): string[] {
  const all = [...new Set(tags.map(clean).filter((t) => t && !isGeneric(t)))];
  const name =
    [...new Set(persons.map(clean))].find(looksLikeFullName) ??
    all.find(looksLikeFullName) ??
    null;
  const nameWords = new Set((name ?? "").split(" ").filter(Boolean));
  const rest = all.filter((t) => t !== name && !t.split(" ").every((w) => nameWords.has(w)));
  const year = rest.find((t) => YEAR.test(t));
  const kind = rest.find((t) => KINDS.has(t));
  const what = year ?? kind ?? rest[0] ?? null;
  if (name) return what ? [name, what] : [name];
  const second = rest.find((t) => t !== what && (YEAR.test(t) || KINDS.has(t))) ?? rest.find((t) => t !== what);
  return [what, second].filter((t): t is string => Boolean(t)).slice(0, MAX_ARCHIVE_TAGS);
}
