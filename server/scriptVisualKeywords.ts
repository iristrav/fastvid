/**
 * Per-sentence visual planning for stock/archive footage.
 * Analyses full voice-over context (subject, action, editor intent) — not loose words.
 */
import { invokeLLM } from "./_core/llm";
import {
  extractFullNarrationText,
  parseMarkdownNarrationBlocks,
} from "./scriptWriter";
import {
  extractPrimaryGeoSearchTag,
  extractPrimaryVisualAnchor,
  isGeoWelcomeBeat,
  buildGeoWelcomeVisualQueries,
  isCyclingBeat,
  buildCyclingVisualQueries,
  isCarBeat,
  buildCarVisualQueries,
  isGovernmentBeat,
  buildGovernmentVisualQueries,
  isUrbanPlanningBeat,
  buildUrbanPlanningVisualQueries,
  isInfrastructureBeat,
  buildInfrastructureVisualQueries,
} from "./visualBeatTags";
import {
  buildEnglishVisualKeywordFromSentence,
  buildIntentFromVisualFallbackHint,
  matchVisualFallbackHint,
} from "./visualFallbackHints";
import {
  directorSceneToIntent,
  directorScenesForSceneVoice,
  estimateDirectorSceneHoldSec,
  generateVisualDirectorPlan,
  hasDirectorPlan,
  mergeDirectorScenesForPacing,
  mergeVisualDirectorIntoMetadata,
  parseVisualDirectorFromMetadata,
  VISUAL_DIRECTOR_MAX_SEC,
  VISUAL_DIRECTOR_MIN_SEC,
  type VisualDirectorScene,
} from "./visualDirector";
import { maxDirectorBeatsForSceneDuration } from "./vidrushQuality";

export type { VisualDirectorScene };
export { hasDirectorPlan, directorSceneToIntent, generateVisualDirectorPlan };

export type ScriptVisualKeywordEntry = {
  sentence: string;
  keyword: string;
};

/** Full visual plan per narration sentence — drives clip search and ranking. */
export type ScriptVisualIntentEntry = {
  sentence: string;
  /** What the camera should show (English, concrete). */
  visual_intent: string;
  /** Visual director: concrete on-screen description (primary match source). */
  visual_description?: string;
  camera_shot?: string;
  emotion?: string;
  /** Visual director: English stock search from visual_description only. */
  search_query?: string;
  primary_keyword: string;
  secondary_keyword: string;
  fallback_keyword: string;
  scene_type: string;
  priority_subject: string;
};

/** Timed segment for montage / editor preview (holdSec-based until TTS alignment). */
export type VisualIntentSegment = {
  start_time: number;
  end_time: number;
  voiceover: string;
  visual_intent: string;
  keywords: string[];
  scene_type?: string;
  priority_subject?: string;
};

const BATCH_SIZE = 35;

const SCENE_TYPES = new Set([
  "office",
  "city",
  "nature",
  "home",
  "factory",
  "street",
  "transport",
  "government",
  "sports",
  "technology",
  "medical",
  "education",
  "historical",
  "aerial",
  "retail",
  "restaurant",
  "other",
]);

const ABSTRACT_KEYWORD_RE =
  /\b(success|growth|groei|strategy|strategie|company|bedrijf|business|person|persoon|people|concept|idea|innovation|future|impact|value|vision|mission|goal|doel|solution|opportunity|challenge|important|significant|powerful|amazing|incredible|remarkable)\b/i;

const INTENT_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "sentence_visual_intents",
    strict: true,
    schema: {
      type: "object",
      properties: {
        intents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer" },
              visual_intent: { type: "string" },
              primary_keyword: { type: "string" },
              secondary_keyword: { type: "string" },
              fallback_keyword: { type: "string" },
              scene_type: { type: "string" },
              priority_subject: { type: "string" },
            },
            required: [
              "index",
              "visual_intent",
              "primary_keyword",
              "secondary_keyword",
              "fallback_keyword",
              "scene_type",
              "priority_subject",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["intents"],
      additionalProperties: false,
    },
  },
} as const;

/** Normalize sentence text for map lookup (case/whitespace insensitive). */
export function normalizeSentenceKey(sentence: string): string {
  return sentence.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Split narration into individual sentences (headers/markdown stripped). */
export function extractNarrationSentences(script: string): string[] {
  const blocks = parseMarkdownNarrationBlocks(script);
  const fullText =
    blocks.length > 0
      ? blocks.map((b) => b.text).join(" ")
      : extractFullNarrationText(script);

  const trimmed = fullText.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];

  const raw =
    trimmed.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()).filter((s) => s.length > 5) ?? [];
  if (raw.length > 0) return raw;
  if (trimmed.length > 5) return [trimmed];
  return [];
}

/** Sanitize LLM keyword for Pexels/archive search. */
export function sanitizeVisualKeyword(keyword: unknown): string {
  const raw = typeof keyword === "string" ? keyword : keyword == null ? "" : String(keyword);
  let k = raw
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (k.length < 3 || k.length > 72) return "";

  const words = k.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 6) return "";

  if (ABSTRACT_KEYWORD_RE.test(k) && words.length <= 2) return "";

  return k;
}

export function sanitizeVisualIntentText(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 8 || t.length > 160) return "";
  if (/^(success|growth|strategy|concept|innovation|business)$/i.test(t)) return "";
  return t;
}

export function sanitizeSceneType(sceneType: unknown): string {
  const t = (typeof sceneType === "string" ? sceneType : sceneType == null ? "other" : String(sceneType))
    .toLowerCase().replace(/[^a-z_]/g, "").trim();
  return SCENE_TYPES.has(t) ? t : "other";
}

export function sanitizePrioritySubject(subject: unknown): string {
  const k = sanitizeVisualKeyword(subject);
  if (k) return k.split(/\s+/).slice(0, 2).join(" ");
  const words = (typeof subject === "string" ? subject : subject == null ? "scene" : String(subject))
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !ABSTRACT_KEYWORD_RE.test(w))
    .slice(0, 2);
  return words.join(" ") || "scene";
}

/** Heuristic fallback when LLM output is missing or invalid. */
export function fallbackVisualKeyword(sentence: string): string {
  return fallbackVisualIntent(sentence).primary_keyword;
}

function inferSceneTypeFromSentence(sentence: string, primaryKeyword: string): string {
  const hay = `${sentence} ${primaryKeyword}`.toLowerCase();
  if (/\b(office|kantoor|vergader|meeting|laptop|desk|werk)\b/.test(hay)) return "office";
  if (/\b(highway|snelweg|train|trein|tram|metro|bus|transport|airport|haven|port)\b/.test(hay)) {
    return "transport";
  }
  if (/\b(government|parliament|capitol|overheid|regering|gemeente)\b/.test(hay)) return "government";
  if (/\b(factory|fabriek|warehouse|productie|assembly)\b/.test(hay)) return "factory";
  if (/\b(home|woonkamer|keuken|kitchen|bedroom|huis)\b/.test(hay)) return "home";
  if (/\b(hospital|medical|doctor|ziekenhuis|arts)\b/.test(hay)) return "medical";
  if (/\b(school|university|student|education|onderwijs)\b/.test(hay)) return "education";
  if (/\b(aerial|drone|skyline|city|urban|amsterdam|berlin)\b/.test(hay)) return "city";
  if (/\b(war|hitler|nazi|1945|historical|archief)\b/.test(hay)) return "historical";
  if (/\b(nature|forest|ocean|wildlife|bos|zee)\b/.test(hay)) return "nature";
  return "other";
}

function buildIntentFieldsFromHint(
  sentence: string,
  hint: ReturnType<typeof matchVisualFallbackHint> & object
): Pick<
  ScriptVisualIntentEntry,
  "visual_intent" | "primary_keyword" | "secondary_keyword" | "fallback_keyword" | "scene_type" | "priority_subject"
> {
  const raw = buildIntentFromVisualFallbackHint(sentence, hint);
  const primary = sanitizeVisualKeyword(raw.primary_keyword) || raw.primary_keyword;
  const secondary = sanitizeVisualKeyword(raw.secondary_keyword) || primary;
  const fallback =
    sanitizeVisualKeyword(raw.fallback_keyword) ||
    sanitizeVisualKeyword(`${raw.scene_type} broll`) ||
    primary;
  return {
    visual_intent: raw.visual_intent,
    primary_keyword: primary,
    secondary_keyword: secondary,
    fallback_keyword: fallback,
    scene_type: sanitizeSceneType(raw.scene_type),
    priority_subject: sanitizePrioritySubject(raw.priority_subject),
  };
}

/** Rule-based visual intent when LLM output is missing or weak. */
export function fallbackVisualIntent(sentence: string): ScriptVisualIntentEntry {
  const hint = matchVisualFallbackHint(sentence);
  if (hint) {
    return { sentence, ...buildIntentFieldsFromHint(sentence, hint) };
  }

  const anchor = extractPrimaryVisualAnchor(sentence);
  let primary = anchor ? sanitizeVisualKeyword(anchor.replace(/_/g, " ")) : "";

  if (!primary) {
    const geo = extractPrimaryGeoSearchTag(sentence);
    if (geo) {
      if (isGeoWelcomeBeat(sentence)) {
        primary = sanitizeVisualKeyword(buildGeoWelcomeVisualQueries(sentence)[0] ?? "");
      }
      if (!primary) primary = sanitizeVisualKeyword(`${geo} aerial video`);
    }
  }
  if (!primary && isCyclingBeat(sentence)) {
    primary = sanitizeVisualKeyword(buildCyclingVisualQueries(sentence)[0] ?? "");
  }
  if (!primary && isCarBeat(sentence)) {
    primary = sanitizeVisualKeyword(buildCarVisualQueries(sentence)[0] ?? "");
  }
  if (!primary && isGovernmentBeat(sentence)) {
    primary = sanitizeVisualKeyword(buildGovernmentVisualQueries(sentence)[0] ?? "");
  }
  if (!primary && isUrbanPlanningBeat(sentence)) {
    primary = sanitizeVisualKeyword(buildUrbanPlanningVisualQueries(sentence)[0] ?? "");
  }
  if (!primary && isInfrastructureBeat(sentence)) {
    primary = sanitizeVisualKeyword(buildInfrastructureVisualQueries(sentence)[0] ?? "");
  }
  if (!primary) {
    primary = sanitizeVisualKeyword(buildEnglishVisualKeywordFromSentence(sentence) ?? "");
  }
  if (!primary) {
    const tokens = sentence
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !ABSTRACT_KEYWORD_RE.test(w))
      .slice(0, 3);
    if (tokens.length >= 2) primary = sanitizeVisualKeyword(tokens.join(" "));
  }
  if (!primary) {
    const lastHint = matchVisualFallbackHint(sentence.toLowerCase().slice(0, 120));
    if (lastHint) {
      return { sentence, ...buildIntentFieldsFromHint(sentence, lastHint) };
    }
  }
  if (!primary) primary = "documentary broll scene";

  const scene_type = inferSceneTypeFromSentence(sentence, primary);
  const priority_subject = sanitizePrioritySubject(primary.split(/\s+/)[0] ?? "scene");
  const visual_intent =
    sanitizeVisualIntentText(`${priority_subject} ${primary.replace(/ /g, " ")}`) ||
    `${priority_subject} in ${scene_type} setting`;

  const secondary =
    sanitizeVisualKeyword(`${priority_subject} ${scene_type}`) ||
    sanitizeVisualKeyword(primary.split(/\s+/).slice(0, 3).join(" ")) ||
    primary;
  const fallback =
    sanitizeVisualKeyword(`${scene_type} broll`) ||
    sanitizeVisualKeyword(`${priority_subject} working`) ||
    "documentary broll scene";

  return {
    sentence,
    visual_intent,
    primary_keyword: primary,
    secondary_keyword: secondary,
    fallback_keyword: fallback,
    scene_type,
    priority_subject,
  };
}

export function intentToKeywordEntry(intent: ScriptVisualIntentEntry): ScriptVisualKeywordEntry {
  return { sentence: intent.sentence, keyword: intent.primary_keyword };
}

export function intentSearchQueries(intent: ScriptVisualIntentEntry): string[] {
  if (hasDirectorPlan(intent)) {
    return directorSearchQueries(intent);
  }
  return [...new Set([intent.primary_keyword, intent.secondary_keyword, intent.fallback_keyword].filter(Boolean))];
}

/** Stap 1: max 2 concrete search subjects per zin (primary + secondary). */
export function beatVisualSearchSubjects(beatText: string): string[] {
  return intentSearchQueries(resolveBeatVisualIntent(beatText))
    .filter((q) => q.length >= 3)
    .slice(0, 2);
}

/** CLIP / gate context from script intent — visual_description or visual_intent. */
export function beatVisualDescriptionFromIntent(beatText: string): string | undefined {
  const intent = resolveBeatVisualIntent(beatText);
  const desc = (intent.visual_description ?? intent.visual_intent)?.trim();
  return desc && desc.length >= 4 ? desc : undefined;
}

export type BeatScriptVisualAnchor = {
  primarySubject: string;
  secondarySubject?: string;
  visualDescription?: string;
  searchSubjects: string[];
};

/** Resolved 1–2 script subjects + visual description for sourcing / CLIP. */
export function resolveBeatScriptVisualAnchor(beatText: string): BeatScriptVisualAnchor {
  const intent = resolveBeatVisualIntent(beatText);
  const searchSubjects = beatVisualSearchSubjects(beatText);
  const primarySubject =
    searchSubjects[0] ?? sanitizeVisualKeyword(intent.primary_keyword) ?? "documentary broll scene";
  const secondarySubject =
    searchSubjects[1] ??
    (intent.secondary_keyword && intent.secondary_keyword !== primarySubject
      ? sanitizeVisualKeyword(intent.secondary_keyword)
      : undefined);
  const visualDescription = beatVisualDescriptionFromIntent(beatText);
  return {
    primarySubject,
    secondarySubject,
    visualDescription,
    searchSubjects: searchSubjects.length ? searchSubjects : [primarySubject],
  };
}

/**
 * Fill beat searchQuery / powerWord / visualDescription / keywords from script intent.
 * Idempotent when fields are already set from [visual:] cues or TTS plan.
 */
export function hydrateBeatScriptVisuals<
  T extends {
    text: string;
    searchQuery?: string;
    powerWord?: string;
    visualDescription?: string;
    keywords?: string[];
  },
>(beat: T): T {
  const anchor = resolveBeatScriptVisualAnchor(beat.text);
  const cue = beat.text.match(/\[visual:\s*([^\]]+)\]/i)?.[1]?.trim();
  const existingQuery = beat.searchQuery?.trim();
  const existingPower = beat.powerWord?.trim();
  const existingDesc = beat.visualDescription?.trim();
  const subjectKeywords = anchor.searchSubjects.filter(Boolean);
  return {
    ...beat,
    searchQuery: existingQuery || anchor.primarySubject,
    powerWord: existingPower || anchor.primarySubject,
    visualDescription:
      cue || existingDesc || anchor.visualDescription || anchor.secondarySubject || undefined,
    keywords:
      beat.keywords?.length && beat.keywords.some((k) => k.trim().length > 2)
        ? beat.keywords
        : subjectKeywords,
  };
}

/** Stock/archive queries from visual director plan — never from spoken narration. */
export function directorSearchQueries(intent: ScriptVisualIntentEntry): string[] {
  const out: string[] = [];
  const desc = intent.visual_description ?? intent.visual_intent;
  const primary = intent.search_query
    ? sanitizeVisualKeyword(intent.search_query) || intent.search_query.trim()
    : intent.primary_keyword;
  if (primary) out.push(primary);
  if (intent.secondary_keyword && intent.secondary_keyword !== primary) out.push(intent.secondary_keyword);
  if (intent.fallback_keyword && intent.fallback_keyword !== primary) out.push(intent.fallback_keyword);
  if (desc) {
    const compact = sanitizeVisualKeyword(desc.split(/\s+/).slice(0, 5).join(" "));
    if (compact && compact !== primary) out.push(compact);
  }
  return [...new Set(out.filter((q) => q.length >= 3))].slice(0, 4);
}

export function buildRelevanceKeywordsFromIntent(
  intent: ScriptVisualIntentEntry,
  beatText: string,
  sceneTokens: string[] = [],
  videoTitle?: string
): string[] {
  const directorMode = hasDirectorPlan(intent);
  const parts = [
    ...intentSearchQueries(intent),
    ...tokenizeForRelevance(intent.visual_description ?? intent.visual_intent),
    ...tokenizeForRelevance(intent.camera_shot ?? ""),
    ...tokenizeForRelevance(intent.emotion ?? ""),
    ...tokenizeForRelevance(intent.priority_subject),
    ...tokenizeForRelevance(intent.scene_type),
    ...(directorMode ? [] : tokenizeForRelevance(beatText)),
    ...(directorMode ? [] : sceneTokens),
    ...tokenizeForRelevance(videoTitle ?? ""),
  ];
  return Array.from(new Set(parts.filter((p) => p.length >= 3))).slice(0, 24);
}

function tokenizeForRelevance(text: unknown): string[] {
  const raw = typeof text === "string" ? text : text == null ? "" : String(text);
  return raw
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

export function buildSentenceKeywordMap(entries: ScriptVisualKeywordEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    const key = normalizeSentenceKey(entry.sentence);
    const kw = sanitizeVisualKeyword(entry.keyword) || fallbackVisualKeyword(entry.sentence);
    if (key && kw) map.set(key, kw);
  }
  return map;
}

export function buildSentenceIntentMap(entries: ScriptVisualIntentEntry[]): Map<string, ScriptVisualIntentEntry> {
  const map = new Map<string, ScriptVisualIntentEntry>();
  for (const entry of entries) {
    const key = normalizeSentenceKey(entry.sentence);
    if (key) map.set(key, normalizeVisualIntentEntry(entry));
  }
  return map;
}

function normalizeVisualIntentEntry(entry: ScriptVisualIntentEntry): ScriptVisualIntentEntry {
  const primary =
    sanitizeVisualKeyword(entry.primary_keyword) || fallbackVisualIntent(entry.sentence).primary_keyword;
  const secondary = sanitizeVisualKeyword(entry.secondary_keyword) || primary;
  const fallback =
    sanitizeVisualKeyword(entry.fallback_keyword) || sanitizeVisualKeyword(`${entry.scene_type} broll`) || primary;
  return {
    sentence: entry.sentence,
    visual_intent:
      sanitizeVisualIntentText(entry.visual_intent) ||
      fallbackVisualIntent(entry.sentence).visual_intent,
    primary_keyword: primary,
    secondary_keyword: secondary,
    fallback_keyword: fallback,
    scene_type: sanitizeSceneType(entry.scene_type),
    priority_subject: sanitizePrioritySubject(entry.priority_subject),
  };
}

export function lookupSentenceKeyword(
  sentence: string,
  map: Map<string, string>
): string | undefined {
  return map.get(normalizeSentenceKey(sentence));
}

export function lookupSentenceIntent(
  sentence: string,
  map: Map<string, ScriptVisualIntentEntry>
): ScriptVisualIntentEntry | undefined {
  return map.get(normalizeSentenceKey(sentence));
}

/** Split beat/scene text into individual sentences (same rules as pipeline beats). */
export function splitBeatSentences(text: string): string[] {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];
  const sentences =
    trimmed.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()).filter((s) => s.length > 5) ?? [];
  if (sentences.length > 0) return sentences;
  if (trimmed.length > 5) return [trimmed];
  return [];
}

function scoreSentenceVisualDominance(sentence: string): number {
  let score = sentence.split(/\s+/).filter(Boolean).length;
  if (extractPrimaryVisualAnchor(sentence)) score += 50;
  if (extractPrimaryGeoSearchTag(sentence)) score += 40;
  if (isCyclingBeat(sentence)) score += 45;
  if (isCarBeat(sentence)) score += 45;
  if (isGovernmentBeat(sentence)) score += 45;
  if (isUrbanPlanningBeat(sentence)) score += 45;
  if (isInfrastructureBeat(sentence)) score += 45;
  return score;
}

function pickDominantSentenceIntent(
  sentences: string[],
  map: Map<string, ScriptVisualIntentEntry>
): ScriptVisualIntentEntry | undefined {
  const candidates = sentences
    .map((sentence) => ({
      sentence,
      intent: lookupSentenceIntent(sentence, map),
    }))
    .filter((row): row is { sentence: string; intent: ScriptVisualIntentEntry } => Boolean(row.intent));

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0].intent;

  let best = candidates[0];
  let bestScore = scoreSentenceVisualDominance(best.sentence);
  for (let i = 1; i < candidates.length; i++) {
    const score = scoreSentenceVisualDominance(candidates[i].sentence);
    if (score > bestScore) {
      bestScore = score;
      best = candidates[i];
    }
  }
  return best.intent;
}

function pickDominantSentenceKeyword(
  sentences: string[],
  map: Map<string, string>
): string | undefined {
  const candidates = sentences
    .map((sentence) => ({
      sentence,
      keyword: lookupSentenceKeyword(sentence, map),
    }))
    .filter((row): row is { sentence: string; keyword: string } => Boolean(row.keyword));

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0].keyword;

  let best = candidates[0];
  let bestScore = scoreSentenceVisualDominance(best.sentence);
  for (let i = 1; i < candidates.length; i++) {
    const score = scoreSentenceVisualDominance(candidates[i].sentence);
    if (score > bestScore) {
      bestScore = score;
      best = candidates[i];
    }
  }
  return best.keyword;
}

function lookupPartialSentenceIntent(
  beatText: string,
  map: Map<string, ScriptVisualIntentEntry>
): ScriptVisualIntentEntry | undefined {
  const beatKey = normalizeSentenceKey(beatText);
  if (beatKey.length < 5) return undefined;

  let best: { intent: ScriptVisualIntentEntry; overlap: number } | undefined;
  for (const [sentKey, intent] of map) {
    if (sentKey === beatKey) return intent;
    if (!sentKey.includes(beatKey) && !beatKey.includes(sentKey)) continue;
    const overlap =
      Math.min(sentKey.length, beatKey.length) / Math.max(sentKey.length, beatKey.length);
    if (overlap < 0.45) continue;
    if (!best || overlap > best.overlap) best = { intent, overlap };
  }
  return best?.intent;
}

function lookupPartialSentenceKeyword(
  beatText: string,
  map: Map<string, string>
): string | undefined {
  const beatKey = normalizeSentenceKey(beatText);
  if (beatKey.length < 5) return undefined;

  let best: { keyword: string; overlap: number } | undefined;
  for (const [sentKey, keyword] of map) {
    if (sentKey === beatKey) return keyword;
    if (!sentKey.includes(beatKey) && !beatKey.includes(sentKey)) continue;
    const overlap =
      Math.min(sentKey.length, beatKey.length) / Math.max(sentKey.length, beatKey.length);
    if (overlap < 0.45) continue;
    if (!best || overlap > best.overlap) best = { keyword, overlap };
  }
  return best?.keyword;
}

/**
 * Resolve the best stored visual intent for a beat — exact match, merged beats (dominant
 * sentence), or partial match when a sentence was split for timing.
 */
export function lookupBeatVisualIntent(
  beatText: string,
  map: Map<string, ScriptVisualIntentEntry>
): ScriptVisualIntentEntry | undefined {
  if (map.size === 0) return undefined;

  const exact = lookupSentenceIntent(beatText, map);
  if (exact) return exact;

  const sentences = splitBeatSentences(beatText);
  if (sentences.length > 1) {
    const dominant = pickDominantSentenceIntent(sentences, map);
    if (dominant) return dominant;
  }

  const partial = lookupPartialSentenceIntent(beatText, map);
  if (partial) return partial;

  for (const sentence of sentences) {
    const fromPart = lookupPartialSentenceIntent(sentence, map);
    if (fromPart) return fromPart;
  }

  return undefined;
}

function isWeakStoredIntent(intent: ScriptVisualIntentEntry): boolean {
  const primary = sanitizeVisualKeyword(intent.primary_keyword);
  return !primary || primary === "documentary broll scene";
}

/**
 * Always returns a usable visual intent — stored LLM plan, or rule-based fallback.
 * Upgrades weak stored intents (e.g. "documentary broll scene") with rule-based matches.
 */
export function resolveBeatVisualIntent(
  beatText: string,
  map?: Map<string, ScriptVisualIntentEntry>
): ScriptVisualIntentEntry {
  const ruleBased = fallbackVisualIntent(beatText);
  if (!map || map.size === 0) return ruleBased;

  const fromMap = lookupBeatVisualIntent(beatText, map);
  if (!fromMap) return ruleBased;
  const normalized = normalizeVisualIntentEntry(fromMap);
  if (isWeakStoredIntent(normalized) && !isWeakStoredIntent(ruleBased)) {
    return {
      ...ruleBased,
      visual_intent: normalized.visual_intent || ruleBased.visual_intent,
    };
  }
  return normalized;
}

/** Always returns an English stock search phrase for a beat. */
export function resolveBeatVisualKeyword(
  beatText: string,
  intentMap?: Map<string, ScriptVisualIntentEntry>
): string {
  return resolveBeatVisualIntent(beatText, intentMap).primary_keyword;
}

/**
 * Resolve the best stored keyword for a beat — exact match, merged beats (dominant
 * sentence), or partial match when a sentence was split for timing.
 */
export function lookupBeatVisualKeyword(
  beatText: string,
  map: Map<string, string>
): string | undefined {
  if (map.size === 0) return undefined;

  const exact = lookupSentenceKeyword(beatText, map);
  if (exact) return exact;

  const sentences = splitBeatSentences(beatText);
  if (sentences.length > 1) {
    const dominant = pickDominantSentenceKeyword(sentences, map);
    if (dominant) return dominant;
  }

  const partial = lookupPartialSentenceKeyword(beatText, map);
  if (partial) return partial;

  for (const sentence of sentences) {
    const fromPart = lookupPartialSentenceKeyword(sentence, map);
    if (fromPart) return fromPart;
  }

  return undefined;
}

export function parseVisualKeywordsFromMetadata(metadata: unknown): ScriptVisualKeywordEntry[] {
  const intents = parseVisualIntentsFromMetadata(metadata);
  if (intents.length > 0) return intents.map(intentToKeywordEntry);

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>).visualKeywords;
  if (!Array.isArray(raw)) return [];

  const out: ScriptVisualKeywordEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const sentence = String((item as Record<string, unknown>).sentence ?? "").trim();
    const keyword = String((item as Record<string, unknown>).keyword ?? "").trim();
    if (sentence.length > 5 && keyword.length > 2) {
      out.push({ sentence, keyword });
    }
  }
  return out;
}

export function parseVisualIntentsFromMetadata(metadata: unknown): ScriptVisualIntentEntry[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>).visualIntents;
  if (!Array.isArray(raw)) return [];

  const out: ScriptVisualIntentEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const sentence = String(row.sentence ?? "").trim();
    const primary_keyword = String(row.primary_keyword ?? row.keyword ?? "").trim();
    if (sentence.length <= 5 || primary_keyword.length <= 2) continue;
    out.push(
      normalizeVisualIntentEntry({
        sentence,
        visual_intent: String(row.visual_intent ?? row.visual_description ?? primary_keyword).trim(),
        visual_description: String(row.visual_description ?? row.visual_intent ?? primary_keyword).trim(),
        camera_shot: String(row.camera_shot ?? "").trim() || undefined,
        emotion: String(row.emotion ?? "").trim() || undefined,
        search_query: String(row.search_query ?? primary_keyword).trim() || undefined,
        primary_keyword,
        secondary_keyword: String(row.secondary_keyword ?? primary_keyword).trim(),
        fallback_keyword: String(row.fallback_keyword ?? "documentary broll scene").trim(),
        scene_type: String(row.scene_type ?? "other").trim(),
        priority_subject: String(row.priority_subject ?? "scene").trim(),
      })
    );
  }
  return out;
}

export function mergeVisualKeywordsIntoMetadata(
  metadata: unknown,
  keywords: ScriptVisualKeywordEntry[]
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  base.visualKeywords = keywords;
  return base;
}

export function mergeVisualIntentsIntoMetadata(
  metadata: unknown,
  intents: ScriptVisualIntentEntry[]
): Record<string, unknown> {
  const base = mergeVisualKeywordsIntoMetadata(
    metadata,
    intents.map(intentToKeywordEntry)
  );
  base.visualIntents = intents;
  return base;
}

/** Build timed segments from beats (holdSec estimates until TTS word alignment). */
export function buildVisualIntentSegments(
  beats: Array<{ text: string; holdSec: number; visualIntent?: ScriptVisualIntentEntry }>,
  startSec = 0
): VisualIntentSegment[] {
  const segments: VisualIntentSegment[] = [];
  let t = startSec;
  for (const beat of beats) {
    const intent = beat.visualIntent ?? fallbackVisualIntent(beat.text);
    const end = t + beat.holdSec;
    segments.push({
      start_time: Math.round(t * 10) / 10,
      end_time: Math.round(end * 10) / 10,
      voiceover: beat.text,
      visual_intent: intent.visual_intent,
      keywords: intentSearchQueries(intent),
      scene_type: intent.scene_type,
      priority_subject: intent.priority_subject,
    });
    t = end;
  }
  return segments;
}

function buildIntentBatchPrompt(sentences: string[], offset: number): string {
  const lines = sentences
    .map((s, i) => `${offset + i}: ${s.replace(/\s+/g, " ").trim()}`)
    .join("\n");

  return `You are a professional documentary video editor planning B-roll for each voice-over sentence.

For EVERY sentence, first understand:
1. What is the main subject?
2. What is the main action?
3. Who or what is central?
4. What footage would a human editor choose?
5. What image best supports the message of this sentence?

Do NOT copy random words from the narration into keywords. Translate meaning into what a camera would show.

Return JSON with one intent per index:
- visual_intent: short English description of the shot (concrete, filmable)
- primary_keyword: 2–5 word English stock-footage search phrase
- secondary_keyword: alternate search phrase (different angle, same meaning)
- fallback_keyword: broader backup phrase if primary finds nothing
- scene_type: one of office, city, nature, home, factory, street, transport, government, sports, technology, medical, education, historical, aerial, retail, restaurant, other
- priority_subject: main visible subject in 1–2 English words

Rules:
- Keywords must always be English (script may be Dutch or other)
- Never use vague words alone: success, growth, strategy, company, business, concept, innovation
- Focus on visible people, objects, actions, locations
- Pick the dominant visual idea when a sentence has multiple subjects

Example:
"Dutch: Veel ondernemers verspillen uren per week aan handmatig werk."
→ visual_intent: "frustrated entrepreneur working late at laptop"
→ primary_keyword: "frustrated entrepreneur laptop"
→ secondary_keyword: "office worker overwhelmed"
→ fallback_keyword: "busy business owner"
→ scene_type: "office"
→ priority_subject: "entrepreneur"

Sentences:
${lines}`;
}

async function generateIntentBatch(
  sentences: string[],
  offset: number
): Promise<Map<number, ScriptVisualIntentEntry>> {
  const result = new Map<number, ScriptVisualIntentEntry>();
  if (sentences.length === 0) return result;

  try {
    const resp = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are an expert documentary editor planning stock footage. Return valid JSON only — full visual intent per sentence index.",
        },
        { role: "user", content: buildIntentBatchPrompt(sentences, offset) },
      ],
      response_format: INTENT_JSON_SCHEMA,
    });

    const raw = resp?.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as {
      intents?: Array<{
        index?: number;
        visual_intent?: string;
        primary_keyword?: string;
        secondary_keyword?: string;
        fallback_keyword?: string;
        scene_type?: string;
        priority_subject?: string;
      }>;
    };

    for (const row of parsed.intents ?? []) {
      if (typeof row.index !== "number") continue;
      const sentence = sentences[row.index - offset];
      if (!sentence) continue;
      const primary = sanitizeVisualKeyword(row.primary_keyword ?? "");
      if (!primary) continue;
      result.set(
        row.index,
        normalizeVisualIntentEntry({
          sentence,
          visual_intent: String(row.visual_intent ?? primary),
          primary_keyword: primary,
          secondary_keyword: String(row.secondary_keyword ?? primary),
          fallback_keyword: String(row.fallback_keyword ?? primary),
          scene_type: String(row.scene_type ?? "other"),
          priority_subject: String(row.priority_subject ?? primary.split(/\s+/)[0] ?? "scene"),
        })
      );
    }
  } catch (err) {
    console.warn("[ScriptKeywords] LLM intent batch failed:", err);
  }

  return result;
}

/** Generate full visual intent plan via Visual Director (runs before footage search). */
export async function generateScriptVisualIntents(
  script: string
): Promise<ScriptVisualIntentEntry[]> {
  const directorScenes = await generateVisualDirectorPlan(script);
  return directorScenes.map(directorSceneToIntent);
}

export function buildSceneBeatsFromDirector(
  sceneText: string,
  duration: number,
  directorScenes: VisualDirectorScene[],
  videoTitle?: string
): Array<{
  text: string;
  holdSec: number;
  visualIntent: ScriptVisualIntentEntry;
  searchQuery: string;
}> {
  const forSceneRaw = directorScenesForSceneVoice(sceneText, directorScenes);
  if (forSceneRaw.length === 0) return [];

  const maxBeats = maxDirectorBeatsForSceneDuration(duration, VISUAL_DIRECTOR_MIN_SEC);
  const forScene = mergeDirectorScenesForPacing(forSceneRaw, maxBeats);

  const beats = forScene.map((dirScene) => {
    const intent = directorSceneToIntent(dirScene);
    const holdSec = estimateDirectorSceneHoldSec(dirScene.spoken_text, duration, forScene.length);
    return {
      text: dirScene.spoken_text,
      holdSec,
      visualIntent: intent,
      searchQuery: intent.search_query ?? intent.primary_keyword,
    };
  });

  const totalHold = beats.reduce((s, b) => s + b.holdSec, 0);
  if (totalHold > 0.5 && Math.abs(totalHold - duration) > 0.2) {
    const scale = duration / totalHold;
    for (const beat of beats) {
      beat.holdSec = Math.max(
        VISUAL_DIRECTOR_MIN_SEC,
        Math.min(VISUAL_DIRECTOR_MAX_SEC, beat.holdSec * scale)
      );
    }
  }

  return beats;
}

/** Generate one English visual keyword per narration sentence (legacy compat). */
export async function generateScriptVisualKeywords(
  script: string
): Promise<ScriptVisualKeywordEntry[]> {
  const intents = await generateScriptVisualIntents(script);
  return intents.map(intentToKeywordEntry);
}

/** Generate visual intents and merge into video metadata (script text unchanged). */
export async function attachScriptVisualKeywords(
  script: string,
  metadata: unknown = {}
): Promise<{
  metadata: Record<string, unknown>;
  keywords: ScriptVisualKeywordEntry[];
  intents: ScriptVisualIntentEntry[];
}> {
  const directorScenes = await generateVisualDirectorPlan(script);
  const intents = directorScenes.map(directorSceneToIntent);
  const keywords = intents.map(intentToKeywordEntry);
  return {
    metadata: mergeVisualDirectorIntoMetadata(
      mergeVisualIntentsIntoMetadata(metadata, intents),
      directorScenes
    ),
    keywords,
    intents,
  };
}
