
import { invokeLLM } from "./_core/llm";
import { getActiveVideoId } from "./videoGenerationCancel";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single search query with a confidence score and reason for selection. */
export type ScoredQuery = {
  query: string;
  /** 0–1: how closely this query matches the beat's visual intent */
  confidence: number;
  reason: string;
};

export type VisualSearchPlan = {
  /** What the beat is visually about ("Roman emperor giving speech") */
  intent: string;
  /** Why these keywords were chosen */
  reasoning: string;
  /** Round 1: exact queries derived from the narration */
  primary: ScoredQuery[];
  /** Round 2: synonyms and variations */
  secondary: ScoredQuery[];
  /** Round 3: higher-abstraction concepts and visible objects */
  concepts: ScoredQuery[];
  /** Round 4: context from adjacent beats */
  context: ScoredQuery[];
  /** Round 5: era, location, period, visual style (painting, engraving, etc.) */
  historical: ScoredQuery[];
  /** Round 6: metaphorical / visual-equivalent terms */
  fallback: ScoredQuery[];
  /** All detected persons */
  people: string[];
  /** All detected objects */
  objects: string[];
  /** All detected locations */
  locations: string[];
  /** All detected time periods and years */
  timePeriod: string[];
  /** Visual style terms: painting, engraving, archive photo, map, document… */
  styles: string[];
};

export type VisualSearchPlanInput = {
  beatText: string;
  sceneText: string;
  topic: string;
  videoContext?: VideoVisualContext;
  adjacentContext?: {
    prevBeat?: string;
    nextBeat?: string;
  };
  /**
   * RENDER 580 — WHAT THIS BEAT IS ABOUT, not what its first four words happen to be.
   *
   * ── The break this closes ───────────────────────────────────────────────────────────────────
   *
   *     beat  "Rumors about Kylie Jenner illuminate how they amplify her celebrity"
   *     → contentTermsFromText → "Rumors Kylie Jenner illuminate"
   *     → scene=2 beat=0 query="illuminate" reason=OK
   *
   * `contentTermsFromText` walks the narration in READING order and keeps the first four
   * non-function words. RONDE 577 already measured what that produces — "shaped"×11, "life"×10,
   * "evidence"×10 — and `visualTermsFromIntent` was written to answer the question properly:
   * subject, then people, event, location, period, objects, with action last and never alone.
   *
   * It was then wired into ONE production call site, the Wikimedia rescue at the bottom of the
   * ladder, and the primary plan — the queries every provider is asked FIRST — kept the reading
   * order. That is this codebase's recurring shape once more: the right answer computed, and read
   * by one route of several.
   *
   * Optional, so a caller that has no typed intent behaves exactly as it did. It cannot widen
   * anything either: every term it yields has already passed `termProvableFrom`, the gate's own
   * evidence measure, so what arrives is a SUBSET of what `contentTermsFromText` could have sent.
   */
  intent?: {
    subject?: string;
    people?: readonly string[];
    event?: readonly string[];
    location?: readonly string[];
    period?: readonly string[];
    objects?: readonly string[];
    action?: readonly string[];
    forbidden?: readonly string[];
  } | null;
};

/**
 * Video-level context built once per render and shared across all beats.
 * Prevents beats from re-deriving who "He" or "they" refers to.
 */
export type VideoVisualContext = {
  people: string[];
  period: string;
  locations: string[];
  visualStyles: string[];
  synopsis: string;
};

// ─── Module-level caches (render-lifetime) ───────────────────────────────────

const _planCache = new Map<string, VisualSearchPlan>();
let _videoContextCache: { key: string; ctx: VideoVisualContext } | null = null;

/** Evict only one video's entries — safe to call when that video's render finishes even
 *  though other videos may still be rendering concurrently in the same process (a blanket
 *  clearVisualSearchPlanCache() would wipe their still-in-progress cached plans too). */
export function clearVisualSearchPlanCacheForVideo(videoId: number): void {
  const prefix = `v${videoId}:`;
  for (const key of _planCache.keys()) {
    if (key.startsWith(prefix)) _planCache.delete(key);
  }
  if (_videoContextCache?.key.startsWith(prefix)) _videoContextCache = null;
}

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function visualSearchPlanEnabled(): boolean {
  return process.env.VISUAL_SEARCH_PLAN_ENABLED !== "false";
}

// ─── Video Visual Context ─────────────────────────────────────────────────────

/**
 * Build video-level context from the title (+ optional synopsis).
 * Called once per render; result shared by all beats.
 */
export async function buildVideoVisualContext(
  videoTitle: string,
  synopsis?: string
): Promise<VideoVisualContext> {
  // Scoped by the active render's videoId (not just the title) — two different videos can
  // legitimately produce the identical title string (formulaic documentary titles are common),
  // which without this would silently hand the second video the first's cached people/period/
  // locations context. Mirrors the identical fix already applied to the sibling storyboard
  // cache in editorialSequencePlanner.ts.
  const cacheKey = `v${getActiveVideoId() ?? "?"}:${videoTitle}`;
  if (_videoContextCache?.key === cacheKey) return _videoContextCache.ctx;

  const fallback: VideoVisualContext = {
    people: [],
    period: "",
    locations: [],
    visualStyles: ["photograph", "video footage"],
    synopsis: synopsis ?? videoTitle,
  };

  if (!visualSearchPlanEnabled()) return fallback;

  try {
    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are a documentary researcher. Return ONLY valid JSON, no markdown.",
        },
        {
          role: "user",
          content:
            `Video title: "${videoTitle}"` +
            (synopsis ? `\nSynopsis: "${synopsis.slice(0, 400)}"` : "") +
            `

Return JSON:
{
  "people": ["name", ...],        // main characters/persons mentioned (max 8)
  "period": "1796–1815",          // time period as a string (empty if unknown)
  "locations": ["France", ...],   // main locations (max 6)
  "visualStyles": ["painting", "map", "engraving", "archive photograph", ...],  // what visual media best represents this topic (max 5)
  "synopsis": "one sentence what this video is about"
}`,
        },
      ],
      preferProvider: "groq",
      maxTokens: 300,
      responseFormat: { type: "json_object" },
    });

    const text =
      typeof result.choices[0]?.message.content === "string"
        ? result.choices[0].message.content
        : "";
    const parsed = JSON.parse(text) as Partial<VideoVisualContext>;

    const ctx: VideoVisualContext = {
      people: Array.isArray(parsed.people)
        ? parsed.people.filter((s): s is string => typeof s === "string").slice(0, 8)
        : [],
      period: typeof parsed.period === "string" ? parsed.period : "",
      locations: Array.isArray(parsed.locations)
        ? parsed.locations.filter((s): s is string => typeof s === "string").slice(0, 6)
        : [],
      visualStyles: Array.isArray(parsed.visualStyles)
        ? parsed.visualStyles.filter((s): s is string => typeof s === "string").slice(0, 5)
        : fallback.visualStyles,
      synopsis: typeof parsed.synopsis === "string" ? parsed.synopsis : fallback.synopsis,
    };

    console.log(
      `[VisualSearchPlan] VideoContext for "${videoTitle}"\n` +
        `  People:  ${JSON.stringify(ctx.people)}\n` +
        `  Period:  ${ctx.period}\n` +
        `  Locs:    ${JSON.stringify(ctx.locations)}\n` +
        `  Styles:  ${JSON.stringify(ctx.visualStyles)}\n` +
        `  Synopsis: ${ctx.synopsis}`
    );

    _videoContextCache = { key: cacheKey, ctx };
    return ctx;
  } catch {
    _videoContextCache = { key: cacheKey, ctx: fallback };
    return fallback;
  }
}
