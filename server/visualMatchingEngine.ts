/**
 * Visual Matching Engine V1
 *
 * For each voice-over sentence, produces a structured visual intent
 * (VisualSceneAnalysis) and scores candidate images/clips against it.
 *
 * Scoring formula — Subject 40 · Action 30 · Location 10 · Context 20 = 100.
 * Adopt threshold: 70 default for all topics; override via WIKIMEDIA_V1_THRESHOLD.
 *
 * Source priority: Wikimedia → Archive → Pexels → Pixabay.
 */
import { extractBeatGeoPlaceTags, extractEntitySearchTags } from "./visualBeatTags";
import { extractTitleGeoPlaceTags } from "./worldGeoSlugs";
import { visualMetadataPassesBeatGate } from "./vidrushQuality";

export interface VisualSceneAnalysis {
  sentence: string;
  /** Broader topic / event name (e.g. "Operation Sea Lion"). */
  main_topic: string;
  /** Who or what would be visible in the frame (e.g. "German military leadership"). */
  visual_subject: string;
  /** Visual action depicted (e.g. "conference planning"). */
  visual_action: string;
  /** Geographic context (e.g. "Britain"). */
  visual_location: string;
  /** Full natural-language description for image search. */
  visual_description: string;
  /** Best single search keyword. */
  keyword: string;
}

/** Default minimum score (0-100) to adopt a Wikimedia V1 still — same for all topics. */
export const V1_ADOPTION_THRESHOLD = 70;

// ─── Token helpers ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by","from",
  "is","are","was","were","be","been","being","have","has","had","will","would","could",
  "should","may","might","this","that","these","those","it","its","we","they","he","she",
  "you","i","my","our","their","his","her","your","as","so","if","not","no","up","out",
  "about","into","than","then","when","where","who","which","what","how","all","each",
  "more","most","also","just","very","over","after","before","through","during","between",
  "while","because","since","even","only","still","now","here","there","some","any",
  "every","one","two","three","first","second","third","new","like","said","says",
  "did","do","does","can",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/** Fraction of field tokens found anywhere in haystack (0-1). Returns 0 when field is empty. */
function matchFraction(haystack: string, field: string): number {
  const trimmed = field.trim();
  if (!trimmed) return 0;
  const tokens = tokenize(trimmed);
  if (!tokens.length) return 0;
  const hay = haystack.toLowerCase();
  const hits = tokens.filter((t) => hay.includes(t)).length;
  return Math.min(1, hits / tokens.length);
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Score a visual candidate against a scene analysis.
 * Pass concatenated title + snippet + description as `candidateMetadata`.
 * Returns 0–100.  Adopt when ≥ V1_ADOPTION_THRESHOLD (85).
 */
export function scoreVisualForScene(
  candidateMetadata: string,
  analysis: VisualSceneAnalysis
): number {
  const hay = candidateMetadata.toLowerCase();
  const subjectScore = matchFraction(hay, analysis.visual_subject) * 40;
  const actionScore = matchFraction(hay, analysis.visual_action) * 30;
  const locationScore = matchFraction(hay, analysis.visual_location) * 10;
  const contextScore = matchFraction(hay, `${analysis.main_topic} ${analysis.keyword}`) * 20;
  return Math.round(subjectScore + actionScore + locationScore + contextScore);
}

// ─── Entity extraction ────────────────────────────────────────────────────────

const HISTORICAL_EVENT_RE =
  /\b(?:Operation\s+[A-Z]\w+|Battle\s+of\s+[A-Z]\w+|Siege\s+of\s+[A-Z]\w+|Fall\s+of\s+[A-Z]\w+|Invasion\s+of\s+[A-Z]\w+|[A-Z]\w+(?:\s+[A-Z]\w+)?\s+(?:War|Revolution|Uprising|Treaty|Conference|Alliance|Crisis|Offensive|Retreat|Accord|Pact|Blockade|Massacre|Holocaust|Blitzkrieg|D-Day|Airlift))\b/g;

const LOCATION_RE =
  /\b(?:Afghanistan|Africa|Algeria|America|Amsterdam|Asia|Australia|Austria|Belgium|Berlin|Britain|Brussels|Budapest|Burma|China|Crimea|Cyprus|Czechoslovakia|Denmark|Egypt|England|Europe|Finland|France|Germany|Greece|Holland|Hungary|India|Iran|Iraq|Ireland|Israel|Italy|Japan|Jordan|Korea|Libya|London|Moscow|Netherlands|Normandy|Norway|Pacific|Pakistan|Palestine|Paris|Poland|Portugal|Rome|Russia|Scandinavia|Soviet|Spain|Syria|Turkey|Ukraine|United\s+Kingdom|United\s+States|USSR|Vietnam|Warsaw|Washington|Yugoslavia)\b/gi;

const PERSON_NAME_RE = /\b([A-Z][a-z]{1,18}(?:\s+(?:von\s+|van\s+|de\s+)?[A-Z][a-z]{1,18}){1,3})\b/g;

/** Maps narrative verbs to the visual context words most likely present in image metadata. */
const NARRATIVE_TO_VISUAL: Array<[RegExp, string]> = [
  [/\b(attack|invad|bomb|assault|artillery|shelling|airstrike|blitz)\w*\b/i, "military attack battle bombing"],
  [/\b(march|advanc|deploy|troop|regiment|division|column)\w*\b/i, "military march soldiers troops"],
  [/\b(speech|address|spoke|oration|proclam|announc|broadcast|radio)\w*\b/i, "speech address podium"],
  [/\b(sign|treaty|agreement|pact|ceasefire|armistice|accord)\w*\b/i, "ceremony signing treaty"],
  [/\b(surren|defeat|captur|prisoner|pow|occupation)\w*\b/i, "surrender defeat prisoner"],
  [/\b(meet|conference|summit|discuss|plan|strateg|headquarter|command|cabinet)\w*\b/i, "conference meeting headquarters"],
  [/\b(decid|chose|resolv|order|command|direct|instruct)\w*\b/i, "conference planning command"],
  [/\b(flee|retreat|withdr|evacuat|exodus)\w*\b/i, "retreat withdrawal evacuation"],
  [/\b(built|build|construct|creat|establish|found)\w*\b/i, "construction building"],
  [/\b(execut|kill|murder|assassin|hanged|hung)\w*\b/i, "execution aftermath"],
  [/\b(liberat|free|rescue|relief)\w*\b/i, "liberation celebration"],
  [/\b(resist|defend|hold|fortif)\w*\b/i, "defense fortification resistance"],
  [/\b(protest|demonstrat|uprising|revolt|riot|crowd)\w*\b/i, "protest demonstration crowd"],
  [/\b(elect|vote|parliament|congress|politic)\w*\b/i, "parliament election politics"],
  [/\b(died|death|killed|casualt|victim|grave|cemetery|memorial)\w*\b/i, "memorial graves"],
  [/\b(land|disembark|beach|amphibious|shore)\w*\b/i, "landing beach amphibious"],
  [/\b(spy|espionage|sabotage|secret|clandest|underground)\w*\b/i, "espionage secret underground"],
  [/\b(bomb|destroy|ruin|wreckage|debris|aftermath)\w*\b/i, "destruction ruins aftermath"],
  [/\b(propaganda|poster|pamphlet|leaflet)\w*\b/i, "propaganda poster"],
  [/\b(ration|food|hunger|starv|supply|aid)\w*\b/i, "rationing food supply"],
];

function extractHistoricalEvents(text: string): string[] {
  const found: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(HISTORICAL_EVENT_RE.source, "g");
  while ((m = re.exec(text)) !== null) found.push(m[0]);
  return [...new Set(found)];
}

function extractLocations(text: string): string[] {
  const found: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(LOCATION_RE.source, "gi");
  while ((m = re.exec(text)) !== null) found.push(m[0]);
  return [...new Set(found)];
}

function extractPersonNames(text: string, locationSet: Set<string>): string[] {
  const found: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(PERSON_NAME_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    const name = m[0];
    if (!locationSet.has(name.toLowerCase())) found.push(name);
  }
  return [...new Set(found)].filter((n) => n.split(/\s+/).length >= 2);
}

function deriveVisualAction(sentence: string): string {
  for (const [re, visual] of NARRATIVE_TO_VISUAL) {
    if (re.test(sentence)) return visual;
  }
  return "";
}

function bestKeyword(sentence: string, events: string[], persons: string[], locations: string[], videoTitle?: string): string {
  if (events[0]) return events[0];
  if (persons[0]) return persons[0];
  if (locations[0]) return locations[0];
  const words = sentence
    .replace(/[^a-zA-Z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !STOP_WORDS.has(w.toLowerCase()));
  if (words[0]) return words[0];
  return videoTitle?.split(/\s+/).slice(0, 3).join(" ") ?? sentence.slice(0, 30);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyse a voice-over sentence for visual matching (STAP 1).
 *
 * Example:
 *   sentence: "Hitler besloot Groot-Brittannië nooit binnen te vallen."
 *   → keyword: "Operation Sea Lion" (or extracted event)
 *   → visual_subject: "Hitler" / "German military leadership"
 *   → visual_action: "conference planning command"
 */
export function analyzeSceneVisual(
  sentence: string,
  videoTitle?: string
): VisualSceneAnalysis {
  const locations = extractLocations(sentence);
  const locationSet = new Set(locations.map((l) => l.toLowerCase()));
  const persons = extractPersonNames(sentence, locationSet);
  const events = extractHistoricalEvents(sentence);
  const visualAction = deriveVisualAction(sentence);

  const main_topic =
    (events[0] ??
      (videoTitle ? videoTitle.split(/\s+/).slice(0, 5).join(" ") : "")) ||
    sentence.slice(0, 60);

  const visual_subject =
    persons.length > 0
      ? persons.slice(0, 2).join(" and ")
      : events[0] ?? main_topic;

  const visual_location = locations[0] ?? "";

  const keyword = bestKeyword(sentence, events, persons, locations, videoTitle);

  const descParts = [
    visual_subject,
    visualAction || undefined,
    visual_location ? `in ${visual_location}` : undefined,
  ].filter((p): p is string => !!p);
  const visual_description =
    descParts.length > 0 ? descParts.join(", ") : sentence.slice(0, 80);

  return {
    sentence,
    main_topic,
    visual_subject,
    visual_action: visualAction,
    visual_location,
    visual_description,
    keyword,
  };
}

/**
 * Build Wikimedia search queries in priority order (STAP 3):
 *   1. keyword  → most specific
 *   2. visual_description  → medium specificity
 *   3. main_topic  → broadest context
 */
export function buildV1WikimediaQueries(
  analysis: VisualSceneAnalysis,
  videoTitle?: string
): string[] {
  const q1 = analysis.keyword.trim();
  const q2 = analysis.visual_description.slice(0, 80).trim();
  const q3 = analysis.main_topic.slice(0, 60).trim();
  const geo = extractBeatGeoPlaceTags(analysis.sentence);
  const titleGeo = extractTitleGeoPlaceTags(videoTitle);
  const geoQueries = [...geo, ...titleGeo]
    .slice(0, 4)
    .map((g) => `${g} documentary photograph`);
  const entityQueries = extractEntitySearchTags(analysis.sentence)
    .slice(0, 3)
    .map((e) => `${e} historical photograph`);
  return [...new Set([q1, q2, q3, ...geoQueries, ...entityQueries].filter((q) => q.length >= 3))].slice(0, 10);
}

/** Score floor for adopting a Wikimedia V1 still — universal default (override via WIKIMEDIA_V1_THRESHOLD). */
export function wikimediaV1AdoptionThreshold(_videoTitle?: string, _beatText?: string): number {
  const raw = process.env.WIKIMEDIA_V1_THRESHOLD?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 50 && n <= 95) return n;
  }
  return 65;
}

/** Second-pass Wikimedia metadata floor when strict pass finds nothing. */
export function wikimediaV1RelaxedThreshold(videoTitle?: string, beatText?: string): number {
  return Math.max(52, wikimediaV1AdoptionThreshold(videoTitle, beatText) - 12);
}

/** Reject Wikimedia metadata before download — beat-driven, all topics. */
export function wikimediaMetadataPassesBeatGate(
  metadata: string,
  videoTitle?: string,
  beatText?: string
): boolean {
  return visualMetadataPassesBeatGate(metadata, beatText ?? "", videoTitle);
}

/** @deprecated Use wikimediaMetadataPassesBeatGate */
export const wikimediaMetadataPassesGeoGate = wikimediaMetadataPassesBeatGate;

/** Whether the V1 Visual Matching Engine is active. On by default — set VISUAL_MATCHING_V1=false to disable. */
export function visualMatchingV1Enabled(): boolean {
  return process.env.VISUAL_MATCHING_V1 !== "false";
}
