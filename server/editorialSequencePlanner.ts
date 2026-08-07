/**
 * Editorial Sequence Planner
 *
 * For each scene, generates a mini-storyboard *before* visual retrieval:
 * an ordered list of shot descriptions that tell the retrieval engine exactly
 * what to look for — shot type, subject action, location, era, visual style.
 *
 * The planner runs once per scene (cached) and injects visual descriptions
 * and additional search queries into beats so that `beatPrimaryFetch` and
 * the 6-round rescue path both benefit.
 *
 * Feature flag: EDITORIAL_SEQUENCE_PLANNER_ENABLED (default: "true")
 */

import { invokeLLM } from "./_core/llm";
import { getActiveVideoId } from "./videoGenerationCancel";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ShotDescription = {
  /** Beat index this shot corresponds to */
  beatIndex: number;
  /** E.g. "wide establishing shot", "close-up", "aerial", "archival still" */
  shotType: string;
  /** What the primary subject is doing */
  action: string;
  /** Where it takes place */
  location: string;
  /** Era / time period hint */
  era: string;
  /** Visual media style: "photograph", "engraving", "painting", "map", "newsreel", "video" */
  visualStyle: string;
  /** Primary search query derived from shot description (pre-built for retrieval) */
  searchQuery: string;
  /** 2-3 additional search alternatives */
  alternatives: string[];
  /** Emotional tone of the shot */
  emotion: string;
};

export type SceneStoryboard = {
  sceneIndex: number;
  sceneSummary: string;
  shots: ShotDescription[];
};

// ─── Module cache (render-lifetime) ──────────────────────────────────────────

const _storyboardCache = new Map<string, SceneStoryboard>();

export function clearStoryboardCache(): void {
  _storyboardCache.clear();
}

/** Evict only one video's entries — safe to call when that video's render finishes even
 *  though other videos may still be rendering concurrently in the same process (a blanket
 *  clearStoryboardCache() would wipe their still-in-progress cached storyboards too). Without
 *  this, entries accumulated for the life of the process with nothing ever evicting them. */
export function clearStoryboardCacheForVideo(videoId: number): void {
  const prefix = `v${videoId}:`;
  for (const key of _storyboardCache.keys()) {
    if (key.startsWith(prefix)) _storyboardCache.delete(key);
  }
}

// Phase 12: the cache key previously carried no video identity ("s${sceneIndex}"), so once the
// worker process rendered one video, every later video whose scene count reached a previously
// -cached index silently reused that earlier, unrelated video's storyboard (wrong shots, wrong
// search queries) — invisible from the outside, deterministic on every render past the first.
// getActiveVideoId() reuses the render-scoped AsyncLocalStorage context already established for
// this exact purpose elsewhere (videoGenerationCancel.ts), so no function signature here needs
// to change to thread a videoId through.
function storyboardCacheKey(sceneIndex: number): string {
  return `v${getActiveVideoId() ?? "?"}:s${sceneIndex}`;
}

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function editorialSequencePlannerEnabled(): boolean {
  return process.env.EDITORIAL_SEQUENCE_PLANNER_ENABLED !== "false";
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(
  sceneText: string,
  beats: Array<{ index: number; text: string }>,
  videoTitle: string,
  videoContext: { people: string[]; period: string; locations: string[]; visualStyles: string[] }
): string {
  const ctxLines = [
    videoContext.people.length ? `People: ${videoContext.people.join(", ")}` : "",
    videoContext.period ? `Period: ${videoContext.period}` : "",
    videoContext.locations.length ? `Locations: ${videoContext.locations.join(", ")}` : "",
    videoContext.visualStyles.length ? `Visual styles: ${videoContext.visualStyles.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const beatLines = beats
    .map((b) => `Beat ${b.index}: "${b.text.slice(0, 120)}"`)
    .join("\n");

  return `You are a professional documentary film editor creating a shot list.

Video: "${videoTitle}"
${ctxLines}

Scene narration: "${sceneText.slice(0, 400)}"

Beats to cover:
${beatLines}

For EACH beat, design one ideal archival/stock shot. Return ONLY this JSON array:
[
  {
    "beatIndex": 0,
    "shotType": "wide establishing shot",
    "action": "soldiers marching through a ruined city",
    "location": "Berlin, Germany",
    "era": "1945",
    "visualStyle": "black and white photograph",
    "searchQuery": "WWII soldiers marching Berlin 1945",
    "alternatives": ["World War 2 troops Germany", "Allied forces Berlin ruins"],
    "emotion": "somber"
  },
  ...
]

Rules:
- shotType: wide/medium/close-up/aerial/extreme close-up/archival still/map/document
- visualStyle: photograph/video footage/engraving/painting/newsreel/map/illustration
- searchQuery: 4-7 words, specific and searchable on stock/archive sites
- alternatives: 2 fallback queries if primary fails
- emotion: somber/triumphant/tense/peaceful/chaotic/reverent/dramatic/neutral
- If beat is abstract, find a concrete visual metaphor
- Use the era and location from video context when relevant`;
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

function buildFallback(
  beats: Array<{ index: number; text: string }>,
  sceneIndex: number
): SceneStoryboard {
  return {
    sceneIndex,
    sceneSummary: "",
    shots: beats.map((b) => ({
      beatIndex: b.index,
      shotType: "medium shot",
      action: b.text.slice(0, 60),
      location: "",
      era: "",
      visualStyle: "photograph",
      searchQuery: b.text.slice(0, 60),
      alternatives: [],
      emotion: "neutral",
    })),
  };
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Generate (or return cached) an editorial shot list for a scene.
 * Each shot maps 1:1 to a beat and provides enriched visual retrieval context.
 */
export async function getOrGenerateStoryboard(
  sceneIndex: number,
  sceneText: string,
  beats: Array<{ index: number; text: string }>,
  videoTitle: string,
  videoContext: { people: string[]; period: string; locations: string[]; visualStyles: string[] }
): Promise<SceneStoryboard> {
  const cacheKey = storyboardCacheKey(sceneIndex);
  const cached = _storyboardCache.get(cacheKey);
  if (cached) return cached;

  if (!editorialSequencePlannerEnabled() || beats.length === 0) {
    const fb = buildFallback(beats, sceneIndex);
    _storyboardCache.set(cacheKey, fb);
    return fb;
  }

  try {
    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are a professional documentary film editor. Return ONLY valid JSON.",
        },
        {
          role: "user",
          content: buildPrompt(sceneText, beats, videoTitle, videoContext),
        },
      ],
      preferProvider: "groq",
      maxTokens: 800,
      responseFormat: { type: "json_object" },
    });

    const raw =
      typeof result.choices[0]?.message.content === "string"
        ? result.choices[0].message.content
        : "[]";

    // Response may be an object wrapping the array
    let parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const values = Object.values(parsed as Record<string, unknown>);
      parsed = values.find(Array.isArray) ?? [];
    }
    const shots = (parsed as unknown[])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s): ShotDescription => ({
        beatIndex: typeof s["beatIndex"] === "number" ? s["beatIndex"] : 0,
        shotType: typeof s["shotType"] === "string" ? s["shotType"] : "medium shot",
        action: typeof s["action"] === "string" ? s["action"] : "",
        location: typeof s["location"] === "string" ? s["location"] : "",
        era: typeof s["era"] === "string" ? s["era"] : "",
        visualStyle: typeof s["visualStyle"] === "string" ? s["visualStyle"] : "photograph",
        searchQuery: typeof s["searchQuery"] === "string" ? s["searchQuery"] : "",
        alternatives: Array.isArray(s["alternatives"])
          ? (s["alternatives"] as unknown[]).filter((a): a is string => typeof a === "string").slice(0, 3)
          : [],
        emotion: typeof s["emotion"] === "string" ? s["emotion"] : "neutral",
      }));

    const storyboard: SceneStoryboard = {
      sceneIndex,
      sceneSummary: sceneText.slice(0, 100),
      shots,
    };

    // Log the storyboard
    console.log(`[Editorial] s${sceneIndex} storyboard (${shots.length} shots):`);
    for (const shot of shots) {
      console.log(
        `  b${shot.beatIndex}: [${shot.shotType}] ${shot.action.slice(0, 50)} ` +
          `| style: ${shot.visualStyle} | q: "${shot.searchQuery}"`
      );
    }

    _storyboardCache.set(cacheKey, storyboard);
    return storyboard;
  } catch (err) {
    console.warn(`[Editorial] s${sceneIndex} storyboard LLM failed:`, (err as Error).message?.slice(0, 80));
    const fb = buildFallback(beats, sceneIndex);
    _storyboardCache.set(cacheKey, fb);
    return fb;
  }
}

/**
 * Look up the shot description for a specific beat within a cached storyboard.
 * Returns null if no storyboard is cached for this scene yet.
 */
export function getShotForBeat(
  sceneIndex: number,
  beatIndex: number
): ShotDescription | null {
  const board = _storyboardCache.get(storyboardCacheKey(sceneIndex));
  if (!board) return null;
  return board.shots.find((s) => s.beatIndex === beatIndex) ?? null;
}

/**
 * Merge storyboard shot info into a beat's retrieval context.
 * Returns enriched `pexelsQueries` and `visualDescription` for the beat.
 */
export function enrichBeatFromShot(
  beatText: string,
  beatPexelsQueries: string[],
  shot: ShotDescription | null
): { pexelsQueries: string[]; visualDescription: string } {
  if (!shot) {
    return { pexelsQueries: beatPexelsQueries, visualDescription: beatText };
  }

  const editorialQueries: string[] = [];
  if (shot.searchQuery) editorialQueries.push(shot.searchQuery);
  editorialQueries.push(...shot.alternatives);

  // Build merged query list: editorial first (more specific), then original
  const merged = Array.from(
    new Set([...editorialQueries, ...beatPexelsQueries])
  ).slice(0, 8);

  const visualDescription = [
    shot.action,
    shot.location && `in ${shot.location}`,
    shot.era && `(${shot.era})`,
    `${shot.shotType}, ${shot.visualStyle}`,
    shot.emotion !== "neutral" && `mood: ${shot.emotion}`,
  ]
    .filter(Boolean)
    .join(" ");

  return { pexelsQueries: merged, visualDescription };
}
