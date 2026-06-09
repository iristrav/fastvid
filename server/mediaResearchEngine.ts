/**
 * Universal media research engine — Laag 1 (intent) + Laag 3 (ranking).
 * Laag 2 (multi-source fetch) and Laag 4 (montage) live in videoPipeline.ts.
 */
import path from "path";
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";

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
  person_celebrity: 95,
  wikimedia_video: 92,
  youtube_cc: 90,
  internet_archive: 88,
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
  if (!personName.trim()) return false;
  const hay = haystack.toLowerCase();
  const parts = personName.toLowerCase().split(/\s+/).filter((p) => p.length >= 2);
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
  if (primaryPerson.trim() || personTopicLock) return "person";
  if (spaceTopic) return "space";
  if (HISTORICAL_TOPIC_RE.test(beatText)) return "historical";
  if (NEWS_TOPIC_RE.test(beatText)) return "news";
  return "general";
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
  const topicKind = inferTopicKind(
    params.beatText,
    params.primaryPerson,
    params.spaceTopic,
    params.personTopicLock
  );
  const queries = Array.from(
    new Set(
      params.searchQueries
        .map((q) => q.trim())
        .filter((q) => q.length >= 3)
    )
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
      if (source === "wikimedia_video" || source === "wikimedia_image") return 12;
      if (source === "internet_archive" || source === "europeana") return 10;
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
    "person_celebrity",
    "wikimedia_video",
    "youtube_cc",
    "internet_archive",
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
        response_format: AI_RANK_JSON_SCHEMA,
        maxTokens: 1024,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AI rank timeout")), options.timeoutMs ?? 12_000)
      ),
    ]);

    const content = response.choices[0]?.message?.content;
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
