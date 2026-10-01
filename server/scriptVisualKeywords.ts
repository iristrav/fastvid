/**
 * Per-sentence visual planning for stock/archive footage.
 * Analyses full voice-over context (subject, action, editor intent) — not loose words.
 */
import { AsyncLocalStorage } from "async_hooks";
import { foldToSearchTokensText } from "./searchTextNormalize";
import {
  extractFullNarrationText,
  parseMarkdownNarrationBlocks,
} from "./scriptWriter";
import {
  extractPrimaryGeoSearchTag,
  extractPrimaryVisualAnchor,
  extractEntitySceneAnchor,
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
import { directorSceneToIntent, generateVisualDirectorPlan, hasDirectorPlan, mergeVisualDirectorIntoMetadata, type VisualDirectorScene, type DirectorVideoContext } from "./visualDirector";
import {
  emptyQueryContext,
  formatSearchQueryAudit,
  validateSearchQuery,
} from "./searchQueryContract";

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
    /**
     * PRODUCTION FIX — apostrophes are DELETED, not turned into spaces.
     *
     * The next line maps every non-`\w` character to a space, and `\w` excludes apostrophes. So
     * any apostrophe that survives this strip splits the word around it: `didn't` became `didn t`
     * and the fragment `didn` went to the providers as a keyword. The first real production render
     * shows it happening — `query="didn know hitler" term="didn"`.
     *
     * This used to list only the STRAIGHT apostrophe. Narration written by an LLM uses the
     * typographic one (U+2019) almost every time, so in production the strip never fired.
     * U+2018 and the acute accent are included for the same reason: they are what a text pipeline
     * actually meets, and each of them splits a contraction exactly the same way.
     */
    .replace(/["'`\u2018\u2019\u02BC\u00B4]/g, "")
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
    /** Same reason as `sanitizeVisualKeyword`: an apostrophe here would split the word. */
    .replace(/["'`\u2018\u2019\u02BC\u00B4]/g, "")
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
  if (/\b(aerial|drone|skyline|city|urban)\b/.test(hay)) return "city";
  if (/\b(war|historical|archief)\b/.test(hay) || /\b1[0-9]{3}\b/.test(hay)) return "historical";
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
  // A beat naming both a specific person/entity (Hitler, Eva Braun…) and a specific
  // scene (bunker, rally, surrender…) is a higher-confidence match than the generic
  // single-keyword hint table below (e.g. a bare "Berlin" -> "berlin city skyline"),
  // so it must win instead of being short-circuited by that table.
  const entityScene = extractEntitySceneAnchor(sentence);
  const hint = entityScene ? null : matchVisualFallbackHint(sentence);
  if (hint) {
    return { sentence, ...buildIntentFieldsFromHint(sentence, hint) };
  }

  const anchor = entityScene ?? extractPrimaryVisualAnchor(sentence);
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
    const tokens = foldToSearchTokensText(sentence)
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

/**
 * The visual-director plan's queries are checked with the SAME validator the provider gate uses.
 *
 * Evidence is the sentence plus the plan entry for that sentence (its description and search
 * query) — approved 1 Oct 2026: context the director resolved from the script may prove a term.
 * What stays refused is a word that neither the sentence nor this sentence's plan states — a
 * template appending "aerial", a title, a later model call. Those are logged as LLM_UNPROVEN_CONTENT.
 */
function keepProvableDirectorQueries(queries: string[], intent: ScriptVisualIntentEntry): string[] {
  const evidence = (intent.sentence ?? "").trim();
  // No sentence means nothing to check against, and "unchecked" is not "proven".
  if (!evidence) return [];
  const ctx = emptyQueryContext(evidence, "", planEvidenceText(intent));
  const kept: string[] = [];
  for (const query of queries) {
    const verdict = validateSearchQuery(query, ctx);
    if (verdict.ok) {
      kept.push(query);
      continue;
    }
    console.warn(
      formatSearchQueryAudit({
        query,
        provider: "-",
        route: "directorSearchQueries",
        status: "BLOCKED",
        verified: false,
        terms: [],
        blockedTerms: verdict.blockedTerms,
        reason: "LLM_UNPROVEN_CONTENT",
      })
    );
  }
  return kept;
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
  const built = [...new Set(out.filter((q) => q.length >= 3))].slice(0, 4);
  return keepProvableDirectorQueries(built, intent);
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
    /** Same reason again — a split contraction would score relevance against a fragment. */
    .replace(/["'`\u2018\u2019\u02BC\u00B4]/g, "")
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
  /**
   * The director's own fields are kept. They used to be dropped here, so even a stored plan
   * reached the render as keywords only: no description, no shot, no search query.
   */
  const description = sanitizeVisualIntentText(entry.visual_description ?? "");
  return {
    sentence: entry.sentence,
    visual_intent:
      sanitizeVisualIntentText(entry.visual_intent) ||
      fallbackVisualIntent(entry.sentence).visual_intent,
    ...(description ? { visual_description: description } : {}),
    ...(entry.camera_shot?.trim() ? { camera_shot: entry.camera_shot.trim() } : {}),
    ...(entry.emotion?.trim() ? { emotion: entry.emotion.trim() } : {}),
    ...(entry.search_query?.trim() ? { search_query: entry.search_query.trim() } : {}),
    primary_keyword: primary,
    secondary_keyword: secondary,
    fallback_keyword: fallback,
    scene_type: sanitizeSceneType(entry.scene_type),
    priority_subject: sanitizePrioritySubject(entry.priority_subject),
  };
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

/**
 * Resolve the best stored visual intent for a beat — exact match, merged beats (dominant
 * sentence), or partial match when a sentence was split for timing.
 */
export function lookupBeatVisualIntent(
  beatText: string,
  map: Map<string, ScriptVisualIntentEntry>
): ScriptVisualIntentEntry | undefined {
  return matchBeatVisualIntent(beatText, map)?.entry;
}

/** `found` — the beat is a planned sentence (or holds one); `partial` — it overlaps one. */
function matchBeatVisualIntent(
  beatText: string,
  map: Map<string, ScriptVisualIntentEntry>
): { entry: ScriptVisualIntentEntry; plan: "found" | "partial" } | undefined {
  if (map.size === 0) return undefined;

  const exact = lookupSentenceIntent(beatText, map);
  if (exact) return { entry: exact, plan: "found" };

  const sentences = splitBeatSentences(beatText);
  if (sentences.length > 1) {
    const dominant = pickDominantSentenceIntent(sentences, map);
    if (dominant) return { entry: dominant, plan: "found" };
  }

  for (const text of [beatText, ...sentences]) {
    const partial = lookupPartialSentenceIntent(text, map);
    if (partial) return { entry: partial, plan: "partial" };
  }

  return undefined;
}

function isWeakStoredIntent(intent: ScriptVisualIntentEntry): boolean {
  const primary = sanitizeVisualKeyword(intent.primary_keyword);
  return !primary || primary === "documentary broll scene";
}

/**
 * STAP 1 — THE STORED VISUALDIRECTOR PLAN IS THE RENDER'S VISUAL INTENT.
 *
 * The plan is written to `videos.metadata.visualIntents` when the script is written and again when
 * it is approved, and no render read it: every caller asked `resolveBeatVisualIntent(text)` with no
 * map and got the word rules. The render now opens one scope with the stored plan, and every
 * caller that passes no map of its own reads that plan.
 */
type RenderVisualPlan = { map: Map<string, ScriptVisualIntentEntry>; reported: Set<string> };
const renderVisualPlanStorage = new AsyncLocalStorage<RenderVisualPlan>();

export function withRenderVisualPlan<T>(metadata: unknown, fn: () => T): T {
  const map = buildSentenceIntentMap(parseVisualIntentsFromMetadata(metadata));
  console.log(
    `[VisualIntentPlan] stored plan sentences=${map.size}` +
      (map.size === 0 ? " VISUAL_INTENT_FALLBACK reason=no_plan_for_video" : "")
  );
  return renderVisualPlanStorage.run({ map, reported: new Set() }, fn);
}

/** The stored plan entry for this beat, when the render has one — never the word rules. */
export function storedVisualIntentForBeat(beatText: string): ScriptVisualIntentEntry | undefined {
  const scope = renderVisualPlanStorage.getStore();
  const match = scope ? matchBeatVisualIntent(beatText, scope.map) : undefined;
  if (!match) return undefined;
  const normalized = normalizeVisualIntentEntry(match.entry);
  return isWeakStoredIntent(normalized) ? undefined : normalized;
}

/** What a stored plan entry may prove in a query: the director's description and search query. */
export function planEvidenceText(entry: ScriptVisualIntentEntry | undefined): string {
  if (!entry) return "";
  return [entry.visual_description, entry.search_query].filter(Boolean).join(" ").trim();
}

/** One line per text per render: whether the plan answered, and why the word rules did if not. */
function reportPlanUse(
  scope: RenderVisualPlan | undefined,
  beatText: string,
  plan: "found" | "partial" | "missing",
  fallbackReason?: string
): void {
  const key = normalizeSentenceKey(beatText);
  if (!scope || !key || scope.reported.has(key)) return;
  scope.reported.add(key);
  console.log(
    `[VisualIntentPlan] plan=${plan}` +
      (fallbackReason ? ` VISUAL_INTENT_FALLBACK reason=${fallbackReason}` : "") +
      ` sentence="${beatText.replace(/\s+/g, " ").trim().slice(0, 90)}"`
  );
}

/**
 * Always returns a usable visual intent — stored LLM plan, or rule-based fallback.
 * Upgrades weak stored intents (e.g. "documentary broll scene") with rule-based matches.
 */
export function resolveBeatVisualIntent(
  beatText: string,
  map?: Map<string, ScriptVisualIntentEntry>
): ScriptVisualIntentEntry {
  const scope = map ? undefined : renderVisualPlanStorage.getStore();
  const plan = map ?? scope?.map;
  const ruleBased = fallbackVisualIntent(beatText);
  if (!plan || plan.size === 0) {
    reportPlanUse(scope, beatText, "missing", "no_plan_for_video");
    return ruleBased;
  }

  const match = matchBeatVisualIntent(beatText, plan);
  if (!match) {
    reportPlanUse(scope, beatText, "missing", "sentence_not_in_plan");
    return ruleBased;
  }
  const normalized = normalizeVisualIntentEntry(match.entry);
  if (isWeakStoredIntent(normalized) && !isWeakStoredIntent(ruleBased)) {
    reportPlanUse(scope, beatText, match.plan, "weak_plan");
    return {
      ...ruleBased,
      visual_intent: normalized.visual_intent || ruleBased.visual_intent,
    };
  }
  reportPlanUse(scope, beatText, match.plan);
  return normalized;
}

/** Always returns an English stock search phrase for a beat. */
export function resolveBeatVisualKeyword(
  beatText: string,
  intentMap?: Map<string, ScriptVisualIntentEntry>
): string {
  return resolveBeatVisualIntent(beatText, intentMap).primary_keyword;
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

/** Generate visual intents and merge into video metadata (script text unchanged). */
export async function attachScriptVisualKeywords(
  script: string,
  metadata: unknown = {},
  videoContext?: DirectorVideoContext
): Promise<{
  metadata: Record<string, unknown>;
  keywords: ScriptVisualKeywordEntry[];
  intents: ScriptVisualIntentEntry[];
}> {
  const directorScenes = await generateVisualDirectorPlan(script, videoContext);
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
