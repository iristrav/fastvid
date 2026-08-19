/**
 * Universal media research engine — Laag 1 (intent) + Laag 3 (ranking).
 * Laag 2 (multi-source fetch) and Laag 4 (montage) live in videoPipeline.ts.
 */
import path from "path";
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";
import { asVideoTitleString, coerceVisionString, coercePersonName, queryStringsMinLen, toQueryString, uniqueQueryStrings } from "./stringCoercion";

export type MediaTopicKind = "person" | "historical" | "space" | "news" | "general";

export type MediaSourceKind =
  | "person_celebrity"
  | "wikimedia_video"
  | "youtube_cc"
  | "internet_archive"
  | "gdelt"
  | "nasa"
  | "wikimedia_image"
  | "openverse"
  | "unsplash"
  | "serpapi"
  | "europeana"
  | "flickr"
  | "pexels"
  | "pixabay";

/** What a beat is about — drives source priority and ranking weights. */
export interface MediaSearchIntent {
  beatText: string;
  searchQueries: string[];
  keywords: string[];
  primaryPerson: string;
  persons: string[];
  topicKind: MediaTopicKind;
  videoTitle?: string;
  powerWord: string;
  personTopicLock: boolean;
  spaceTopic: boolean;
  muskTopic: boolean;
}

export interface MediaCandidate {
  path: string;
  query: string;
  source: MediaSourceKind;
  isVideo: boolean;
  score?: number;
}

/** Base authenticity tier per source (higher = prefer real footage over stock). */
export const SOURCE_BASE_SCORE: Record<MediaSourceKind, number> = {
  internet_archive: 98,
  wikimedia_video: 96,
  person_celebrity: 95,
  youtube_cc: 90,
  gdelt: 86,
  nasa: 85,
  wikimedia_image: 70,
  openverse: 65,
  unsplash: 62,
  serpapi: 60,
  europeana: 58,
  flickr: 55,
  pexels: 40,
  pixabay: 38,
};

const HISTORICAL_TOPIC_RE =
  /\b(19\d{2}|20\d{2}|war|battle|empire|ancient|century|titanic|medieval|revolution|dynasty|civilization|archaeolog|historical|vintage|ww1|ww2|world war|southampton|colosseum|pyramid|pharaoh|roman|greek|viking|renaissance)\b/i;

const NEWS_TOPIC_RE =
  /\b(interview|breaking|scandal|controversy|trial|verdict|announcement|keynote|press conference|news report)\b/i;

const RELEVANCE_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "will", "would", "could",
  "should", "may", "might", "this", "that", "these", "those", "it", "its", "we", "they", "he", "she",
  "you", "i", "my", "our", "their", "his", "her", "your", "as", "so", "if", "not", "no", "up", "out",
  "about", "into", "than", "then", "when", "where", "who", "which", "what", "how", "all", "each",
  "more", "most", "also", "just", "very", "over", "after", "before", "through", "during", "between",
  "while", "because", "since", "even", "only", "still", "now", "here", "there", "some", "any",
  "every", "one", "two", "three", "first", "second", "third", "new", "like", "said", "says",
]);

function tokenizeForRelevance(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !RELEVANCE_STOP_WORDS.has(w));
}

function keywordOverlap(text: string, keywords: string[]): number {
  const hay = text.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (kw.length >= 3 && hay.includes(kw.toLowerCase())) score++;
  }
  return score;
}

function mentionsPerson(haystack: string, personName: string): boolean {
  const name = coercePersonName(personName);
  if (!name) return false;
  const hay = haystack.toLowerCase();
  const parts = name.toLowerCase().split(/\s+/).filter((p) => p.length >= 2);
  if (!parts.length) return false;
  if (parts.length === 1) return hay.includes(parts[0]);
  const last = parts[parts.length - 1];
  if (hay.includes(last)) return true;
  return parts.every((p) => hay.includes(p));
}

/** Infer topic category from beat text and context flags. */
export function inferTopicKind(
  beatText: string,
  primaryPerson: string,
  spaceTopic: boolean,
  personTopicLock: boolean
): MediaTopicKind {
  if (spaceTopic) return "space";
  if (personTopicLock) return "person";
  if (HISTORICAL_TOPIC_RE.test(beatText)) return "historical";
  if (NEWS_TOPIC_RE.test(beatText)) return "news";
  if (coercePersonName(primaryPerson)) return "person";
  return "general";
}

/** Historical documentary — Titanic, WWII, etc. (not celebrity person-docs). */
export function isHistoricalDocumentary(...texts: (string | undefined)[]): boolean {
  const hay = texts.filter(Boolean).join(" ");
  return hay.length > 0 && HISTORICAL_TOPIC_RE.test(hay);
}

/** Build search intent for one beat (Laag 1). */
export function buildMediaSearchIntent(params: {
  beatText: string;
  searchQueries: string[];
  keywords: string[];
  primaryPerson: string;
  persons: string[];
  videoTitle?: string;
  powerWord: string;
  personTopicLock: boolean;
  spaceTopic: boolean;
  muskTopic: boolean;
}): MediaSearchIntent {
  const topicHay = [params.beatText, asVideoTitleString(params.videoTitle)].filter(Boolean).join(" ");
  const topicKind = inferTopicKind(
    topicHay,
    params.primaryPerson,
    params.spaceTopic,
    params.personTopicLock
  );
  const queries = Array.from(
    new Set(queryStringsMinLen(params.searchQueries, 3))
  ).slice(0, 8);

  return {
    beatText: params.beatText,
    searchQueries: queries,
    keywords: params.keywords,
    primaryPerson: params.primaryPerson,
    persons: params.persons,
    topicKind,
    videoTitle: params.videoTitle,
    powerWord: params.powerWord,
    personTopicLock: params.personTopicLock,
    spaceTopic: params.spaceTopic,
    muskTopic: params.muskTopic,
  };
}

/** Topic-specific source boost (on top of SOURCE_BASE_SCORE). */
function topicSourceBoost(source: MediaSourceKind, intent: MediaSearchIntent): number {
  switch (intent.topicKind) {
    case "historical":
      if (source === "internet_archive" || source === "europeana") return 15;
      if (source === "wikimedia_video" || source === "wikimedia_image") return 12;
      if (source === "youtube_cc") return 6;
      if (source === "pexels" || source === "pixabay") return -15;
      break;
    case "person":
      if (source === "person_celebrity" || source === "gdelt" || source === "youtube_cc") return 10;
      if (source === "pexels" || source === "pixabay") return intent.personTopicLock ? -20 : -5;
      break;
    case "space":
      if (source === "nasa" || source === "youtube_cc") return 12;
      if (source === "wikimedia_video") return 6;
      break;
    case "news":
      if (source === "gdelt" || source === "youtube_cc") return 10;
      if (source === "internet_archive") return 6;
      break;
    default:
      break;
  }
  return 0;
}

/** Score one candidate against intent (Laag 3). */
export function scoreMediaCandidate(candidate: MediaCandidate, intent: MediaSearchIntent): number {
  const hay = `${candidate.query} ${candidate.path} ${intent.beatText}`.toLowerCase();
  const beatTokens = tokenizeForRelevance(intent.beatText);
  const queryTokens = tokenizeForRelevance(candidate.query);

  let score = SOURCE_BASE_SCORE[candidate.source] ?? 30;
  score += topicSourceBoost(candidate.source, intent);
  score += keywordOverlap(hay, intent.keywords) * 3;
  score += keywordOverlap(hay, beatTokens) * 2;
  score += keywordOverlap(hay, queryTokens);

  if (intent.powerWord && hay.includes(intent.powerWord.toLowerCase())) score += 6;
  if (intent.primaryPerson && mentionsPerson(hay, intent.primaryPerson)) score += 8;

  // Prefer real video over stills when narration describes action/events.
  if (candidate.isVideo) score += 5;
  else if (NEWS_TOPIC_RE.test(intent.beatText) || intent.topicKind === "person") score -= 3;

  if (intent.topicKind === "historical" || intent.topicKind === "news") {
    if (candidate.isVideo) score += 25;
    else score -= 35;
    if (candidate.source === "pexels" || candidate.source === "pixabay") score -= 50;
    if (
      candidate.source === "serpapi" ||
      candidate.source === "unsplash" ||
      candidate.source === "openverse" ||
      candidate.source === "wikimedia_image"
    ) {
      score -= 30;
    }
  }

  // Penalize generic stock when we have a specific topic anchor.
  if (
    (candidate.source === "pexels" || candidate.source === "pixabay") &&
    intent.topicKind !== "general" &&
    keywordOverlap(hay, beatTokens) < 2
  ) {
    score -= 12;
  }

  return score;
}

const STOCK_ONLY_SOURCES: MediaSourceKind[] = ["pexels", "pixabay"];
const STILL_ONLY_SOURCES: MediaSourceKind[] = [
  "serpapi",
  "unsplash",
  "openverse",
  "wikimedia_image",
];

/**
 * Canonical clip order: Archive/Wikimedia video → real stills (vision-gated) → Pexels → AI.
 * Default on (REAL_FOOTAGE_FIRST=false disables for debugging only).
 */
export function realFootageFirstEnabled(): boolean {
  return process.env.REAL_FOOTAGE_FIRST !== "false";
}

/** Licensed stock (Pexels/Pixabay) only after authentic sources fail. */
export function licensedStockFallbackEnabled(): boolean {
  return realFootageFirstEnabled();
}

/** True when beats should prefer archival/real video over Ken Burns stills. */
export function prefersArchivalVideo(intent: MediaSearchIntent): boolean {
  return intent.topicKind === "historical" || intent.topicKind === "news";
}

/** True when only authentic video should be adopted before stills and licensed stock. */
export function prefersRealFootageOnly(intent: MediaSearchIntent): boolean {
  return realFootageFirstEnabled() || prefersArchivalVideo(intent);
}

/** What kind of thing a visual target names — drives query phrasing and provider preference. */
export type VisualTargetType =
  | "person"
  | "event"
  | "location"
  | "object"
  | "historical_context"
  | "archival"
  | "abstract";

export interface VisualTarget {
  text: string;
  type: VisualTargetType;
}

// Small, targeted vocabulary of documentary/historical event verbs — not general NER, just
// enough to tell "Hitler died in the bunker" apart from a plain description so the query
// builder below can produce an event-flavored variant in addition to an entity-only one.
const EVENT_CUE_RE =
  /\b(die[sd]?|death|killed|suicide|assassinat\w*|invad\w*|attack\w*|bomb\w*|surrender\w*|escap\w*|arrest\w*|execut\w*|declar\w*|sign\w*|launch\w*|crash\w*|sank|sink\w*|explod\w*|liberat\w*|captur\w*|fled|flee\w*|born|marri\w*|coronation|revolt\w*|uprising|battle\w*|siege|trial)\b/i;

/**
 * Point 3 (final multi-candidate visual selection patch — contextual beat type): exported
 * (visibility-only, same regex, same behavior) so videoPipeline.ts's classifyBeatFocus can
 * detect whether a beat names a concrete place without a second, parallel location-phrase
 * pattern.
 */
export function extractLocationPhrase(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(
    /\b(?:in|at|near|over|across|through|inside)\s+((?:[A-Z][a-zA-Z'-]+)(?:\s+[A-Z][a-zA-Z'-]+){0,2})\b/
  );
  return m?.[1]?.trim() || null;
}

function extractEventPhrase(beatText: string, anchor: string): string | null {
  const m = beatText.match(EVENT_CUE_RE);
  if (!m) return null;
  return anchor ? `${anchor} ${m[0]}` : m[0];
}

/**
 * Point 4 (next-level visual selection — event/action matching): the bare event/action verb a
 * beat is centered on ("died", "married", "launched", ...), reusing the same small documentary
 * event vocabulary as extractBeatVisualTargets/extractEventPhrase above rather than a second,
 * parallel word list. Returns null when the beat doesn't center on a recognizable action — that
 * is the common case, and callers must treat it as "no event signal to check", not evidence of
 * anything.
 */
export function extractEventCue(beatText: string): string | null {
  return beatText.match(EVENT_CUE_RE)?.[0]?.toLowerCase() ?? null;
}

// Small, targeted vocabulary of concrete physical objects a documentary beat might center on —
// same spirit and size as EVENT_CUE_RE, drawn from the final visual-selection hardening task's
// own worked examples, not a general object-detection list.
const OBJECT_CUE_RE =
  /\b(gun|pistol|revolver|rifle|cyanide|poison|capsule|document|documents|letter|letters|tank|aircraft|airplane|plane|building|bunker|ship|vessel|map|uniform|weapon|grenade|medal|flag|helmet|sword|knife)\b/i;

/**
 * Point 3/18 (final visual intelligence hardening — object/topic beats): the bare object noun a
 * beat centers on ("pistol", "bunker", "document", ...). Returns null when the beat doesn't name
 * a recognizable physical object — callers must treat that as "no object signal to check," not
 * evidence of anything. Checked after event/location in classifyBeatFocus's precedence, so a beat
 * that already has a clearer event or location signal is never reclassified as object-focused.
 */
export function extractObjectCue(beatText: string): string | null {
  return beatText.match(OBJECT_CUE_RE)?.[0]?.toLowerCase() ?? null;
}

/**
 * Deterministic, LLM-free extraction of multiple concrete visual targets for one beat (Point 1
 * of the visual-selection upgrade) — reuses only signals already available in this module/intent
 * (persons, beat text, video title, year). Not a general NER system; a small, targeted set of
 * patterns feeding the query-variety builder below, in the spirit of the existing
 * inferTopicKind/isHistoricalDocumentary helpers rather than a new architecture.
 */
export function extractBeatVisualTargets(
  beatText: string,
  intent: Pick<MediaSearchIntent, "persons" | "primaryPerson" | "powerWord" | "searchQueries">,
  videoTitle?: string
): VisualTarget[] {
  const targets: VisualTarget[] = [];
  const seen = new Set<string>();
  const add = (text: string | undefined | null, type: VisualTargetType) => {
    const t = text?.trim();
    if (!t || t.length < 3) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ text: t, type });
  };

  for (const p of [intent.primaryPerson, ...(intent.persons ?? [])]) {
    add(coercePersonName(p) || undefined, "person");
  }

  const location = extractLocationPhrase(beatText) || extractLocationPhrase(asVideoTitleString(videoTitle));
  add(location, "location");

  const anchor = intent.powerWord?.trim() || intent.searchQueries[0]?.trim() || location || targets[0]?.text || "";
  add(extractEventPhrase(beatText, anchor), "event");

  const yearMatch = beatText.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
  if (yearMatch) add(`${anchor} ${yearMatch[0]}`.trim(), "historical_context");

  if (anchor) add(anchor, "archival");

  if (!targets.length && intent.searchQueries[0]) add(intent.searchQueries[0], "abstract");

  return targets;
}

/**
 * Archival YouTube/Wiki/Archive search phrases for historical beats — one query variant per
 * concrete visual target (person/location/event/historical_context/archival) instead of a
 * single fixed anchor phrase. Previously this templated ship-sinking phrasing onto every
 * historical topic regardless of subject ("RMS ${anchor}", "${anchor} sinking", "${anchor}
 * ship") — harmless for a Titanic beat, nonsense for anything else (a Hitler beat produced
 * literal "RMS Hitler" / "Hitler sinking" queries).
 */
export function buildHistoricalArchivalQueries(
  intent: MediaSearchIntent,
  beatText: string
): string[] {
  const targets = extractBeatVisualTargets(beatText, intent, intent.videoTitle);
  const anchor = intent.powerWord?.trim() || intent.searchQueries[0]?.trim() || targets[0]?.text || "";
  if (!anchor && !targets.length) return intent.searchQueries.slice(0, 6);

  const out: string[] = [];
  // Always generate a broad, generic anchor-based set first — this guarantees at least the
  // same query BREADTH the old fixed 7-phrase list did (regression found via F3-39: a beat
  // whose extracted targets collapse to just one or two entries used to starve the provider
  // query-cache of fresh candidates across repeated top-up attempts, since a render-scoped
  // cachedProviderSearch only returns a fresh result for a genuinely new query string — fewer
  // distinct queries meant later attempts kept re-hitting the same cached (and already-adopted,
  // hence duplicate-rejected) result instead of finding new ones).
  const yearMatch = beatText.match(/\b(18|19|20)\d{2}\b/);
  const year = yearMatch?.[0] ?? "";
  if (anchor) {
    out.push(
      `${anchor} archival footage`,
      `${anchor} historical documentary`,
      `${anchor} original footage`,
      `${anchor} historical footage`,
      year ? `${anchor} ${year}` : anchor
    );
  }
  // Layered on top: one extra variant per distinct visual target actually found (Point 1/2 —
  // multiple concrete visual targets, not just the single anchor string), when it adds real
  // phrasing variety beyond the generic set above.
  for (const target of targets) {
    switch (target.type) {
      case "person":
      case "location":
        out.push(`${target.text} archival footage`);
        break;
      case "event":
        out.push(target.text);
        break;
      case "historical_context":
        out.push(`${target.text} historical footage`);
        break;
      default:
        break;
    }
  }
  out.push(...intent.searchQueries);
  return uniqueQueryStrings(out, 3).slice(0, 8);
}

/** Result of anchorQueriesToHistoricalContext — `anchored` false means untouched inputs. */
export interface HistoricalAnchoredQueries {
  primaryQuery: string;
  extraQueries: string[];
  anchored: boolean;
  /** The year the anchoring used ("" when the intent stated no year — none is ever invented). */
  year: string;
}

const QUERY_YEAR_RE = /\b(1[0-9]{3}|20[0-2][0-9])\b/;

/**
 * P1-B (render 517): the funnel/scene-pool queries came straight from the scene's stock-style
 * phrasing and carried no period at all — "berlin city skyline", "russia city street" — so for
 * historical documentaries the pool filled with present-day footage of the right place in the
 * wrong century. This anchors those queries to the historical context the script itself states:
 * the first concrete year in the scene text (or title), the primary person when THIS scene
 * mentions them, and the scene's location phrase. Strictly deterministic and strictly sourced
 * from the existing beat intent — no LLM call, no invented dates, no hardcoded topics (the
 * activation gate is the existing isHistoricalDocumentary detector). The original queries are
 * always kept in the list after the anchored variants, so a too-narrow anchored phrasing can
 * only ADD era-correct candidates, never shrink the pool below what it was.
 */
export function anchorQueriesToHistoricalContext(params: {
  primaryQuery: string;
  extraQueries?: string[];
  sceneText: string;
  videoTitle?: string;
  primaryPerson?: string;
}): HistoricalAnchoredQueries {
  const primaryQuery = toQueryString(params.primaryQuery);
  const extraQueries = queryStringsMinLen(params.extraQueries ?? [], 3);
  const unchanged: HistoricalAnchoredQueries = { primaryQuery, extraQueries, anchored: false, year: "" };
  const title = asVideoTitleString(params.videoTitle);
  const sceneText = params.sceneText ?? "";
  if (!primaryQuery || !isHistoricalDocumentary(title, sceneText)) return unchanged;

  // Period anchor: only a year the script/title literally states. Scene text wins over title
  // (a scene about 1923 in a video titled "… 1945" should search 1923, not 1945).
  const year = sceneText.match(QUERY_YEAR_RE)?.[0] ?? title.match(QUERY_YEAR_RE)?.[0] ?? "";
  // Person anchor only when THIS scene's own text mentions them — the title mentioning the
  // person is true for every scene of the video and would inject the name into beats that are
  // not about them (the "query must come from the existing beat intent" rule).
  const person = coercePersonName(params.primaryPerson);
  const personInScene = person.length > 0 && mentionsPerson(sceneText, person);
  if (!year && !personInScene) return unchanged;

  const withYear = (q: string) => (year && !QUERY_YEAR_RE.test(q) ? `${q} ${year}` : q);
  const anchoredPrimary = withYear(primaryQuery);
  const location = extractLocationPhrase(sceneText) || extractLocationPhrase(title);

  const anchoredExtras: string[] = [];
  if (personInScene) {
    anchoredExtras.push(withYear(location ? `${person} ${location}` : person));
  }
  if (location && year) anchoredExtras.push(`${location} ${year}`);
  for (const q of extraQueries.slice(0, 2)) anchoredExtras.push(withYear(q));

  const merged = uniqueQueryStrings([...anchoredExtras, primaryQuery, ...extraQueries], 3)
    .filter((q) => q !== anchoredPrimary)
    .slice(0, 6);
  return { primaryQuery: anchoredPrimary, extraQueries: merged, anchored: true, year };
}

/** Split ranked pool: authentic video → stills → licensed stock (last). */
export function partitionCandidatesForIntent(
  ranked: MediaCandidate[],
  intent: MediaSearchIntent
): {
  videoFirst: MediaCandidate[];
  stillFallback: MediaCandidate[];
  stockFallback: MediaCandidate[];
} {
  if (!prefersRealFootageOnly(intent)) {
    return { videoFirst: ranked, stillFallback: [], stockFallback: [] };
  }
  const stockFallback = ranked.filter((c) => STOCK_ONLY_SOURCES.includes(c.source));
  const videoFirst = ranked.filter(
    (c) =>
      c.isVideo &&
      !STOCK_ONLY_SOURCES.includes(c.source) &&
      !STILL_ONLY_SOURCES.includes(c.source)
  );
  const stillFallback = ranked.filter(
    (c) => !videoFirst.includes(c) && !stockFallback.includes(c)
  );
  return { videoFirst, stillFallback, stockFallback };
}

/** Rank candidates best-first (Laag 3). */
export function rankMediaCandidates(
  candidates: MediaCandidate[],
  intent: MediaSearchIntent,
  enrichScore?: (candidate: MediaCandidate, baseScore: number) => number
): MediaCandidate[] {
  const seen = new Set<string>();
  const unique: MediaCandidate[] = [];

  for (const c of candidates) {
    if (!c.path?.trim() || seen.has(c.path)) continue;
    seen.add(c.path);
    unique.push(c);
  }

  return unique
    .map((c) => {
      const base = scoreMediaCandidate(c, intent);
      const score = enrichScore ? enrichScore(c, base) : base;
      return { ...c, score };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Ordered source list for parallel fetch — topic-aware priority. */
export function prioritizedSourcesForIntent(intent: MediaSearchIntent): MediaSourceKind[] {
  const base: MediaSourceKind[] = [
    "internet_archive",
    "wikimedia_video",
    "person_celebrity",
    "youtube_cc",
    "gdelt",
    "nasa",
    "wikimedia_image",
    "openverse",
    "unsplash",
    "europeana",
    "flickr",
    "serpapi",
    "pexels",
    "pixabay",
  ];

  const weight = (src: MediaSourceKind): number =>
    (SOURCE_BASE_SCORE[src] ?? 0) + topicSourceBoost(src, intent);

  return [...base].sort((a, b) => weight(b) - weight(a));
}

const AI_RANK_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "media_relevance_rank",
    strict: true,
    schema: {
      type: "object",
      properties: {
        rankings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              relevance: { type: "number" },
            },
            required: ["id", "relevance"],
            additionalProperties: false,
          },
        },
      },
      required: ["rankings"],
      additionalProperties: false,
    },
  },
};

/** Merge LLM relevance scores (0–10) into candidate scores. Exported for tests. */
export function mergeAiRelevanceScores(
  candidates: MediaCandidate[],
  aiScores: Map<number, number>,
  weight = 6
): MediaCandidate[] {
  return candidates.map((c, idx) => {
    const ai = aiScores.get(idx);
    if (ai == null || Number.isNaN(ai)) return c;
    const clamped = Math.max(0, Math.min(10, ai));
    return { ...c, score: (c.score ?? 0) + clamped * weight };
  });
}

function parseAiRankResponse(content: string, count: number): Map<number, number> {
  const out = new Map<number, number>();
  try {
    const parsed = JSON.parse(content) as { rankings?: Array<{ id?: number; relevance?: number }> };
    for (const row of parsed.rankings ?? []) {
      if (typeof row.id !== "number" || typeof row.relevance !== "number") continue;
      if (row.id < 0 || row.id >= count) continue;
      out.set(row.id, row.relevance);
    }
  } catch {
    // ignore malformed LLM output
  }
  return out;
}

/**
 * Re-rank top keyword-scored candidates with one LLM call (Laag 3 — semantic).
 * Skips silently when no LLM key or ENABLE_MEDIA_AI_RANK=false.
 */
export async function applyAiRelevanceRanking(
  candidates: MediaCandidate[],
  intent: MediaSearchIntent,
  options: { maxCandidates?: number; timeoutMs?: number; fastMode?: boolean } = {}
): Promise<MediaCandidate[]> {
  if (process.env.ENABLE_MEDIA_AI_RANK === "false" || !ENV.forgeApiKey) {
    return candidates;
  }
  const maxCandidates = options.maxCandidates ?? (options.fastMode ? 6 : 10);
  const pool = candidates.slice(0, maxCandidates);
  if (pool.length < 2) return candidates;

  const lines = pool.map((c, idx) => {
    const file = path.basename(c.path);
    return `${idx}: source=${c.source} query="${c.query}" file="${file}" video=${c.isVideo}`;
  });

  const prompt = `You rank stock/archival media for a documentary video beat.

Narration beat: "${intent.beatText}"
Topic kind: ${intent.topicKind}
${intent.primaryPerson ? `Primary person: ${intent.primaryPerson}` : ""}
${intent.videoTitle ? `Video title: ${intent.videoTitle}` : ""}

Candidates:
${lines.join("\n")}

Score each candidate id 0–10 for visual relevance to the narration.
10 = perfect match (real footage of the exact subject/event).
0 = completely unrelated generic b-roll.

Prefer authentic archival/real footage over generic stock when the beat names a specific person, place, date, or event.`;

  try {
    const response = await Promise.race([
      invokeLLM({
        messages: [
          { role: "system", content: "You are a documentary footage researcher. Return JSON only." },
          { role: "user", content: prompt },
        ],
        preferProvider: "groq",
        response_format: AI_RANK_JSON_SCHEMA,
        maxTokens: 1024,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AI rank timeout")), options.timeoutMs ?? 12_000)
      ),
    ]);

    const content = coerceVisionString(response.choices[0]?.message?.content);
    if (!content) return candidates;

    const aiScores = parseAiRankResponse(content, pool.length);
    if (!aiScores.size) return candidates;

    const boosted = mergeAiRelevanceScores(pool, aiScores);
    const boostedByPath = new Map(boosted.map((c) => [c.path, c.score ?? 0]));
    const reranked = candidates
      .map((c) => ({
        ...c,
        score: boostedByPath.get(c.path) ?? c.score,
      }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    console.log(`[MediaResearch] AI re-ranked ${aiScores.size} candidates for beat`);
    return reranked;
  } catch (err) {
    console.warn(`[MediaResearch] AI ranking skipped:`, (err as Error).message);
    return candidates;
  }
}
