/**
 * Per-sentence English visual search keywords for stock/archive footage.
 * Generated after script creation — narration text is never modified.
 */
import { invokeLLM } from "./_core/llm";
import {
  extractFullNarrationText,
  parseMarkdownNarrationBlocks,
} from "./scriptWriter";
import {
  extractPrimaryGeoSearchTag,
  extractPrimaryVisualAnchor,
  extractBeatGeoPlaceTags,
  isGeoWelcomeBeat,
  buildGeoWelcomeVisualQueries,
} from "./visualBeatTags";

export type ScriptVisualKeywordEntry = {
  sentence: string;
  keyword: string;
};

const BATCH_SIZE = 35;

const ABSTRACT_KEYWORD_RE =
  /\b(success|growth|groei|strategy|strategie|company|bedrijf|business|person|persoon|people|concept|idea|innovation|future|impact|value|vision|mission|goal|doel|solution|opportunity|challenge|important|significant|powerful|amazing|incredible|remarkable)\b/i;

const KEYWORD_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "sentence_visual_keywords",
    strict: true,
    schema: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer" },
              keyword: { type: "string" },
            },
            required: ["index", "keyword"],
            additionalProperties: false,
          },
        },
      },
      required: ["keywords"],
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
export function sanitizeVisualKeyword(keyword: string): string {
  let k = keyword
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

/** Heuristic fallback when LLM output is missing or invalid. */
export function fallbackVisualKeyword(sentence: string): string {
  const anchor = extractPrimaryVisualAnchor(sentence);
  if (anchor && !ABSTRACT_KEYWORD_RE.test(anchor)) {
    const cleaned = sanitizeVisualKeyword(anchor.replace(/_/g, " "));
    if (cleaned) return cleaned;
  }

  const geo = extractPrimaryGeoSearchTag(sentence);
  if (geo) {
    if (isGeoWelcomeBeat(sentence)) {
      const welcome = buildGeoWelcomeVisualQueries(sentence)[0];
      if (welcome) {
        const cleaned = sanitizeVisualKeyword(welcome);
        if (cleaned) return cleaned;
      }
    }
    const geoQuery = sanitizeVisualKeyword(`${geo} aerial video`);
    if (geoQuery) return geoQuery;
  }

  const tokens = sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !ABSTRACT_KEYWORD_RE.test(w))
    .slice(0, 3);

  if (tokens.length >= 2) {
    const joined = sanitizeVisualKeyword(tokens.join(" "));
    if (joined) return joined;
  }

  return "documentary broll scene";
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

export function lookupSentenceKeyword(
  sentence: string,
  map: Map<string, string>
): string | undefined {
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
  return score;
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

function buildKeywordBatchPrompt(sentences: string[], offset: number): string {
  const lines = sentences
    .map((s, i) => `${offset + i}: ${s.replace(/\s+/g, " ").trim()}`)
    .join("\n");

  return `Assign exactly one English stock-footage search phrase per narration sentence.

Rules:
- 2–5 lowercase English words per keyword
- Concrete visible subjects: people, objects, actions, locations
- Optimized for Pexels / stock video / AI image search
- Focus on what a camera would show, not abstract ideas
- If multiple subjects, pick the dominant visual element
- NEVER use vague words alone: success, growth, strategy, company, business, person, people, concept, innovation
- Script language may be Dutch or other — keywords must always be English

Examples:
"Dutch: De ondernemer werkt laat door aan zijn nieuwe webshop." → entrepreneur working laptop
"Dutch: De klant bekijkt verschillende producten op zijn telefoon." → online shopping smartphone
"Dutch: Het team bespreekt de resultaten tijdens een vergadering." → business meeting team

"Welcome to the Netherlands." → netherlands aerial drone video
"Dutch: Welkom in Nederland." → amsterdam canal timelapse

Return one keyword per index below.

Sentences:
${lines}`;
}

async function generateKeywordBatch(
  sentences: string[],
  offset: number
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (sentences.length === 0) return result;

  try {
    const resp = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are a stock footage search expert. Return valid JSON only — one concrete English visual search phrase per sentence index.",
        },
        { role: "user", content: buildKeywordBatchPrompt(sentences, offset) },
      ],
      response_format: KEYWORD_JSON_SCHEMA,
    });

    const raw = resp?.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as {
      keywords?: Array<{ index?: number; keyword?: string }>;
    };

    for (const row of parsed.keywords ?? []) {
      if (typeof row.index !== "number" || typeof row.keyword !== "string") continue;
      const kw = sanitizeVisualKeyword(row.keyword);
      if (kw) result.set(row.index, kw);
    }
  } catch (err) {
    console.warn("[ScriptKeywords] LLM batch failed:", err);
  }

  return result;
}

/** Generate one English visual keyword per narration sentence. */
export async function generateScriptVisualKeywords(
  script: string
): Promise<ScriptVisualKeywordEntry[]> {
  const sentences = extractNarrationSentences(script);
  if (sentences.length === 0) return [];

  const indexToKeyword = new Map<number, string>();

  for (let offset = 0; offset < sentences.length; offset += BATCH_SIZE) {
    const batch = sentences.slice(offset, offset + BATCH_SIZE);
    const batchResult = await generateKeywordBatch(batch, offset);
    for (const [idx, kw] of batchResult) {
      indexToKeyword.set(idx, kw);
    }
  }

  const entries: ScriptVisualKeywordEntry[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    const keyword = indexToKeyword.get(i) ?? fallbackVisualKeyword(sentence);
    entries.push({ sentence, keyword });
  }

  console.log(
    `[ScriptKeywords] Generated ${entries.length} visual keywords` +
      ` (${indexToKeyword.size} from LLM, ${entries.length - indexToKeyword.size} fallback)`
  );

  return entries;
}

/** Generate keywords and merge into video metadata (script text unchanged). */
export async function attachScriptVisualKeywords(
  script: string,
  metadata: unknown = {}
): Promise<{ metadata: Record<string, unknown>; keywords: ScriptVisualKeywordEntry[] }> {
  const keywords = await generateScriptVisualKeywords(script);
  return {
    metadata: mergeVisualKeywordsIntoMetadata(metadata, keywords),
    keywords,
  };
}
