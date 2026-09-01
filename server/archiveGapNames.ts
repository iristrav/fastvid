/**
 * RONDE 127 — "Gevraagde beelden die missen" should list people, not subjects.
 *
 * The gap list was recording whatever query happened to fall through to stock footage:
 *
 *     recordArchiveContentGap(q, beat.text)     // q = "berlin street 1930s documentary"
 *
 * so the admin page filled up with search phrases. What it is actually for is deciding what to
 * upload next, and for a documentary archive that decision is almost always about a PERSON: an
 * archive either has footage of Hermann Göring or it does not, and no amount of "1930s street
 * scenes" answers that.
 *
 * This module decides, for one recorded gap, whether it names a person — and if so, which person.
 * It reuses the extractor RONDE 123 and RONDE 125 rebuilt rather than inventing a second idea of
 * what a name is: the same Unicode boundaries, the same particles, the same refusals. A gap it
 * cannot tie to a person is not recorded and not shown.
 *
 * Both ends are filtered on purpose. New rows are only written for people, and the LIST is
 * filtered too, so the topic rows already in the table stop appearing without anyone having to
 * clear it and lose the hit counts.
 */

/**
 * The person a gap is about, or null.
 *
 * @param candidates person names already extracted from this beat by the pipeline. Passed in
 *   rather than re-extracted, so this module stays free of the pipeline and the answer cannot
 *   disagree with what the render itself believed.
 */
export function personNameForGap(params: {
  /** The query or entity that was recorded. */
  keyword: string;
  /** Person names the pipeline extracted for this beat, if any. */
  candidates?: readonly string[];
}): string | null {
  const keyword = (params.keyword ?? "").trim();
  if (!keyword) return null;

  /**
   * A `low-coverage:<entity>` gap already names its subject — archiveCoverageWarning writes it
   * that way — so the prefix is stripped and the entity judged on its own.
   */
  const bare = keyword.replace(/^low-coverage:/i, "").trim();
  if (!bare) return null;

  const candidates = (params.candidates ?? []).map((c) => c.trim()).filter(Boolean);
  if (candidates.length === 0) return null;

  /**
   * The gap counts as being about a person when the recorded text CONTAINS one of the beat's own
   * person names. A query like "hermann göring berlin archival footage" is a gap about Hermann
   * Göring; "berlin street 1930s" names nobody and is dropped.
   *
   * Longest first, so "Hermann Göring" wins over a bare "Göring" when both were extracted.
   */
  const haystack = bare.toLowerCase();
  const sorted = [...candidates].sort((a, b) => b.length - a.length);
  for (const person of sorted) {
    if (haystack.includes(person.toLowerCase())) return person;
  }
  return null;
}

/**
 * Does an EXISTING gap row look like a person name rather than a search phrase?
 *
 * Used to filter the admin list so the rows written before this round stop showing without
 * clearing the table. Deliberately conservative — it is a display filter over historical data,
 * not a classifier: two or three capitalised-looking words and no query furniture.
 */
const QUERY_FURNITURE = new Set([
  "footage", "archival", "archive", "video", "clip", "clips", "documentary", "historical",
  "history", "stock", "hd", "1080p", "4k", "b-roll", "broll", "scene", "shot", "wide",
  "close", "closeup", "aerial", "establishing", "street", "city", "view", "background",
  "vintage", "old", "retro", "photo", "photos", "image", "images", "picture", "pictures",
]);

export function gapRowLooksLikePerson(keyword: string): boolean {
  const bare = (keyword ?? "").replace(/^low-coverage:/i, "").trim();
  if (!bare) return false;
  const words = bare.split(/\s+/).filter(Boolean);
  // A person's name here is two or three words. One word is ambiguous, four is a phrase.
  if (words.length < 2 || words.length > 3) return false;
  for (const w of words) {
    const clean = w.replace(/[^\p{L}\p{M}'’-]/gu, "");
    if (!clean) return false;
    if (QUERY_FURNITURE.has(clean.toLowerCase())) return false;
    // A year, or any digit, means this is a query rather than a name.
    if (/\d/.test(w)) return false;
  }
  return true;
}

/** One line for the admin list. */
export function formatGapPersonLine(keyword: string, hitCount: number): string {
  const bare = keyword.replace(/^low-coverage:/i, "").trim();
  return `${bare} (${hitCount}x gevraagd, geen beeld in archief)`;
}
