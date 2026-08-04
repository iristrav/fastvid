/**
 * Visual Director — plans B-roll before any archive/stock search.
 * Each scene = one visual idea, driven by visual_description (not spoken keywords).
 */
import { invokeLLM } from "./_core/llm";
import {
  extractFullNarrationText,
  parseMarkdownNarrationBlocks,
} from "./scriptWriter";
import { inferLiteralViewerVisual } from "./viewerVisualPlan";
import { DOCUMENTARY_EDITOR_VIEWER_QUESTION } from "./documentaryVisualPolicy";
import type { ScriptVisualIntentEntry } from "./scriptVisualKeywords";

export const VISUAL_DIRECTOR_MIN_SEC = 3.5;
export const VISUAL_DIRECTOR_MAX_SEC = 5;

export type VisualDirectorScene = {
  /** Index of the source narration sentence in script order. */
  source_sentence_index: number;
  spoken_text: string;
  visual_description: string;
  camera_shot: string;
  emotion: string;
  search_query: string;
};

const CAMERA_SHOTS = new Set([
  "wide shot",
  "medium shot",
  "close-up",
  "close up",
  "closeup",
  "aerial",
  "overhead",
  "establishing shot",
  "tracking shot",
  "detail shot",
  "low angle",
  "high angle",
]);

const DIRECTOR_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "visual_director_plan",
    strict: true,
    schema: {
      type: "object",
      properties: {
        scenes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source_sentence_index: { type: "integer" },
              spoken_text: { type: "string" },
              visual_description: { type: "string" },
              camera_shot: { type: "string" },
              emotion: { type: "string" },
              search_query: { type: "string" },
            },
            required: [
              "source_sentence_index",
              "spoken_text",
              "visual_description",
              "camera_shot",
              "emotion",
              "search_query",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["scenes"],
      additionalProperties: false,
    },
  },
} as const;

const BATCH_SIZE = 12;

const ABSTRACT_KEYWORD_RE =
  /\b(success|growth|groei|strategy|strategie|company|bedrijf|business|person|persoon|people|concept|idea|innovation|future|impact|value|vision|mission|goal|doel|solution|opportunity|challenge|important|significant|powerful|amazing|incredible|remarkable)\b/i;

function coerceText(raw: unknown, fallback = ""): string {
  if (typeof raw === "string") return raw;
  if (raw == null) return fallback;
  return String(raw);
}

function normalizeSentenceKey(sentence: string): string {
  return sentence.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractNarrationSentences(script: string): string[] {
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

function splitBeatSentences(text: string): string[] {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];
  const sentences =
    trimmed.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()).filter((s) => s.length > 5) ?? [];
  if (sentences.length > 0) return sentences;
  if (trimmed.length > 5) return [trimmed];
  return [];
}

function sanitizeVisualKeyword(keyword: unknown): string {
  let k = coerceText(keyword)
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

function sanitizeVisualIntentText(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 8 || t.length > 220) return "";
  if (/^(success|growth|strategy|concept|innovation|business)$/i.test(t)) return "";
  return t;
}

function sanitizeSceneType(sceneType: unknown): string {
  const SCENE_TYPES = new Set([
    "office", "city", "nature", "home", "factory", "street", "transport", "government",
    "sports", "technology", "medical", "education", "historical", "aerial", "retail", "restaurant", "other",
  ]);
  const t = coerceText(sceneType, "other").toLowerCase().replace(/[^a-z_]/g, "").trim();
  return SCENE_TYPES.has(t) ? t : "other";
}

function sanitizePrioritySubject(subject: unknown): string {
  const k = sanitizeVisualKeyword(subject);
  if (k) return k.split(/\s+/).slice(0, 2).join(" ");
  const words = coerceText(subject, "scene")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !ABSTRACT_KEYWORD_RE.test(w))
    .slice(0, 2);
  return words.join(" ") || "scene";
}

function sanitizeCameraShot(raw: unknown): string {
  const t = coerceText(raw, "medium shot").toLowerCase().replace(/\s+/g, " ").trim();
  if (CAMERA_SHOTS.has(t)) return t === "close up" || t === "closeup" ? "close-up" : t;
  if (/wide|establishing|aerial|overhead|drone/.test(t)) return "wide shot";
  if (/close|detail|macro/.test(t)) return "close-up";
  if (/medium|mid/.test(t)) return "medium shot";
  return "medium shot";
}

function sanitizeEmotion(raw: unknown): string {
  const t = coerceText(raw, "neutral").toLowerCase().replace(/[^a-z\s-]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length >= 3 && t.length <= 32) return t;
  return "neutral";
}

function sanitizeSearchQuery(raw: string, visualDescription: string): string {
  const q = sanitizeVisualKeyword(raw);
  if (q) return q;
  const fromDesc = visualDescription
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 5)
    .join(" ");
  return sanitizeVisualKeyword(fromDesc) || fromDesc.slice(0, 72);
}

function sanitizeVisualDescription(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length < 12 || t.length > 220) return "";
  return t;
}

function inferSceneTypeFromDescription(description: string, searchQuery: string): string {
  const hay = `${description} ${searchQuery}`.toLowerCase();
  if (/\b(office|desk|laptop|meeting|entrepreneur|worker)\b/.test(hay)) return "office";
  if (/\b(highway|train|tram|metro|bus|airport|transport)\b/.test(hay)) return "transport";
  if (/\b(government|parliament|capitol|city hall)\b/.test(hay)) return "government";
  if (/\b(factory|warehouse|production)\b/.test(hay)) return "factory";
  if (/\b(home|kitchen|living room|bedroom)\b/.test(hay)) return "home";
  if (/\b(hospital|doctor|medical|nurse)\b/.test(hay)) return "medical";
  if (/\b(school|university|student|campus)\b/.test(hay)) return "education";
  if (/\b(aerial|skyline|city|urban|street|amsterdam|berlin)\b/.test(hay)) return "city";
  if (/\b(nature|forest|ocean|wildlife|landscape)\b/.test(hay)) return "nature";
  return "other";
}

/** Map a director scene to the legacy intent shape used by the pipeline. */
export function directorSceneToIntent(scene: VisualDirectorScene): ScriptVisualIntentEntry {
  const visualDescription =
    sanitizeVisualIntentText(scene.visual_description) || coerceText(scene.visual_description).trim();
  const searchQuery = sanitizeSearchQuery(scene.search_query, visualDescription);
  const primary = searchQuery || sanitizeVisualKeyword(visualDescription) || "documentary broll scene";
  const sceneType = sanitizeSceneType(inferSceneTypeFromDescription(visualDescription, primary));
  const cameraShot = sanitizeCameraShot(scene.camera_shot);
  const emotion = sanitizeEmotion(scene.emotion);
  const secondary =
    sanitizeVisualKeyword(`${emotion} ${cameraShot} ${primary.split(/\s+/).slice(0, 2).join(" ")}`) ||
    primary;
  const fallback =
    sanitizeVisualKeyword(`${sceneType} broll ${primary.split(/\s+/)[0] ?? "scene"}`) || primary;

  return {
    sentence: coerceText(scene.spoken_text),
    visual_intent: visualDescription,
    visual_description: visualDescription,
    camera_shot: cameraShot,
    emotion,
    search_query: searchQuery || coerceText(scene.search_query).trim(),
    primary_keyword: primary,
    secondary_keyword: secondary,
    fallback_keyword: fallback,
    scene_type: sceneType,
    priority_subject: sanitizePrioritySubject(primary.split(/\s+/)[0] ?? "scene"),
  };
}

export function hasDirectorPlan(intent: ScriptVisualIntentEntry | undefined): boolean {
  if (!intent) return false;
  return Boolean(
    intent.visual_description?.trim() ||
      intent.search_query?.trim() ||
      intent.camera_shot?.trim()
  );
}

/** Match director scenes whose spoken_text appears in this scene voice block. */
export function directorScenesForSceneVoice(
  sceneText: string,
  allScenes: VisualDirectorScene[]
): VisualDirectorScene[] {
  const sceneNorm = normalizeSentenceKey(sceneText);
  const parts = splitBeatSentences(sceneText);
  const partKeys = parts.map(normalizeSentenceKey);

  return allScenes.filter((d) => {
    const key = normalizeSentenceKey(d.spoken_text);
    if (sceneNorm.includes(key)) return true;
    return partKeys.some((p) => p.includes(key) || key.includes(p));
  });
}

/** Merge excess director scenes so each beat stays ≥ VISUAL_DIRECTOR_MIN_SEC on screen. */
export function mergeDirectorScenesForPacing(
  scenes: VisualDirectorScene[],
  maxScenes: number
): VisualDirectorScene[] {
  if (scenes.length <= maxScenes || maxScenes < 1) return scenes;
  const out: VisualDirectorScene[] = [];
  const groupSize = Math.ceil(scenes.length / maxScenes);
  for (let i = 0; i < scenes.length; i += groupSize) {
    const chunk = scenes.slice(i, i + groupSize);
    const first = chunk[0]!;
    if (chunk.length === 1) {
      out.push(first);
      continue;
    }
    out.push({
      ...first,
      spoken_text: chunk.map((c) => c.spoken_text).join(" "),
      visual_description: chunk.map((c) => c.visual_description).join("; "),
      search_query: first.search_query,
    });
  }
  return out.slice(0, maxScenes);
}

export function estimateDirectorSceneHoldSec(
  spokenText: string,
  sceneDuration: number,
  sceneCount: number
): number {
  const words = spokenText.replace(/\[visual:[^\]]+\]/gi, "").split(/\s+/).filter(Boolean).length;
  const byWords = words / 2.8;
  const evenShare = sceneDuration / Math.max(1, sceneCount);
  return Math.max(
    VISUAL_DIRECTOR_MIN_SEC,
    Math.min(VISUAL_DIRECTOR_MAX_SEC, Math.min(byWords, evenShare * 1.02))
  );
}

function buildDirectorBatchPrompt(sentences: string[], offset: number): string {
  const lines = sentences
    .map((s, i) => `${offset + i}: ${s.replace(/\s+/g, " ").trim()}`)
    .join("\n");

  return `${DOCUMENTARY_EDITOR_VIEWER_QUESTION}

Describe ONE concrete visual scene per sentence (subject + action + setting). Search footage from that scene only — never from the spoken words.

You are a professional documentary VISUAL DIRECTOR. Before any footage search, plan what the camera shows for each voice-over line.

For EACH sentence index, output one or MORE scenes (split when the sentence contains multiple distinct visual ideas).

Each scene MUST include:
- source_sentence_index: index from the list below
- spoken_text: the exact words this clip covers (full sentence OR a clear sub-phrase when split)
- visual_description: one concrete English scene — what the viewer literally sees (subject + action + setting). This drives clip selection — NOT the spoken words.
- camera_shot: wide shot | medium shot | close-up | aerial | establishing shot | tracking shot | detail shot
- emotion: single English mood word (e.g. frustration, hope, tension, pride, calm)
- search_query: 3–6 word English stock-footage search phrase derived ONLY from visual_description (never copy Dutch narration words)

Rules:
- MAX 1 visual idea per scene
- Split multi-concept sentences into separate scenes with different visual_description + search_query
- search_query must describe visible footage, not abstract concepts (no: success, growth, strategy)
- Do NOT search on voice-over words — search on what the viewer should see
- Script may be Dutch — all director fields except spoken_text must be English
- Each scene will be 3–5 seconds on screen

Example sentence (Dutch):
"Steeds meer bedrijven investeren in AI-automatisering."
→ scene 1:
  spoken_text: "Steeds meer bedrijven investeren in AI-automatisering."
  visual_description: "A person typing on a laptop at an office desk."
  camera_shot: "medium shot"
  emotion: "focus"
  search_query: "person laptop office desk"
(NOT "AI automation" or "innovation" — show what the viewer LITERALLY sees)

Example sentence (Dutch):
"Dutch cyclists fill Amsterdam while highways expand outside the city."
→ scene A: cyclists in Amsterdam / scene B: highway construction — separate spoken_text fragments

Sentences:
${lines}`;
}

function normalizeDirectorScene(
  row: Partial<VisualDirectorScene>,
  sentences: string[],
  offset: number
): VisualDirectorScene | null {
  if (typeof row.source_sentence_index !== "number") return null;
  const sentence = sentences[row.source_sentence_index - offset];
  const spoken = String(row.spoken_text ?? sentence ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const visualDescription = sanitizeVisualDescription(String(row.visual_description ?? ""));
  if (!spoken || spoken.length < 4 || !visualDescription) return null;

  const searchQuery = sanitizeSearchQuery(String(row.search_query ?? ""), visualDescription);
  if (!searchQuery) return null;

  return {
    source_sentence_index: row.source_sentence_index,
    spoken_text: spoken,
    visual_description: visualDescription,
    camera_shot: sanitizeCameraShot(String(row.camera_shot ?? "medium shot")),
    emotion: sanitizeEmotion(String(row.emotion ?? "neutral")),
    search_query: searchQuery,
  };
}

async function generateDirectorBatch(
  sentences: string[],
  offset: number
): Promise<VisualDirectorScene[]> {
  if (sentences.length === 0) return [];

  try {
    const resp = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are an expert documentary visual director. Return valid JSON only. " +
            "Answer the editorial viewer question first, then plan filmable B-roll from that scene — never keyword-copy narration.",
        },
        { role: "user", content: buildDirectorBatchPrompt(sentences, offset) },
      ],
      response_format: DIRECTOR_JSON_SCHEMA,
    });

    const raw = resp?.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as {
      scenes?: Partial<VisualDirectorScene>[];
    };

    const out: VisualDirectorScene[] = [];
    for (const row of parsed.scenes ?? []) {
      const scene = normalizeDirectorScene(row, sentences, offset);
      if (scene) out.push(scene);
    }
    return out;
  } catch (err) {
    console.warn("[VisualDirector] LLM batch failed:", err);
    return [];
  }
}

function fallbackDirectorScene(sentence: string, index: number): VisualDirectorScene {
  const literal = inferLiteralViewerVisual(sentence);
  const search = sanitizeSearchQuery(literal.searchQuery, literal.description);
  return {
    source_sentence_index: index,
    spoken_text: sentence,
    visual_description: literal.description,
    camera_shot: "medium shot",
    emotion: "neutral",
    search_query: search || literal.searchQuery,
  };
}

/** Run visual director on full script — must complete before footage search. */
export async function generateVisualDirectorPlan(script: string): Promise<VisualDirectorScene[]> {
  const sentences = extractNarrationSentences(script);
  if (sentences.length === 0) return [];

  const all: VisualDirectorScene[] = [];

  for (let offset = 0; offset < sentences.length; offset += BATCH_SIZE) {
    const batch = sentences.slice(offset, offset + BATCH_SIZE);
    const batchScenes = await generateDirectorBatch(batch, offset);
    all.push(...batchScenes);
  }

  // Fill gaps: any sentence without a director scene gets a rule-based fallback
  const covered = new Set(all.map((s) => s.source_sentence_index));
  for (let i = 0; i < sentences.length; i++) {
    if (!covered.has(i) && !all.some((s) => normalizeSentenceKey(s.spoken_text) === normalizeSentenceKey(sentences[i]!))) {
      all.push(fallbackDirectorScene(sentences[i]!, i));
    }
  }

  all.sort((a, b) => a.source_sentence_index - b.source_sentence_index || a.spoken_text.localeCompare(b.spoken_text));

  console.log(
    `[VisualDirector] Planned ${all.length} visual scene(s) for ${sentences.length} narration sentence(s)`
  );

  return all;
}

export function parseVisualDirectorFromMetadata(metadata: unknown): VisualDirectorScene[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>).visualDirectorScenes;
  if (!Array.isArray(raw)) return [];

  const out: VisualDirectorScene[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const spoken = String(row.spoken_text ?? "").trim();
    const visualDescription = sanitizeVisualDescription(String(row.visual_description ?? ""));
    const searchQuery = sanitizeSearchQuery(String(row.search_query ?? ""), visualDescription);
    if (spoken.length < 4 || !visualDescription || !searchQuery) continue;
    out.push({
      source_sentence_index: Number(row.source_sentence_index ?? 0),
      spoken_text: spoken,
      visual_description: visualDescription,
      camera_shot: sanitizeCameraShot(String(row.camera_shot ?? "medium shot")),
      emotion: sanitizeEmotion(String(row.emotion ?? "neutral")),
      search_query: searchQuery,
    });
  }
  return out;
}

export function mergeVisualDirectorIntoMetadata(
  metadata: unknown,
  scenes: VisualDirectorScene[]
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  base.visualDirectorScenes = scenes;
  return base;
}
