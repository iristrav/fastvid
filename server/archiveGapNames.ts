

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
