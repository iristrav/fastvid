/** Visual Matching Engine V2 — Ranked Query Generation (Phase 3, Visual Intelligence Engine).
 *
 * Hybrid pipeline, per the Phase 3 amendment — the LLM expands the deterministic list, it
 * never replaces it:
 *
 *   1. Entities were already extracted deterministically (visualIntentExtractor.ts).
 *   2. generateDeterministicQueries() combines those entities into template-based queries —
 *      no LLM call, since every entity was already extracted; templating costs nothing extra.
 *   3. generateLlmQueryExpansions() asks the LLM for additional queries a human documentary
 *      editor would search for: aliases/alternative names, related concepts, period-accurate
 *      historical terminology, and phrases specific to this beat's context. Cached per beat
 *      (by intentHash) so an identical beat never re-triggers the LLM call twice, and never
 *      throws — a cache-miss LLM failure degrades to "no expansion this beat", not a crash;
 *      the deterministic list alone is always a complete, valid result on its own.
 *   4-6. mergeDedupeAndRank() merges both lists, removes duplicate query strings, and ranks
 *      the union by score (stable sort — ties keep their generator's priority order), capped
 *      at 30.
 *
 * Optionally folds in editorialSequencePlanner.ts's ShotDescription for this beat, when the
 * legacy pipeline's storyboard has already planned one — its searchQuery/alternatives are
 * shot-type-aware (already live in production) and worth reusing rather than re-deriving shot
 * phrasing here.
 */
import { invokeLLM } from "../_core/llm";
import { createVisualQueryExpansionCache, getVisualQueryExpansionCacheByIntentHash } from "../db";
import { parseJson } from "./llmJson";
import { logQueryGeneration } from "./logging";
import type { RankedQuery, RankedQuerySource, VideoContext, VisualIntent } from "./types";
import type { ShotDescription } from "../editorialSequencePlanner";

const PERSON_FORMAT_NOUNS = [
  "keynote",
  "interview",
  "speech",
  "conference",
  "stage",
  "speaking",
  "press conference",
  "event",
  "panel",
];

function clean(s: string | undefined | null): string {
  return (s ?? "").trim();
}

function pushUnique(seen: Set<string>, out: RankedQuery[], query: string, rank: number, score: number, source: RankedQuerySource): boolean {
  const q = clean(query);
  if (!q) return false;
  const key = q.toLowerCase();
  if (seen.has(key)) return false;
  seen.add(key);
  out.push({ query: q, rank, score, source });
  return true;
}

/**
 * Step 2 of the hybrid pipeline: deterministic, template-based queries from the beat's
 * already-extracted entities. No LLM call. Output size naturally varies with how many
 * distinct entities a beat actually has — a sparse beat (only a subject and an action) won't
 * be padded with near-duplicate queries just to hit a floor.
 */
export function generateDeterministicQueries(intent: VisualIntent, shot?: ShotDescription | null): RankedQuery[] {
  const out: RankedQuery[] = [];
  const seen = new Set<string>();
  let rank = 1;
  const next = (query: string, score: number, source: RankedQuerySource) => {
    if (pushUnique(seen, out, query, rank, score, source)) rank += 1;
  };

  const subject = clean(intent.visualSubject);
  const primaryPerson = intent.people[0] ? clean(intent.people[0]) : subject;

  // ─── Tier: shot-plan-aware queries, already shot-type-aware and pre-built for retrieval by
  // the live editorialSequencePlanner.ts — highest confidence, reuse verbatim. ──────────────
  if (shot?.searchQuery) next(shot.searchQuery, 1, "shot_plan");
  for (const alt of shot?.alternatives ?? []) next(alt, 0.95, "shot_plan");

  // ─── Tier: named person + format noun (the exact "Elon Musk keynote" / "Elon Musk
  // interview" pattern from the spec example) — highest-confidence entity combination when a
  // real person's name is known. ──────────────────────────────────────────────────────────
  if (primaryPerson) {
    for (const noun of PERSON_FORMAT_NOUNS) {
      next(`${primaryPerson} ${noun}`, 0.9, "person_format");
    }
    for (const company of intent.companies) {
      next(`${primaryPerson} ${company}`, 0.85, "person_format");
    }
    for (const brand of intent.brands) {
      next(`${primaryPerson} ${brand}`, 0.85, "person_format");
    }
  }

  // ─── Tier: company/brand + event/action — strong when a named organization is involved
  // even without a specific person (e.g. a product launch beat). ─────────────────────────
  for (const company of intent.companies) {
    if (intent.events[0]) next(`${company} ${intent.events[0]}`, 0.8, "company_event");
    next(`${company} event`, 0.7, "company_event");
    next(`${company} announcement`, 0.65, "company_event");
    if (intent.visualAction) next(`${company} ${intent.visualAction}`, 0.75, "company_event");
  }
  for (const brand of intent.brands) {
    next(`${brand} product launch`, 0.6, "brand");
    next(`${brand} presentation`, 0.55, "brand");
  }

  // ─── Tier: subject + action / location / object — the general-purpose combinations that
  // work regardless of whether named entities were found. ───────────────────────────────
  if (subject && intent.visualAction) next(`${subject} ${intent.visualAction}`, 0.6, "subject_action");
  if (subject && intent.visualLocation) next(`${subject} ${intent.visualLocation}`, 0.55, "subject_location");
  for (const obj of intent.objects) {
    if (subject) next(`${subject} ${obj}`, 0.5, "subject_object");
    next(obj, 0.3, "subject_object");
  }
  for (const secondary of intent.secondaryVisualSubjects) {
    if (subject) next(`${subject} ${secondary}`, 0.45, "subject_action");
  }

  // ─── Tier: era/country context — useful for disambiguating footage of the right
  // period/place when the subject alone is ambiguous. ────────────────────────────────────
  for (const country of intent.countries) {
    if (subject) next(`${subject} ${country}`, 0.4, "era_country");
    if (intent.visualTime) next(`${country} ${intent.visualTime}`, 0.35, "era_country");
  }

  // ─── Tier: the original primary/secondary keywords — kept as the lowest-priority fallback
  // for full backwards compatibility with callers that only used these two before. ────────
  next(intent.primaryKeyword, 0.5, "primary_keyword");
  next(intent.secondaryKeyword, 0.4, "secondary_keyword");
  if (subject) next(subject, 0.3, "primary_keyword");

  return out;
}

// ─── Step 3: LLM query expansion ───────────────────────────────────────────────

const LLM_CATEGORY_TO_SOURCE: Record<string, RankedQuerySource> = {
  alias: "llm_alias",
  related_concept: "llm_related_concept",
  historical_term: "llm_historical_term",
  context_phrase: "llm_context_phrase",
};

const LLM_CATEGORY_SCORE: Record<string, number> = {
  historical_term: 0.8,
  context_phrase: 0.75,
  alias: 0.7,
  related_concept: 0.6,
};

const QUERY_EXPANSION_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "query_expansion",
    strict: true,
    schema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              query: { type: "string" },
              category: {
                type: "string",
                enum: ["alias", "related_concept", "historical_term", "context_phrase"],
              },
            },
            required: ["query", "category"],
            additionalProperties: false,
          },
        },
      },
      required: ["queries"],
      additionalProperties: false,
    },
  },
};

type CachedExpansionEntry = { query: string; category: string };

function toRankedQueries(entries: CachedExpansionEntry[]): RankedQuery[] {
  const seen = new Set<string>();
  const out: RankedQuery[] = [];
  for (const entry of entries) {
    const q = clean(entry.query);
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const source = LLM_CATEGORY_TO_SOURCE[entry.category] ?? "llm_related_concept";
    const score = LLM_CATEGORY_SCORE[entry.category] ?? 0.6;
    // rank is a placeholder — mergeDedupeAndRank() assigns the real, final rank.
    out.push({ query: q, rank: out.length + 1, score, source });
  }
  return out;
}

/**
 * Step 3 of the hybrid pipeline: asks the LLM for search queries a human documentary editor
 * would actually type for this beat — aliases/alternative names, related concepts,
 * period-accurate historical terminology, and phrases specific to this beat's context —
 * beyond what the deterministic entity-combination templates produce. Cached per beat
 * (intentHash) so re-analyzing the same beat never re-triggers the LLM call. Never throws:
 * any failure (missing API key, budget cap, network error, malformed response) degrades to an
 * empty expansion — the deterministic list is always a complete result on its own, per the
 * "the LLM should not replace deterministic generation" requirement.
 */
export async function generateLlmQueryExpansions(
  intent: VisualIntent,
  videoContext?: VideoContext | null
): Promise<RankedQuery[]> {
  try {
    const cached = await getVisualQueryExpansionCacheByIntentHash(intent.intentHash);
    if (cached) {
      logQueryGeneration("llm_cache_hit", { beatId: intent.beatId, intentHash: intent.intentHash });
      return toRankedQueries(cached.queriesJson as CachedExpansionEntry[]);
    }
  } catch (err) {
    logQueryGeneration("error", { beatId: intent.beatId, stage: "cache_read", error: (err as Error).message });
  }

  logQueryGeneration("llm_cache_miss", { beatId: intent.beatId, intentHash: intent.intentHash });

  try {
    const entityLines = [
      intent.people.length > 0 ? `people: ${intent.people.join(", ")}` : "",
      intent.companies.length > 0 ? `companies: ${intent.companies.join(", ")}` : "",
      intent.brands.length > 0 ? `brands: ${intent.brands.join(", ")}` : "",
      intent.objects.length > 0 ? `objects: ${intent.objects.join(", ")}` : "",
      intent.countries.length > 0 ? `countries: ${intent.countries.join(", ")}` : "",
      intent.events.length > 0 ? `events: ${intent.events.join(", ")}` : "",
    ].filter(Boolean).join("; ");

    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are a documentary footage researcher. Given one beat (a shot's subject, action, " +
            "location, time period and entities), generate 8-15 ADDITIONAL stock/archive footage " +
            "search queries beyond the obvious entity combinations — the kind of queries a human " +
            "documentary editor would actually type into a footage search box. Cover: " +
            "aliases and alternative names/wording for the subject or entities (category: alias); " +
            "conceptually related search terms that would surface relevant footage even without " +
            "naming the exact entity (category: related_concept); when the beat is historical, " +
            "period-accurate terminology a researcher of that era would use, not modern wording " +
            "(category: historical_term); and phrases specific to this beat's exact context — the " +
            "kind of shot, event type, or moment being described (category: context_phrase). " +
            "Every query must be a short, natural footage-search phrase (2-6 words), never a full " +
            "sentence. Do not just restate the primary/secondary keywords verbatim.",
        },
        {
          role: "user",
          content:
            `Beat: ${intent.spokenText}\n` +
            `Visual: ${intent.visualDescription}\n` +
            `Subject: ${intent.visualSubject}; Action: ${intent.visualAction}; ` +
            `Location: ${intent.visualLocation}; Time: ${intent.visualTime}\n` +
            `Historical context: ${intent.historicalContext || "none"}\n` +
            (entityLines ? `Entities: ${entityLines}\n` : "") +
            (videoContext ? `Video era/setting: ${videoContext.era} / ${videoContext.setting}\n` : ""),
        },
      ],
      preferProvider: "groq",
      response_format: QUERY_EXPANSION_SCHEMA,
      maxTokens: 800,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("empty LLM response");
    const parsed = parseJson<{ queries: CachedExpansionEntry[] }>(content, "QueryExpansion JSON");
    const entries = (parsed.queries ?? []).filter((e) => clean(e.query) && LLM_CATEGORY_TO_SOURCE[e.category]);

    try {
      await createVisualQueryExpansionCache({ intentHash: intent.intentHash, queriesJson: entries });
    } catch (err) {
      logQueryGeneration("error", { beatId: intent.beatId, stage: "cache_write", error: (err as Error).message });
    }

    logQueryGeneration("llm_expanded", { beatId: intent.beatId, count: entries.length });
    return toRankedQueries(entries);
  } catch (err) {
    logQueryGeneration("error", { beatId: intent.beatId, stage: "llm_call", error: (err as Error).message });
    return [];
  }
}

// ─── Steps 4-6: merge, dedupe, rank ─────────────────────────────────────────────

/**
 * Merges any number of RankedQuery lists (generator priority order matters as a tiebreaker),
 * removes duplicate query strings (case-insensitive, first occurrence wins), sorts the union
 * by score (stable — ties keep their original relative order), and assigns final 1-based
 * ranks, capped at 30.
 */
export function mergeDedupeAndRank(lists: RankedQuery[][]): RankedQuery[] {
  const seen = new Set<string>();
  const merged: RankedQuery[] = [];
  for (const list of lists) {
    for (const q of list) {
      const key = q.query.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(q);
    }
  }
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, 30).map((q, i) => ({ ...q, rank: i + 1 }));
}

/**
 * Generates a ranked list of search queries for one beat, highest-priority first — the full
 * hybrid pipeline (deterministic + LLM expansion, merged/deduped/ranked). Callers that only
 * want the top few can slice the result; every entry already carries its own score/source for
 * explainability (e.g. "why did we search for this").
 */
export async function generateRankedSearchQueries(
  intent: VisualIntent,
  shot?: ShotDescription | null,
  videoContext?: VideoContext | null
): Promise<RankedQuery[]> {
  const deterministic = generateDeterministicQueries(intent, shot);
  const llmExpansions = await generateLlmQueryExpansions(intent, videoContext);
  return mergeDedupeAndRank([deterministic, llmExpansions]);
}
