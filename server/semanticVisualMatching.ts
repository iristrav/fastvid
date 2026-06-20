/**
 * Semantic visual matching — per-sentence meaning → tiered archive clip selection.
 * Uses LLM entity extraction + embedding similarity (OpenAI) with lexical fallback.
 */
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";
import { DOCUMENTARY_EDITOR_VIEWER_QUESTION } from "./documentaryVisualPolicy";
import {
  beatMentionsWwiiContent,
  extractEntitySearchTags,
  extractPrimaryVisualAnchor,
  extractSalientBeatTokens,
  extractSceneSearchTags,
  extractVisualSearchTags,
  inferVideoVisualTopic,
  isGenericPeopleAsset,
  isWwiiWarArchiveAsset,
} from "./visualBeatTags";
import { normalizeMediaTags, type MediaArchiveAsset } from "./db";

export type SemanticEntityList = {
  persons: string[];
  locations: string[];
  companies: string[];
  events: string[];
  objects: string[];
  emotions: string[];
  timePeriods: string[];
  years: string[];
};

/** Priority tiers for archive search — tier 0 is highest (exact subject). */
export type BeatSemanticProfile = {
  beatText: string;
  summary: string;
  entities: SemanticEntityList;
  /** Each inner array is one priority tier (index 0 = exact match). */
  searchTiers: string[][];
  topicDomain: string;
};

export type SemanticMatchResult = {
  relevanceScore: number;
  tier: 1 | 2 | 3 | 4 | 5;
  tierLabel: string;
  embeddingSimilarity: number;
  matchedEntities: string[];
};

const BEAT_ANALYSIS_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "beat_semantic_profile",
    strict: true,
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        persons: { type: "array", items: { type: "string" } },
        locations: { type: "array", items: { type: "string" } },
        companies: { type: "array", items: { type: "string" } },
        events: { type: "array", items: { type: "string" } },
        objects: { type: "array", items: { type: "string" } },
        emotions: { type: "array", items: { type: "string" } },
        timePeriods: { type: "array", items: { type: "string" } },
        years: { type: "array", items: { type: "string" } },
        topicDomain: { type: "string" },
        searchTiers: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
      },
      required: [
        "summary",
        "persons",
        "locations",
        "companies",
        "events",
        "objects",
        "emotions",
        "timePeriods",
        "years",
        "topicDomain",
        "searchTiers",
      ],
      additionalProperties: false,
    },
  },
} as const;

const profileCache = new Map<string, BeatSemanticProfile>();
const embeddingCache = new Map<string, number[]>();

export function semanticVisualMatchingEnabled(): boolean {
  return process.env.ENABLE_SEMANTIC_VISUAL_MATCH !== "false";
}

export function semanticMinRelevanceScore(): number {
  const raw = process.env.SEMANTIC_MIN_RELEVANCE_SCORE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 20 && n <= 90) return n;
  }
  return 38;
}

/** @deprecated Topic-specific floors removed — use semanticMinRelevanceScore() for all topics. */
export function semanticMinRelevanceScoreForTopic(_topicDomain?: string): number {
  return semanticMinRelevanceScore();
}

function beatCacheKey(text: string, videoTitle?: string): string {
  return `${(videoTitle ?? "").slice(0, 80)}::${text.trim().slice(0, 400)}`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9à-ÿ\s'-]/g, " ").replace(/\s+/g, " ").trim();
}

function uniqueStrings(items: string[], max = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const v = slug(item);
    if (!v || v.length < 2 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function inferTopicDomain(text: string, videoTitle?: string): string {
  const topic = inferVideoVisualTopic(videoTitle, text);
  if (topic === "wwii") return "wwii";
  if (topic === "cold_war") return "cold_war";
  if (topic === "geography_urban") return "geography_urban";
  const hay = slug(`${videoTitle ?? ""} ${text}`);
  if (/elon|musk|spacex|starship|tesla|starlink|falcon/.test(hay)) return "space_tech";
  if (/titanic|maritime|ship|ocean liner/.test(hay)) return "maritime";
  return "general";
}

function domainFallbackTiers(domain: string): string[][] {
  if (domain === "wwii") {
    return [["world war ii", "wwii", "second world war"], ["war footage", "military archive"]];
  }
  if (domain === "geography_urban") {
    return [
      ["city skyline", "urban street", "city planning"],
      ["public transport", "architecture", "modern city"],
      ["netherlands", "amsterdam", "dutch city", "canal"],
    ];
  }
  if (domain === "space_tech") {
    return [["rocket launch", "space launch"], ["technology", "innovation"]];
  }
  return [["documentary archive", "historical footage"]];
}

/** Rule-based profile when LLM is unavailable. */
export function analyzeBeatSemanticsFallback(beatText: string, videoTitle?: string): BeatSemanticProfile {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  const years = [...cleaned.matchAll(/\b(1[0-9]{3}|20[0-9]{2})\b/g)].map((m) => m[1]!);
  const salient = extractSalientBeatTokens(cleaned);
  const slugged = slug(cleaned);
  const entities: SemanticEntityList = {
    persons: uniqueStrings([
      ...extractEntitySearchTags(cleaned).filter((t) =>
        /hitler|stalin|churchill|rommel|musk|elon|goebbels|keitel|jodl|eva braun|braun/.test(t)
      ),
      ...( /musk|elon\b/.test(slugged) ? ["elon musk", "musk"] : []),
    ]),
    locations: uniqueStrings(
      extractVisualSearchTags(cleaned, videoTitle).filter((t) =>
        /berlin|poland|germany|france|moscow|vienna|munich|normandy|auschwitz|warsaw|america|europe|russia|uk|england|city|urban|skyline|street|architecture|transit|metro/.test(
          t
        )
      )
    ),
    companies: uniqueStrings([
      ...salient.filter((t) => /spacex|tesla|nasa|apple|google|microsoft|amazon/.test(t)),
      ...( /spacex|starship|falcon/.test(slugged) ? ["spacex", "space exploration"] : []),
    ]),
    events: uniqueStrings(extractSceneSearchTags(cleaned)),
    objects: uniqueStrings([
      ...salient.filter((t) => /tank|rocket|starship|aircraft|bunker|flag|map|submarine|ship/.test(t)),
      ...( /starship/.test(slugged) ? ["starship", "rocket"] : []),
    ]),
    emotions: uniqueStrings(
      salient.filter((t) =>
        /fear|hope|despair|triumph|anger|tragedy|chaos|terror|determination/.test(t)
      )
    ),
    timePeriods: uniqueStrings(
      (() => {
        const domain = inferTopicDomain(cleaned, videoTitle);
        if (domain === "geography_urban") return ["modern day", "contemporary city"];
        if (domain === "wwii") {
          return years.length > 0 ? [`${years[0]}s`, "world war ii"] : ["world war ii", "1930s", "1940s"];
        }
        return years.length > 0 ? [`${years[0]}s`] : [];
      })()
    ),
    years: uniqueStrings(years),
  };

  const anchor = extractPrimaryVisualAnchor(cleaned);
  const tiers: string[][] = [];

  if (entities.persons.length > 0) tiers.push(entities.persons);
  if (entities.companies.length > 0) tiers.push(entities.companies);
  if (entities.objects.length > 0) tiers.push(entities.objects.slice(0, 4));
  if (entities.locations.length > 0) tiers.push(entities.locations);
  if (entities.events.length > 0) tiers.push(entities.events.slice(0, 5));
  if (anchor) tiers.push([anchor]);
  const combined = uniqueStrings([...entities.persons, ...entities.locations, ...entities.events]);
  if (combined.length >= 2) tiers.unshift([combined.slice(0, 2).join(" ")]);
  if (entities.years.length > 0) tiers.push(entities.years);
  if (entities.timePeriods.length > 0) tiers.push(entities.timePeriods.slice(0, 3));
  tiers.push(...domainFallbackTiers(inferTopicDomain(cleaned, videoTitle)));

  const dedupedTiers = tiers
    .map((t) => uniqueStrings(t, 6))
    .filter((t) => t.length > 0)
    .slice(0, 6);

  return {
    beatText: cleaned,
    summary: anchor ?? cleaned.slice(0, 120),
    entities,
    searchTiers: dedupedTiers.length > 0 ? dedupedTiers : [[...salient.slice(0, 3)]],
    topicDomain: inferTopicDomain(cleaned, videoTitle),
  };
}

/** Coerce DB/metadata values to a plain string for LLM prompts. */
function coerceVideoTitleString(videoTitle: unknown): string {
  if (typeof videoTitle === "string") return videoTitle;
  if (videoTitle == null) return "";
  if (typeof videoTitle === "object" && videoTitle !== null && "title" in videoTitle) {
    const t = (videoTitle as { title?: unknown }).title;
    if (typeof t === "string") return t;
  }
  return String(videoTitle);
}

async function analyzeBeatSemanticsWithLlm(
  beatText: string,
  videoTitle?: string,
  literalViewerVisual?: string
): Promise<BeatSemanticProfile | null> {
  if (!ENV.forgeApiKey || process.env.ENABLE_SEMANTIC_LLM_ANALYSIS === "false") return null;

  const titleStr = coerceVideoTitleString(videoTitle);

  const prompt = `${DOCUMENTARY_EDITOR_VIEWER_QUESTION}

Describe ONE concrete visual scene (subject + action + setting). Derive all search tiers from that scene — not from narration words.

Analyze this documentary beat for visual B-roll matching.

Literal on-screen visual (what the viewer should see): "${(literalViewerVisual ?? beatText).replace(/"/g, "'")}"
Narration sentence (context only — do NOT copy words into search tiers): "${beatText.replace(/"/g, "'")}"
${titleStr ? `Video title: "${titleStr.replace(/"/g, "'")}"` : ""}

Extract:
- persons, locations, companies, events, objects, emotions, timePeriods, years visible in the literal scene
- topicDomain (short slug, e.g. wwii, space_tech, cold_war, general)
- searchTiers: 3-5 priority tiers of English search phrases (lowercase) derived ONLY from the literal on-screen visual. Tier 1 = exact visible subject + action/place. Last tier = same topic only, NOT generic stock.

Example literal scene "Soldiers and tanks advancing through a war-torn city":
searchTiers: [["soldiers tanks city"], ["military advance ruins"], ["world war ii", "wartime europe"]]

Do NOT include generic tiers like "soldiers" or "technology" before specific tiers. Do NOT copy Dutch or abstract narration words.`;

  try {
    const response = await Promise.race([
      invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "You extract structured visual search intent from documentary narration. Return JSON only.",
          },
          { role: "user", content: prompt },
        ],
        response_format: BEAT_ANALYSIS_SCHEMA,
        maxTokens: 800,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("semantic analysis timeout")), 14_000)
      ),
    ]);

    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string") return null;
    const parsed = JSON.parse(content) as {
      summary: string;
      persons: string[];
      locations: string[];
      companies: string[];
      events: string[];
      objects: string[];
      emotions: string[];
      timePeriods: string[];
      years: string[];
      topicDomain: string;
      searchTiers: string[][];
    };

    const entities: SemanticEntityList = {
      persons: uniqueStrings(parsed.persons ?? []),
      locations: uniqueStrings(parsed.locations ?? []),
      companies: uniqueStrings(parsed.companies ?? []),
      events: uniqueStrings(parsed.events ?? []),
      objects: uniqueStrings(parsed.objects ?? []),
      emotions: uniqueStrings(parsed.emotions ?? []),
      timePeriods: uniqueStrings(parsed.timePeriods ?? []),
      years: uniqueStrings(parsed.years ?? []),
    };

    const searchTiers = (parsed.searchTiers ?? [])
      .map((tier) => uniqueStrings(tier, 6))
      .filter((t) => t.length > 0);

    return {
      beatText: beatText.replace(/\[visual:[^\]]+\]/gi, " ").trim(),
      summary: literalViewerVisual?.trim() || parsed.summary?.trim() || beatText.slice(0, 120),
      entities,
      searchTiers:
        searchTiers.length > 0
          ? searchTiers
          : analyzeBeatSemanticsFallback(beatText, videoTitle).searchTiers,
      topicDomain: slug(parsed.topicDomain) || inferTopicDomain(beatText, videoTitle),
    };
  } catch (err) {
    console.warn("[SemanticVisual] LLM analysis failed:", (err as Error).message?.slice(0, 100));
    return null;
  }
}

export async function analyzeBeatSemantics(
  beatText: string,
  videoTitle?: string,
  literalViewerVisual?: string
): Promise<BeatSemanticProfile> {
  const title = coerceVideoTitleString(videoTitle);
  const key = beatCacheKey(`${literalViewerVisual ?? ""}|${beatText}`, title);
  const cached = profileCache.get(key);
  if (cached) return cached;

  const llm = await analyzeBeatSemanticsWithLlm(beatText, title, literalViewerVisual);
  const profile = llm ?? analyzeBeatSemanticsFallback(beatText, title);
  profileCache.set(key, profile);
  return profile;
}

/** Batch-analyze all beats in a scene (parallel with cap). */
export async function analyzeBeatsSemanticsBatch(
  beatTexts: string[],
  videoTitle?: string,
  opts?: { fastMode?: boolean }
): Promise<Map<number, BeatSemanticProfile>> {
  const title = coerceVideoTitleString(videoTitle);
  const out = new Map<number, BeatSemanticProfile>();
  if (opts?.fastMode) {
    beatTexts.forEach((text, i) => {
      if (text?.trim()) out.set(i, analyzeBeatSemanticsFallback(text, title));
    });
    return out;
  }
  const concurrency = 4;
  let idx = 0;

  async function worker() {
    while (idx < beatTexts.length) {
      const i = idx++;
      const text = beatTexts[i];
      if (!text?.trim()) continue;
      try {
        out.set(i, await analyzeBeatSemantics(text, title));
      } catch (err) {
        console.warn(
          `[Semantic] Beat ${i} analysis failed — using fallback:`,
          (err as Error).message?.slice(0, 100)
        );
        out.set(i, analyzeBeatSemanticsFallback(text, title));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, beatTexts.length) }, () => worker()));
  return out;
}

export function buildAssetSemanticDocument(asset: Pick<MediaArchiveAsset, "title" | "tags" | "sourceNote">): string {
  const tags = normalizeMediaTags(asset.tags ?? []).join(" ");
  const note = asset.sourceNote?.trim() ?? "";
  return slug(`${asset.title ?? ""} ${tags} ${note}`);
}

function hayIncludesTerm(hay: string, term: string): boolean {
  const t = slug(term);
  if (!t) return false;
  if (hay.includes(t)) return true;
  const words = t.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length >= 2) {
    return words.filter((w) => hay.includes(w)).length >= Math.min(2, words.length);
  }
  return false;
}

function findMatchedEntities(hay: string, profile: BeatSemanticProfile): string[] {
  const all = [
    ...profile.entities.persons,
    ...profile.entities.locations,
    ...profile.entities.companies,
    ...profile.entities.events,
    ...profile.entities.objects,
    ...profile.entities.years,
    ...profile.entities.timePeriods,
  ];
  return all.filter((e) => hayIncludesTerm(hay, e));
}

/** Tier 1 = exact subject … Tier 5 = generic topic fallback. */
export function computeTieredRelevanceScore(
  profile: BeatSemanticProfile,
  asset: Pick<MediaArchiveAsset, "title" | "tags" | "sourceNote" | "mediaType">
): SemanticMatchResult {
  const hay = buildAssetSemanticDocument(asset);
  if (isWwiiWarArchiveAsset(asset) && !beatMentionsWwiiContent(profile.beatText)) {
    return {
      relevanceScore: 6,
      tier: 5,
      tierLabel: "wwii archive (off-topic)",
      embeddingSimilarity: 0,
      matchedEntities: [],
    };
  }

  const matchedEntities = findMatchedEntities(hay, profile);
  let tier: 1 | 2 | 3 | 4 | 5 = 5;
  let tierLabel = "generic topic";
  let baseScore = 18;

  for (let ti = 0; ti < profile.searchTiers.length; ti++) {
    const tierTerms = profile.searchTiers[ti]!;
    const hits = tierTerms.filter((term) => hayIncludesTerm(hay, term)).length;
    if (hits > 0) {
      tier = Math.min(5, ti + 1) as 1 | 2 | 3 | 4 | 5;
      const tierScores = [92, 78, 65, 52, 38];
      baseScore = tierScores[tier - 1] ?? 38;
      baseScore += Math.min(8, hits * 3);
      tierLabel = tierTerms.slice(0, 2).join(" + ");
      break;
    }
  }

  if (matchedEntities.length >= 2) baseScore += 10;
  if (matchedEntities.length >= 3) baseScore += 6;

  const hasSpecificEntity =
    profile.entities.persons.length > 0 ||
    profile.entities.companies.length > 0 ||
    profile.entities.locations.length > 0 ||
    profile.entities.events.length > 0;

  if (hasSpecificEntity && matchedEntities.length === 0 && tier >= 4) {
    baseScore = Math.min(baseScore, 22);
  }

  if (isGenericPeopleAsset(asset) && hasSpecificEntity && matchedEntities.length === 0) {
    baseScore = Math.min(baseScore, 15);
    tier = 5;
    tierLabel = "generic people (rejected)";
  }

  if (
    /generic|stock footage|unknown|filler|b-roll|b roll/.test(hay) &&
    matchedEntities.length === 0 &&
    tier >= 4
  ) {
    baseScore = Math.min(baseScore, 20);
  }

  if (asset.mediaType === "video" && baseScore >= 50) baseScore += 4;

  return {
    relevanceScore: Math.max(0, Math.min(100, Math.round(baseScore))),
    tier,
    tierLabel,
    embeddingSimilarity: 0,
    matchedEntities,
  };
}

function tokenizeForVector(text: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const w of slug(text).split(/\s+/)) {
    if (w.length < 3) continue;
    weights.set(w, (weights.get(w) ?? 0) + 1);
  }
  return weights;
}

function buildWeightedBeatVector(profile: BeatSemanticProfile): Map<string, number> {
  const vec = tokenizeForVector(`${profile.summary} ${profile.beatText}`);
  const add = (terms: string[], weight: number) => {
    for (const t of terms) {
      for (const w of slug(t).split(/\s+/)) {
        if (w.length < 3) continue;
        vec.set(w, (vec.get(w) ?? 0) + weight);
      }
    }
  };
  add(profile.entities.persons, 6);
  add(profile.entities.companies, 5);
  add(profile.entities.locations, 5);
  add(profile.entities.events, 4);
  add(profile.entities.objects, 3);
  add(profile.entities.years, 3);
  add(profile.entities.timePeriods, 2);
  for (const tier of profile.searchTiers) add(tier, 4);
  return vec;
}

export function computeLexicalSemanticSimilarity(
  profile: BeatSemanticProfile,
  asset: Pick<MediaArchiveAsset, "title" | "tags" | "sourceNote">
): number {
  const a = buildWeightedBeatVector(profile);
  const b = tokenizeForVector(buildAssetSemanticDocument(asset));
  if (a.size === 0 || b.size === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [k, v] of a) {
    normA += v * v;
    if (b.has(k)) dot += v * (b.get(k) ?? 0);
  }
  for (const v of b.values()) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function createEmbedding(text: string): Promise<number[] | null> {
  const provider = ENV.llmProvider;
  if ((provider !== "openai" && provider !== "forge") || !ENV.forgeApiKey) return null;
  const key = slug(text).slice(0, 2000);
  const cached = embeddingCache.get(key);
  if (cached) return cached;

  try {
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ENV.forgeApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.SEMANTIC_EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
        input: text.slice(0, 2000),
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }> };
    const emb = data.data?.[0]?.embedding;
    if (!emb?.length) return null;
    embeddingCache.set(key, emb);
    return emb;
  } catch {
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Exported for archive embedding index — text-embedding-3-small with in-memory cache. */
export async function createTextEmbedding(text: string): Promise<number[] | null> {
  return createEmbedding(text);
}

export function cosineSimilarityVectors(a: number[], b: number[]): number {
  return cosineSimilarity(a, b);
}

export async function computeSemanticSimilarity(
  profile: BeatSemanticProfile,
  asset: Pick<MediaArchiveAsset, "title" | "tags" | "sourceNote"> & { id?: number }
): Promise<number> {
  const beatDoc = `${profile.summary}. ${profile.beatText}. ${profile.searchTiers.flat().join(", ")}`;
  const assetDoc = buildAssetSemanticDocument(asset);

  if (typeof asset.id === "number") {
    const { scoreBeatAgainstStoredEmbedding } = await import("./archiveEmbeddingIndex");
    const stored = await scoreBeatAgainstStoredEmbedding(beatDoc, asset.id);
    if (stored != null) return stored;
  }

  const [beatEmb, assetEmb] = await Promise.all([
    createEmbedding(beatDoc),
    createEmbedding(assetDoc),
  ]);

  if (beatEmb && assetEmb) {
    return Math.max(0, cosineSimilarity(beatEmb, assetEmb));
  }
  return computeLexicalSemanticSimilarity(profile, asset);
}

export async function scoreArchiveAssetSemantically(
  profile: BeatSemanticProfile,
  asset: Pick<MediaArchiveAsset, "title" | "tags" | "sourceNote" | "mediaType">
): Promise<SemanticMatchResult> {
  const tiered = computeTieredRelevanceScore(profile, asset);
  const embeddingSimilarity = await computeSemanticSimilarity(profile, asset);
  const embeddingPoints = Math.round(embeddingSimilarity * 100);

  const combined = Math.round(tiered.relevanceScore * 0.58 + embeddingPoints * 0.42);
  return {
    ...tiered,
    embeddingSimilarity,
    relevanceScore: Math.max(0, Math.min(100, combined)),
  };
}

export function assetMeetsSemanticMinimum(
  result: SemanticMatchResult,
  _topicDomain?: string
): boolean {
  if (result.tier === 5 && result.matchedEntities.length === 0 && result.relevanceScore < 50) {
    return false;
  }
  if (result.tierLabel.includes("generic people")) return false;
  return result.relevanceScore >= semanticMinRelevanceScore();
}

const AI_RANK_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "semantic_clip_rank",
    strict: true,
    schema: {
      type: "object",
      properties: {
        scores: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              score: { type: "number" },
            },
            required: ["id", "score"],
            additionalProperties: false,
          },
        },
      },
      required: ["scores"],
      additionalProperties: false,
    },
  },
} as const;

/** LLM re-rank top candidates (optional boost). */
export async function applySemanticAiRerank<T extends { asset: MediaArchiveAsset; score: number }>(
  candidates: T[],
  profile: BeatSemanticProfile,
  videoTitle?: string
): Promise<T[]> {
  if (
    process.env.ENABLE_SEMANTIC_AI_RERANK === "false" ||
    !ENV.forgeApiKey ||
    candidates.length < 2
  ) {
    return candidates;
  }

  const pool = candidates.slice(0, 10);
  const lines = pool.map(
    (c, idx) =>
      `${idx}: id=${c.asset.id} title="${(c.asset.title ?? "").slice(0, 80)}" tags=[${normalizeMediaTags(c.asset.tags ?? []).slice(0, 8).join(", ")}]`
  );

  const prompt = `Rank archive clips for this documentary narration sentence.

Sentence: "${profile.beatText}"
Meaning: ${profile.summary}
${videoTitle ? `Video: ${videoTitle}` : ""}
Entities: persons=${profile.entities.persons.join(", ")}, locations=${profile.entities.locations.join(", ")}, events=${profile.entities.events.join(", ")}

Priority (best first):
1. Exact person/company/object shown
2. Exact location or event
3. Same subject/topic footage
4. Same era/domain
NOT: generic soldiers, random crowds, unrelated technology

Candidates:
${lines.join("\n")}

Score each id 0-10 for visual relevance. 10 = perfect match to what is spoken.`;

  try {
    const response = await Promise.race([
      invokeLLM({
        messages: [
          { role: "system", content: "Documentary footage researcher. JSON only." },
          { role: "user", content: prompt },
        ],
        response_format: AI_RANK_SCHEMA,
        maxTokens: 512,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("semantic rerank timeout")), 12_000)
      ),
    ]);

    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string") return candidates;
    const parsed = JSON.parse(content) as { scores?: Array<{ id: number; score: number }> };
    const byId = new Map((parsed.scores ?? []).map((s) => [s.id, s.score]));

    return [...candidates]
      .map((c) => {
        const ai = byId.get(c.asset.id);
        const boost = ai != null ? Math.round(ai * 8) : 0;
        return { ...c, score: c.score + boost };
      })
      .sort((a, b) => b.score - a.score);
  } catch {
    return candidates;
  }
}

export function clearSemanticCaches(): void {
  profileCache.clear();
  embeddingCache.clear();
}

/** Ordered Pexels search queries from literal visual + semantic tiers (exact subject → related topic). */
export function buildSemanticPexelsQueries(
  beatText: string,
  profile: BeatSemanticProfile,
  maxQueries = 8,
  videoTitle?: string,
  literalViewerVisual?: string,
  literalSearchQuery?: string
): string[] {
  const ordered: string[] = [];
  const push = (q: string) => {
    const v = slug(q);
    if (v.length >= 3 && !ordered.includes(v)) ordered.push(v);
  };

  if (literalSearchQuery?.trim()) push(literalSearchQuery);
  if (literalViewerVisual?.trim()) {
    push(literalViewerVisual.slice(0, 72));
    for (const t of extractVisualSearchTags(literalViewerVisual, videoTitle).slice(0, 5)) push(t);
  }

  for (const tier of profile.searchTiers) {
    for (const term of tier) push(term);
  }
  for (const list of [
    profile.entities.persons,
    profile.entities.companies,
    profile.entities.objects,
    profile.entities.locations,
    profile.entities.events,
    profile.entities.timePeriods,
    profile.entities.years,
  ]) {
    for (const item of list) push(item);
  }
  push(profile.summary);
  if (!literalViewerVisual?.trim() && !literalSearchQuery?.trim()) {
    for (const t of extractVisualSearchTags(beatText, videoTitle).slice(0, 6)) push(t);
  }
  for (const t of extractEntitySearchTags(beatText).slice(0, 4)) push(`${t} documentary`);
  for (const t of extractSalientBeatTokens(beatText).slice(0, 3)) push(t);

  return ordered.slice(0, maxQueries);
}
