/**
 * Visual Search Plan — adaptive multi-round query strategy per beat.
 *
 * Architecture:
 *  1. VideoVisualContext — one LLM call per render (main characters, period, locations, style).
 *     All beats share this context so "He returned" resolves to the right person.
 *  2. VisualSearchPlan — per-scene plan with scored queries and LLM intent/reasoning.
 *  3. searchPlanRounds — returns rounds sorted by confidence; stops at first hit (adaptive).
 */
import {
  analyzeBeatSemantics,
  analyzeBeatSemanticsFallback,
  type BeatSemanticProfile,
} from "./semanticVisualMatching";
import { invokeLLM } from "./_core/llm";

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

export function clearVisualSearchPlanCache(): void {
  _planCache.clear();
  _videoContextCache = null;
}

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function visualSearchPlanEnabled(): boolean {
  return process.env.VISUAL_SEARCH_PLAN_ENABLED !== "false";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dedupStrings(arr: string[]): string[] {
  return Array.from(new Set(arr.filter((s) => s && s.trim().length > 1)));
}

function scored(query: string, confidence: number, reason: string): ScoredQuery {
  return { query: query.trim(), confidence, reason };
}

function dedupScored(items: ScoredQuery[]): ScoredQuery[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = item.query.toLowerCase();
    if (seen.has(k) || item.query.length < 2) return false;
    seen.add(k);
    return true;
  });
}

function sortByConfidence(items: ScoredQuery[]): ScoredQuery[] {
  return [...items].sort((a, b) => b.confidence - a.confidence);
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
  const cacheKey = videoTitle;
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

// ─── Plan builder ─────────────────────────────────────────────────────────────

function planFromProfile(
  profile: BeatSemanticProfile,
  input: VisualSearchPlanInput
): VisualSearchPlan {
  const e = profile.entities;
  const ctx = input.videoContext;

  const tier0 = dedupStrings(profile.searchTiers[0] ?? []);
  const tier1 = dedupStrings(profile.searchTiers[1] ?? []);
  const tier2 = dedupStrings(profile.searchTiers[2] ?? []);
  const restTiers = dedupStrings(profile.searchTiers.slice(3).flat());

  // Primary: highest confidence — direct match from beat text + tier0
  const primary = dedupScored([
    ...tier0.map((q) => scored(q, 0.9, "direct semantic match from narration")),
    scored(input.beatText.slice(0, 80), 0.85, "verbatim beat text"),
  ]).slice(0, 6);

  // Secondary: synonyms/variations + named persons
  const secondary = dedupScored([
    ...tier1.map((q) => scored(q, 0.75, "synonym or variation")),
    ...e.events.map((q) => scored(q, 0.7, "detected event")),
    ...(ctx?.people ?? []).map((p) => scored(p, 0.65, "main character from video context")),
  ]).slice(0, 8);

  // Concepts: abstracted from objects + tier2
  const concepts = dedupScored([
    ...tier2.map((q) => scored(q, 0.6, "conceptual abstraction")),
    ...e.objects.map((q) => scored(q, 0.55, "detected object")),
  ]).slice(0, 8);

  // Context: adjacent beats + video-level context
  const contextQueries = dedupScored([
    ...(input.adjacentContext?.prevBeat
      ? [scored(input.adjacentContext.prevBeat.slice(0, 60), 0.5, "previous beat context")]
      : []),
    ...(input.adjacentContext?.nextBeat
      ? [scored(input.adjacentContext.nextBeat.slice(0, 60), 0.45, "next beat context")]
      : []),
  ]).slice(0, 4);

  // Historical: era, period, locations, companies
  const historical = dedupScored([
    ...e.timePeriods.map((q) => scored(q, 0.5, "detected time period")),
    ...e.years.map((q) => scored(q, 0.45, "detected year")),
    ...e.locations.map((q) => scored(q, 0.5, "detected location")),
    ...e.companies.map((q) => scored(q, 0.4, "detected organisation")),
    ...(ctx?.period ? [scored(ctx.period, 0.45, "video period from context")] : []),
    ...(ctx?.locations ?? []).map((l) => scored(l, 0.4, "video location from context")),
  ]).slice(0, 8);

  return {
    intent: "", // filled by enrichWithLlm
    reasoning: "", // filled by enrichWithLlm
    primary,
    secondary,
    concepts,
    context: contextQueries,
    historical,
    fallback: restTiers.map((q) => scored(q, 0.3, "broad fallback tier")).slice(0, 8),
    people: dedupStrings(e.persons).slice(0, 4),
    objects: dedupStrings(e.objects).slice(0, 6),
    locations: dedupStrings(e.locations).slice(0, 5),
    timePeriod: dedupStrings([...e.timePeriods, ...e.years]).slice(0, 5),
    styles: [], // filled by enrichWithLlm
  };
}

/** LLM call: generates intent, reasoning, visual styles, and scored fallback queries. */
async function enrichWithLlm(
  plan: VisualSearchPlan,
  input: VisualSearchPlanInput
): Promise<void> {
  try {
    const ctxLine = input.videoContext
      ? `\nVideo context: people=${JSON.stringify(input.videoContext.people)}, period="${input.videoContext.period}", locations=${JSON.stringify(input.videoContext.locations)}`
      : "";

    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are a documentary visual researcher. Return ONLY valid JSON, no markdown.",
        },
        {
          role: "user",
          content:
            `Narration: "${input.beatText.slice(0, 200)}"\nTopic: "${input.topic}"${ctxLine}

Return JSON:
{
  "intent": "one sentence: what should the viewer see? (e.g. 'Roman emperor addressing the Senate')",
  "reasoning": "2–3 sentences explaining which search terms best represent this visually and why",
  "styles": [{"query": "painting", "confidence": 0.8, "reason": "historical era"}],  // visual media types, max 6
  "fallback": [{"query": "empty harbor", "confidence": 0.4, "reason": "visual metaphor for trade collapse"}]  // metaphorical equivalents, max 8
}`,
        },
      ],
      maxTokens: 400,
      responseFormat: { type: "json_object" },
    });

    const text =
      typeof result.choices[0]?.message.content === "string"
        ? result.choices[0].message.content
        : "";

    type LlmRow = { query?: unknown; confidence?: unknown; reason?: unknown };
    const parsed = JSON.parse(text) as {
      intent?: unknown;
      reasoning?: unknown;
      styles?: unknown;
      fallback?: unknown;
    };

    if (typeof parsed.intent === "string") plan.intent = parsed.intent;
    if (typeof parsed.reasoning === "string") plan.reasoning = parsed.reasoning;

    const parseRows = (raw: unknown, defaultReason: string): ScoredQuery[] => {
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((r): r is LlmRow => r !== null && typeof r === "object")
        .map((r) => ({
          query: typeof r.query === "string" ? r.query.trim() : "",
          confidence: typeof r.confidence === "number" ? Math.min(1, Math.max(0, r.confidence)) : 0.5,
          reason: typeof r.reason === "string" ? r.reason : defaultReason,
        }))
        .filter((r) => r.query.length > 1);
    };

    const llmStyles = parseRows(parsed.styles, "visual style");
    if (llmStyles.length) {
      plan.styles = llmStyles.map((s) => s.query).slice(0, 6);
      // Inject into historical round at high confidence
      plan.historical = sortByConfidence(
        dedupScored([
          ...plan.historical,
          ...llmStyles.map((s) => scored(s.query, s.confidence, s.reason)),
        ])
      ).slice(0, 10);
    }

    const llmFallback = parseRows(parsed.fallback, "visual metaphor");
    if (llmFallback.length) {
      plan.fallback = sortByConfidence(
        dedupScored([
          ...plan.fallback,
          ...llmFallback,
        ])
      ).slice(0, 10);
    }
  } catch {
    // LLM unavailable — intent/reasoning stay empty, styles stays empty
  }
}

function logPlan(sceneLabel: string, beatLabel: string, plan: VisualSearchPlan): void {
  const fmtRound = (items: ScoredQuery[]) =>
    items
      .slice(0, 3)
      .map((s) => `"${s.query}" (${s.confidence.toFixed(2)})`)
      .join(", ");

  console.log(
    `\n[VisualSearchPlan] ${sceneLabel} "${beatLabel}"\n` +
      `  Intent:     ${plan.intent || "(none)"}\n` +
      `  Reasoning:  ${plan.reasoning ? plan.reasoning.slice(0, 120) + (plan.reasoning.length > 120 ? "…" : "") : "(none)"}\n` +
      `  Round 1 (exact):       ${fmtRound(plan.primary)}\n` +
      `  Round 2 (synonyms):    ${fmtRound(plan.secondary)}\n` +
      `  Round 3 (concepts):    ${fmtRound(plan.concepts)}\n` +
      `  Round 4 (context):     ${fmtRound(plan.context)}\n` +
      `  Round 5 (historical):  ${fmtRound(plan.historical)}\n` +
      `  Round 6 (fallback):    ${fmtRound(plan.fallback)}`
  );
}

// ─── Main exports ─────────────────────────────────────────────────────────────

/**
 * Generate (or return cached) a visual search plan for a scene.
 * Cache key = sceneIndex so all beats in a scene share one plan.
 */
export async function getOrGenerateSearchPlan(
  cacheKey: string,
  input: VisualSearchPlanInput
): Promise<VisualSearchPlan> {
  const cached = _planCache.get(cacheKey);
  if (cached) return cached;

  if (!visualSearchPlanEnabled()) {
    const empty: VisualSearchPlan = {
      intent: input.beatText.slice(0, 80),
      reasoning: "",
      primary: [scored(input.beatText.slice(0, 80), 1, "verbatim beat text")],
      secondary: [],
      concepts: [],
      context: [],
      historical: [],
      fallback: [],
      people: [],
      objects: [],
      locations: [],
      timePeriod: [],
      styles: [],
    };
    _planCache.set(cacheKey, empty);
    return empty;
  }

  const profile: BeatSemanticProfile = await analyzeBeatSemantics(
    input.sceneText || input.beatText,
    input.topic
  ).catch(() => analyzeBeatSemanticsFallback(input.sceneText || input.beatText, input.topic));

  const plan = planFromProfile(profile, input);
  await enrichWithLlm(plan, input);

  logPlan(`s${cacheKey}`, input.beatText.slice(0, 60), plan);

  _planCache.set(cacheKey, plan);
  return plan;
}

/**
 * Return the retrieval rounds as ordered query-string arrays (sorted by confidence).
 * Caller stops at the first round that returns a hit — adaptive stopping is built
 * into the caller loop, not here.
 *
 * Queries within each round are sorted by confidence descending so the retrieval
 * engine tries the most-likely terms first.
 */
export function searchPlanRounds(plan: VisualSearchPlan): Array<{
  label: string;
  queries: string[];
  scored: ScoredQuery[];
}> {
  const rounds: Array<{ label: string; items: ScoredQuery[] }> = [
    { label: "exact", items: plan.primary },
    { label: "synonyms", items: [...plan.secondary, ...plan.people.map((p) => scored(p, 0.7, "named person"))] },
    { label: "concepts", items: [...plan.concepts, ...plan.objects.map((o) => scored(o, 0.5, "detected object"))] },
    { label: "context+historical", items: [...plan.context, ...plan.historical] },
    {
      label: "period+style",
      items: [
        ...plan.locations.map((l) => scored(l, 0.45, "detected location")),
        ...plan.timePeriod.map((t) => scored(t, 0.45, "detected time period")),
        ...plan.styles.map((s) => scored(s, 0.4, "visual style")),
      ],
    },
    { label: "visual-equiv", items: plan.fallback },
  ];

  return rounds.map(({ label, items }) => {
    const sorted = sortByConfidence(dedupScored(items)).filter((s) => s.query.length > 2);
    return { label, queries: sorted.map((s) => s.query), scored: sorted };
  });
}

/**
 * Log a retrieval round result (call after each round attempt).
 */
export function logRetrievalRound(
  sceneIndex: number,
  beatIndex: number,
  round: { label: string; queries: string[]; scored: ScoredQuery[] },
  hit: boolean,
  hitQuery?: string
): void {
  if (hit) {
    const winner = round.scored.find((s) => s.query === hitQuery) ?? round.scored[0];
    console.log(
      `[Retrieval] s${sceneIndex}b${beatIndex} Round "${round.label}" → HIT\n` +
        `  Winner:  "${hitQuery ?? round.queries[0]}"\n` +
        `  Reason:  ${winner?.reason ?? "—"}\n` +
        `  Confidence: ${winner?.confidence.toFixed(2) ?? "—"}`
    );
  } else {
    const topQ = round.queries.slice(0, 3).join(", ");
    console.log(
      `[Retrieval] s${sceneIndex}b${beatIndex} Round "${round.label}" → miss  (tried: ${topQ})`
    );
  }
}
