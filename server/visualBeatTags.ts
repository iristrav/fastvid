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

type TagEntry = {
  pattern: RegExp;
  searchTags: string[];
  /** Preferred on-screen label (places only). */
  label?: string;
};

/** Countries and cities — shown as on-screen labels when spoken. */
const PLACE_ENTRIES: TagEntry[] = [
  { pattern: /\bduitsland\b|\bgermany\b|\bdeutschland\b|\bgerman\b|\bdeutsche\b/i, searchTags: ["germany", "german", "deutschland", "berlin"], label: "DUITSland" },
  { pattern: /\bberlijn\b|\bberlin\b/i, searchTags: ["berlin", "germany"], label: "BERLIJN" },
  { pattern: /\bmunich\b|\bmünchen\b|\bmunchen\b/i, searchTags: ["munich", "germany"], label: "MUNICH" },
  { pattern: /\bpolen\b|\bpoland\b|\bpolish\b/i, searchTags: ["poland", "polish", "warsaw"], label: "POLEN" },
  { pattern: /\bfrankrijk\b|\bfrance\b|\bfrench\b|\bparis\b|\bparijs\b/i, searchTags: ["france", "french", "paris"], label: "FRANKRIJK" },
  { pattern: /\bengeland\b|\bengland\b|\bbritain\b|\bbritish\b|\blondon\b/i, searchTags: ["england", "britain", "london", "uk"], label: "ENGELAND" },
  { pattern: /\boostenrijk\b|\baustria\b|\bvienna\b|\bwien\b/i, searchTags: ["austria", "vienna"], label: "OOSTENRIJK" },
  { pattern: /\brusland\b|\brussia\b|\brussian\b|\bsoviet\b|\bsovjet\b|\burss\b/i, searchTags: ["russia", "soviet", "moscow"], label: "RUSland" },
  { pattern: /\bitalië\b|\bitalie\b|\bitaly\b|\bitalian\b|\brome\b|\bromeinen\b/i, searchTags: ["italy", "italian", "rome"], label: "ITALIË" },
  { pattern: /\bamerika\b|\bamerica\b|\bamerican\b|\bunited states\b|\busa\b/i, searchTags: ["america", "usa", "united states"], label: "AMERIKA" },
  { pattern: /\beuropa\b|\beurope\b|\beuropean\b/i, searchTags: ["europe", "european"], label: "EUROPA" },
  { pattern: /\bwarschau\b|\bwarsaw\b/i, searchTags: ["warsaw", "poland"], label: "WARSCHAU" },
  { pattern: /\bmoskou\b|\bmoscow\b|\bkremlin\b/i, searchTags: ["moscow", "russia", "soviet"], label: "MOSKOU" },
  { pattern: /\bnormandi[ëe]\b|\bnormandy\b|\bd-day\b|\bdddag\b/i, searchTags: ["normandy", "d-day", "france"], label: "NORMANDIË" },
  { pattern: /\bauschwitz\b/i, searchTags: ["auschwitz", "poland", "holocaust"], label: "AUSCHWITZ" },
];

/** People / factions — archive search only (not on-screen labels). */
const ENTITY_SEARCH_ENTRIES: TagEntry[] = [
  { pattern: /\bhitler\b|\badolf\b|\bhitlers\b/i, searchTags: ["hitler", "adolf hitler", "fuhrer", "führer"] },
  { pattern: /\bholocaust\b|\bconcentration camp\b|\bkamp\b|\bconcentratiekamp\b/i, searchTags: ["holocaust", "concentration camp", "auschwitz"] },
  { pattern: /\bwehrmacht\b|\bnazi\b|\bnazis\b|\bnsdap\b|\bthird reich\b|\bderde rijk\b/i, searchTags: ["nazi", "wehrmacht", "third reich", "nsdap"] },
  { pattern: /\bstalin\b|\bsovjet\b|\bsoviet union\b/i, searchTags: ["stalin", "soviet", "russia"] },
  { pattern: /\bchurchill\b/i, searchTags: ["churchill", "britain"] },
  { pattern: /\brommel\b|\berwin\b/i, searchTags: ["rommel", "germany", "military"] },
];

/** Scene / setting — archive search only (bunker, rally, troops…). */
const SCENE_SEARCH_ENTRIES: TagEntry[] = [
  { pattern: /\bbunker\b|\bführerbunker\b|\bfuhrerbunker\b|\bführer\s*bunker\b|\bondergrondse\b|\bkelder\b|\bcommando\s*post\b/i, searchTags: ["bunker", "fuhrerbunker", "führerbunker", "hitler bunker", "underground", "command post"] },
  { pattern: /\bredevoering\b|\bspeech\b|\brally\b|\bpodium\b|\btribune\b|\bnürnberg\b|\bnuremberg\b/i, searchTags: ["speech", "rally", "podium", "nuremberg", "nuremberg rally"] },
  { pattern: /\bmilitair\b|\bsoldaten\b|\btroepen\b|\barmy\b|\btroops\b|\binfanterie\b|\btank\b|\btanks\b|\bpanzer\b/i, searchTags: ["soldiers", "military", "troops", "tank", "panzer", "wehrmacht"] },
  { pattern: /\boorlog\b|\bbattle\b|\bfront\b|\bgevecht\b|\binvasie\b|\binvasion\b|\bblitzkrieg\b/i, searchTags: ["war", "battle", "front", "invasion", "combat"] },
  { pattern: /\bparade\b|\boptocht\b|\bmars\b|\bmarch\b/i, searchTags: ["parade", "march", "military parade"] },
  { pattern: /\bberghof\b|\badlerhorst\b|\beagles?\s*nest\b|\bwolfsschanze\b|\bwolf\s*lair\b/i, searchTags: ["berghof", "eagles nest", "wolf's lair", "wolfsschanze", "hitler"] },
  { pattern: /\bvliegtuig\b|\bairplane\b|\baircraft\b|\bluchtaanval\b|\bbombardement\b|\bbombing\b/i, searchTags: ["aircraft", "airplane", "bombing", "air raid"] },
  { pattern: /\bvlag\b|\bswastika\b|\bhakenkruis\b/i, searchTags: ["swastika", "nazi flag", "flag"] },
];

const LABEL_STOP = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "have", "has", "had", "this", "that", "these", "those",
  "de", "het", "een", "en", "van", "op", "te", "dat", "die", "zijn", "werd", "wordt", "niet", "also",
  "when", "then", "year", "years", "during", "after", "before", "into", "over", "under", "while",
  "where", "which", "who", "there", "their", "they", "would", "could", "should", "became", "become",
]);

function collectTagsFromEntries(cleaned: string, entries: TagEntry[]): string[] {
  const tags = new Set<string>();
  for (const entry of entries) {
    if (entry.pattern.test(cleaned)) {
      for (const t of entry.searchTags) tags.add(t);
    }
  }
  return [...tags];
}

/** Tags for archive asset search (English/lowercase slugs) — any topic, from the spoken sentence. */
export function extractSalientBeatTokens(beatText: string): string[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  const proper = [...cleaned.matchAll(/\b[A-ZÀ-ÿ][a-zà-ÿ]{2,}\b/g)]
    .map((m) => m[0]!.toLowerCase())
    .filter((w) => !LABEL_STOP.has(w));
  const lower = cleaned.toLowerCase();
  const words = lower
    .replace(/[^a-z0-9à-ÿ\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !LABEL_STOP.has(w) && !/^\d{4}$/.test(w));
  return [...new Set([...proper, ...words])].slice(0, 10);
}

export function extractVisualSearchTags(beatText: string): string[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  const tags = new Set<string>([
    ...collectTagsFromEntries(cleaned, PLACE_ENTRIES),
    ...collectTagsFromEntries(cleaned, ENTITY_SEARCH_ENTRIES),
    ...collectTagsFromEntries(cleaned, SCENE_SEARCH_ENTRIES),
    ...extractSalientBeatTokens(beatText),
  ]);
  const years = cleaned.match(/\b(1[0-9]{3}|20[0-9]{2})\b/g);
  if (years) for (const y of years) tags.add(y);
  return [...tags].slice(0, 20);
}

/** Scene/setting tags only (bunker, rally, troops…). */
export function extractSceneSearchTags(beatText: string): string[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  return collectTagsFromEntries(cleaned, SCENE_SEARCH_ENTRIES).slice(0, 8);
}

/** Entity tags (Hitler, Nazi…) for archive search. */
export function extractEntitySearchTags(beatText: string): string[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  return collectTagsFromEntries(cleaned, ENTITY_SEARCH_ENTRIES).slice(0, 6);
}

/** Primary geographic anchor for beat search (e.g. Duitsland → germany). */
export function extractPrimaryGeoSearchTag(beatText: string): string | null {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  for (const entry of PLACE_ENTRIES) {
    if (entry.pattern.test(cleaned)) return entry.searchTags[0] ?? null;
  }
  return null;
}

/** Best single search anchor — scene+entity beats generic geo (e.g. hitler bunker). */
export function extractPrimaryVisualAnchor(beatText: string): string | null {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").toLowerCase();
  const scenes = collectTagsFromEntries(cleaned, SCENE_SEARCH_ENTRIES);
  const entities = collectTagsFromEntries(cleaned, ENTITY_SEARCH_ENTRIES);
  if (entities.length > 0 && scenes.length > 0) {
    return `${entities[0]} ${scenes[0]}`;
  }
  if (scenes.length > 0) return scenes[0] ?? null;
  const geo = extractPrimaryGeoSearchTag(beatText);
  if (geo) return geo;
  if (entities.length > 0) return entities[0] ?? null;
  const salient = extractSalientBeatTokens(beatText);
  if (salient.length >= 2) return `${salient[0]} ${salient[1]}`;
  if (salient.length === 1) return salient[0] ?? null;
  return null;
}

function spokenLabelForGeo(cleaned: string, entry: TagEntry): string {
  if (entry.label) {
    const m = cleaned.match(entry.pattern);
    if (m?.[0]) return m[0].toUpperCase().slice(0, 28);
  }
  return (entry.searchTags[0] ?? "").toUpperCase().slice(0, 28);
}

/** On-screen place names only (years handled separately). */
export function extractVoiceLabelTerms(beatText: string): VoiceLabelTerm[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  const lower = cleaned.toLowerCase();
  const out: VoiceLabelTerm[] = [];
  const seen = new Set<string>();

  for (const entry of PLACE_ENTRIES) {
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

  return out.slice(0, 2);
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
