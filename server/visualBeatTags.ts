/**
 * Extract place/keyword tags from narration for archive search + voice-synced labels.
 */

export type VoiceLabelTerm = {
  /** On-screen pill text (uppercase). */
  label: string;
  /** Search tag(s) for archive matching. */
  searchTags: string[];
  /** Substring from beat text for voice timing (preserves casing/diacritics). */
  matchText?: string;
};

type GeoEntry = {
  pattern: RegExp;
  searchTags: string[];
  /** Preferred label when spoken in Dutch; falls back to first search tag. */
  label?: string;
};

const GEO_ENTRIES: GeoEntry[] = [
  { pattern: /\bduitsland\b|\bgermany\b|\bdeutschland\b|\bgerman\b|\bdeutsche\b/i, searchTags: ["germany", "german", "deutschland", "berlin"], label: "DUITSland" },
  { pattern: /\bberlijn\b|\bberlin\b/i, searchTags: ["berlin", "germany"], label: "BERLIJN" },
  { pattern: /\bmunich\b|\bmünchen\b|\bmunchen\b/i, searchTags: ["munich", "germany"], label: "MUNICH" },
  { pattern: /\bpolen\b|\bpoland\b|\bpolish\b/i, searchTags: ["poland", "polish", "warsaw"], label: "POLEN" },
  { pattern: /\bfrankrijk\b|\bfrance\b|\bfrench\b|\bparis\b|\bparijs\b/i, searchTags: ["france", "french", "paris"], label: "FRANKRIJK" },
  { pattern: /\bengeland\b|\bengland\b|\bbritain\b|\bbritish\b|\blondon\b/i, searchTags: ["england", "britain", "london", "uk"], label: "ENGELAND" },
  { pattern: /\boostenrijk\b|\baustria\b|\bvienna\b|\bwien\b/i, searchTags: ["austria", "vienna"], label: "OOSTENRIJK" },
  { pattern: /\brusland\b|\brussia\b|\brussian\b|\bsoviet\b|\bsovjet\b|\burss\b/i, searchTags: ["russia", "soviet", "moscow"], label: "RUSland" },
  { pattern: /\bitalië\b|\bitalie\b|\bitaly\b|\bitalian\b|\brome\b|\bromeinen\b/i, searchTags: ["italy", "italian", "rome"], label: "ITALIË" },
  { pattern: /\bamerika\b|\bamerica\b|\bamerican\b|\bunited states\b|\busa\b|\bunited states\b/i, searchTags: ["america", "usa", "united states"], label: "AMERIKA" },
  { pattern: /\beuropa\b|\beurope\b|\beuropean\b/i, searchTags: ["europe", "european"], label: "EUROPA" },
  { pattern: /\bholocaust\b|\bauschwitz\b|\bconcentration camp\b|\bkamp\b|\bconcentratiekamp\b/i, searchTags: ["holocaust", "auschwitz", "concentration camp"], label: "HOLOCAUST" },
  { pattern: /\bwehrmacht\b|\bnazi\b|\bnazis\b|\bnsdap\b|\bthird reich\b|\bderde rijk\b/i, searchTags: ["nazi", "wehrmacht", "third reich", "nsdap"], label: "NAZI" },
  { pattern: /\bwarschau\b|\bwarsaw\b/i, searchTags: ["warsaw", "poland"], label: "WARSCHAU" },
  { pattern: /\bmoskou\b|\bmoscow\b|\bkremlin\b/i, searchTags: ["moscow", "russia", "soviet"], label: "MOSKOU" },
  { pattern: /\bnormandi[ëe]\b|\bnormandy\b|\bd-day\b|\bdddag\b/i, searchTags: ["normandy", "d-day", "france"], label: "NORMANDIË" },
  { pattern: /\bstalin\b|\bsovjet\b|\bsoviet union\b/i, searchTags: ["stalin", "soviet", "russia"], label: "SOVJET" },
  { pattern: /\bhitler\b|\badolf\b/i, searchTags: ["hitler", "nazi", "germany"], label: "HITLER" },
];

const LABEL_STOP = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "have", "has", "had", "this", "that", "these", "those",
  "de", "het", "een", "en", "van", "op", "te", "dat", "die", "zijn", "werd", "wordt", "niet", "also",
  "when", "then", "year", "years", "during", "after", "before", "into", "over", "under", "while",
  "where", "which", "who", "there", "their", "they", "would", "could", "should", "became", "become",
]);

/** Tags for archive asset search (English/lowercase slugs). */
export function extractVisualSearchTags(beatText: string): string[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  const tags = new Set<string>();
  for (const entry of GEO_ENTRIES) {
    if (entry.pattern.test(cleaned)) {
      for (const t of entry.searchTags) tags.add(t);
    }
  }
  const words = cleaned
    .replace(/[^a-z0-9à-ÿ\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !LABEL_STOP.has(w));
  for (const w of words.slice(0, 6)) {
    if (!/^\d{4}$/.test(w)) tags.add(w);
  }
  return [...tags].slice(0, 12);
}

/** Primary geographic anchor for beat search (e.g. Duitsland → germany). */
export function extractPrimaryGeoSearchTag(beatText: string): string | null {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  for (const entry of GEO_ENTRIES) {
    if (entry.pattern.test(cleaned)) return entry.searchTags[0] ?? null;
  }
  return null;
}

function spokenLabelForGeo(cleaned: string, entry: GeoEntry): string {
  if (entry.label) {
    const m = cleaned.match(entry.pattern);
    if (m?.[0]) return m[0].toUpperCase().slice(0, 28);
  }
  return (entry.searchTags[0] ?? "").toUpperCase().slice(0, 28);
}

/** Voice-synced on-screen terms — only places/entities spoken in this beat (no title/stock slugs). */
export function extractVoiceLabelTerms(beatText: string): VoiceLabelTerm[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  const lower = cleaned.toLowerCase();
  const out: VoiceLabelTerm[] = [];
  const seen = new Set<string>();

  for (const entry of GEO_ENTRIES) {
    if (!entry.pattern.test(lower)) continue;
    const m = cleaned.match(entry.pattern);
    const label = spokenLabelForGeo(cleaned, entry);
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label,
      searchTags: entry.searchTags,
      matchText: m?.[0]?.trim() || undefined,
    });
  }

  return out.slice(0, 3);
}

export function termStartInBeat(
  beatText: string,
  term: string,
  beatStart: number,
  beatHoldSec: number,
  matchText?: string
): number {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, "");
  for (const probe of [matchText, term].filter(Boolean) as string[]) {
    const escaped = probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    const match = re.exec(cleaned);
    if (match && match.index >= 0) {
      const pos = match.index / Math.max(1, cleaned.length);
      return beatStart + Math.max(0.08, pos * beatHoldSec * 0.92);
    }
  }
  return beatStart + 0.12;
}
