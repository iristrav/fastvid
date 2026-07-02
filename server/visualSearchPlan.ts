/**
 * Visual Search Plan — generates a multi-round, structured set of search queries
 * per scene so the retrieval engine can progressively broaden its search before
 * falling back to AI generation or color fill.
 *
 * One plan is generated per scene (not per beat) and cached in memory for the
 * duration of the render.
 */
import {
  analyzeBeatSemantics,
  analyzeBeatSemanticsFallback,
  type BeatSemanticProfile,
} from "./semanticVisualMatching";
import { invokeLLM } from "./_core/llm";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VisualSearchPlan = {
  /** Round 1: exact queries derived from the narration */
  primary: string[];
  /** Round 2: synonyms and variations */
  secondary: string[];
  /** Round 3: higher-abstraction concepts and visible objects */
  concepts: string[];
  /** Round 4: context from adjacent beats */
  context: string[];
  /** Round 5: era, location, period, visual style (painting, engraving, etc.) */
  historical: string[];
  /** Detected persons */
  people: string[];
  /** Detected objects */
  objects: string[];
  /** Detected locations */
  locations: string[];
  /** Detected time periods and years */
  timePeriod: string[];
  /** Visual style terms: painting, engraving, archive photo, map, document… */
  styles: string[];
  /** Round 6: metaphorical / visual-equivalent terms */
  fallback: string[];
};

export type VisualSearchPlanInput = {
  beatText: string;
  sceneText: string;
  topic: string;
  adjacentContext?: {
    prevBeat?: string;
    nextBeat?: string;
  };
};

// ─── Module-level cache (render-lifetime) ────────────────────────────────────

const _planCache = new Map<string, VisualSearchPlan>();

export function clearVisualSearchPlanCache(): void {
  _planCache.clear();
}

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function visualSearchPlanEnabled(): boolean {
  return process.env.VISUAL_SEARCH_PLAN_ENABLED !== "false";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dedup(arr: string[]): string[] {
  return Array.from(new Set(arr.filter((s) => s && s.trim().length > 1)));
}

function planFromProfile(
  profile: BeatSemanticProfile,
  input: VisualSearchPlanInput
): VisualSearchPlan {
  const e = profile.entities;

  const tier0 = dedup(profile.searchTiers[0] ?? []);
  const tier1 = dedup(profile.searchTiers[1] ?? []);
  const tier2 = dedup(profile.searchTiers[2] ?? []);
  const restTiers = dedup(profile.searchTiers.slice(3).flat());

  return {
    primary: dedup([...tier0, input.beatText.slice(0, 80)]).slice(0, 6),
    secondary: dedup([...tier1, ...e.events]).slice(0, 8),
    concepts: dedup([...tier2, ...e.objects]).slice(0, 8),
    context: dedup([
      ...(input.adjacentContext?.prevBeat ? [input.adjacentContext.prevBeat.slice(0, 60)] : []),
      ...(input.adjacentContext?.nextBeat ? [input.adjacentContext.nextBeat.slice(0, 60)] : []),
    ]).slice(0, 4),
    historical: dedup([...e.timePeriods, ...e.years, ...e.locations, ...e.companies]).slice(0, 8),
    people: dedup(e.persons).slice(0, 4),
    objects: dedup(e.objects).slice(0, 6),
    locations: dedup(e.locations).slice(0, 5),
    timePeriod: dedup([...e.timePeriods, ...e.years]).slice(0, 5),
    styles: [], // filled by enrichWithLlmStyles
    fallback: dedup(restTiers).slice(0, 8),
  };
}

/** One small LLM call to generate visual-style terms and metaphorical fallbacks. */
async function enrichWithLlmStyles(
  plan: VisualSearchPlan,
  input: VisualSearchPlanInput
): Promise<void> {
  try {
    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are a documentary visual researcher. Return ONLY valid JSON, no markdown.",
        },
        {
          role: "user",
          content: `Narration: "${input.beatText.slice(0, 200)}"\nTopic: "${input.topic}"

Return JSON with two arrays:
- "styles": visual media types to search for (e.g. "painting", "engraving", "archive photograph", "map", "document", "illustration", "museum exhibit"). Max 6.
- "fallback": metaphorical or conceptual search terms that visually represent this narration when no exact match exists (e.g. for "trade collapsed" → "empty harbor", "closed market", "merchant ship"). Max 8.

{"styles": [...], "fallback": [...]}`,
        },
      ],
      maxTokens: 250,
      responseFormat: { type: "json_object" },
    });

    const text =
      typeof result.choices[0]?.message.content === "string"
        ? result.choices[0].message.content
        : "";
    const parsed = JSON.parse(text) as { styles?: unknown; fallback?: unknown };

    if (Array.isArray(parsed.styles)) {
      plan.styles = parsed.styles
        .filter((s): s is string => typeof s === "string")
        .slice(0, 6);
    }
    if (Array.isArray(parsed.fallback)) {
      plan.fallback = dedup([
        ...plan.fallback,
        ...parsed.fallback.filter((s): s is string => typeof s === "string"),
      ]).slice(0, 10);
    }
  } catch {
    // LLM unavailable — styles stays empty, fallback keeps profile tiers
  }
}

function logPlan(label: string, plan: VisualSearchPlan): void {
  console.log(
    `[VisualSearchPlan] ${label}\n` +
      `  Primary:    ${JSON.stringify(plan.primary.slice(0, 4))}\n` +
      `  Secondary:  ${JSON.stringify(plan.secondary.slice(0, 4))}\n` +
      `  Concepts:   ${JSON.stringify(plan.concepts.slice(0, 4))}\n` +
      `  Historical: ${JSON.stringify(plan.historical.slice(0, 4))}\n` +
      `  Styles:     ${JSON.stringify(plan.styles.slice(0, 4))}\n` +
      `  Fallback:   ${JSON.stringify(plan.fallback.slice(0, 4))}`
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate (or return cached) a visual search plan for a scene.
 * Cache key is `sceneIndex` so all beats in a scene share one plan.
 */
export async function getOrGenerateSearchPlan(
  cacheKey: string,
  input: VisualSearchPlanInput
): Promise<VisualSearchPlan> {
  const cached = _planCache.get(cacheKey);
  if (cached) return cached;

  if (!visualSearchPlanEnabled()) {
    const empty: VisualSearchPlan = {
      primary: [input.beatText.slice(0, 80)],
      secondary: [],
      concepts: [],
      context: [],
      historical: [],
      people: [],
      objects: [],
      locations: [],
      timePeriod: [],
      styles: [],
      fallback: [],
    };
    _planCache.set(cacheKey, empty);
    return empty;
  }

  const profile: BeatSemanticProfile = await analyzeBeatSemantics(
    input.sceneText || input.beatText,
    input.topic
  ).catch(() => analyzeBeatSemanticsFallback(input.sceneText || input.beatText, input.topic));

  const plan = planFromProfile(profile, input);
  await enrichWithLlmStyles(plan, input);

  logPlan(`s${cacheKey} "${input.beatText.slice(0, 60)}"`, plan);

  _planCache.set(cacheKey, plan);
  return plan;
}

/**
 * Return the 6 retrieval rounds as ordered query arrays.
 * Each round is tried in order; retrieval stops at the first hit.
 */
export function searchPlanRounds(plan: VisualSearchPlan): Array<{
  label: string;
  queries: string[];
}> {
  return [
    { label: "exact", queries: plan.primary },
    { label: "synonyms", queries: [...plan.secondary, ...plan.people] },
    { label: "concepts", queries: [...plan.concepts, ...plan.objects] },
    { label: "context+historical", queries: [...plan.context, ...plan.historical] },
    { label: "period+style", queries: [...plan.locations, ...plan.timePeriod, ...plan.styles] },
    { label: "visual-equiv", queries: plan.fallback },
  ].map((r) => ({ ...r, queries: dedup(r.queries).filter((q) => q.length > 2) }));
}
