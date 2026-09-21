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
import {
  contentTermsFromText,
  narrowToSubjectPlusConcept,
  termProvableFrom,
  visualTermsFromIntent,
} from "./searchQueryContract";
import { foldSearchText } from "./searchTextNormalize";
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

export function clearVisualSearchPlanCache(): void {
  _planCache.clear();
  _videoContextCache = null;
}

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

/**
 * RONDE 213 — how many of the narration's own words become a query.
 *
 * Four is this codebase's existing answer to the same question, not a new number: both
 * `curatedMediaSourcing` and `vidrushQuality` already take `extractSalientBeatTokens(...).slice(0, 4)`
 * when they turn a spoken sentence into search terms. A neighbouring beat is weaker evidence about
 * THIS shot, so it contributes fewer.
 */
const BEAT_QUERY_TERMS = 4;
const ADJACENT_QUERY_TERMS = 3;

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

// ─── The subject anchor ───────────────────────────────────────────────────────

/**
 * A CATEGORY IS NOT A SEARCH. IT IS A CATEGORY *OF* SOMETHING.
 *
 * ── What render 593 sent ────────────────────────────────────────────────────────────────────
 *
 * `BeatSemanticProfile.searchTiers` is `string[][]` — each inner array is one PRIORITY TIER,
 * assembled per entity category by `analyzeBeatSemanticsFallback` (persons, then companies, then
 * objects, then locations, then events, …) or written whole by the model. A tier is a group of
 * terms that belong to the same rung of specificity. It was never a list of finished queries.
 *
 * `planFromProfile` read it as one. `tier0.map((q) => scored(q, 0.9, …))` turns every TERM in the
 * tier into its own standalone query, so
 *
 *     ["news", "kim kardashian", "medium"]
 *
 * reached the providers as three separate searches: `news`, `kim kardashian`, `medium`. Two of
 * those three name a category and no subject. There is no degradation step to blame — the subject
 * was never in that query, because the query was one word of a list.
 *
 * ── What this function does ─────────────────────────────────────────────────────────────────
 *
 * Puts the subject back in front, and only there. `ensureSubjectAnchor("news", "Kim Kardashian")`
 * is `"Kim Kardashian news"`; `ensureSubjectAnchor("Kim Kardashian 2018", "Kim Kardashian")` is
 * unchanged, because the query already says who it is about.
 *
 * Three properties it is built to hold, each with its own test:
 *
 *   · NEVER TWICE. A query that already names the anchor — in any casing, with any diacritics, at
 *     any position — is returned exactly as it arrived. "Kim Kardashian Kim Kardashian 2018" is
 *     not a better query, and `buildPrioritisedQueries` refuses the same shape for the same reason
 *     ("a query that says the same word twice is not a better query").
 *   · NEVER A SUBSET TWICE EITHER. A query whose words are all inside the anchor — `"kim"` under
 *     the anchor "Kim Kardashian" — collapses to the anchor rather than becoming "Kim Kardashian
 *     kim". The comparison is word-level and folded, so it survives case and punctuation.
 *   · NEVER AN INVENTED ANCHOR. An empty anchor returns the query untouched (§6). The anchor is
 *     chosen by `subjectAnchorForBeat` and has to pass the gate's own evidence measure first.
 *
 * ── Why this cannot loosen the Search Gate ──────────────────────────────────────────────────
 *
 * It adds words; it removes none. `validateSearchQuery` still judges every query afterwards, and
 * every word this puts into one comes from an anchor the beat itself proves — so a composed query
 * carries exactly the claims its two halves carried separately. The one thing that does change is
 * `hasContentAnchor`: `"documentary archive"` has no subject and is refused, while
 * `"Kim Kardashian documentary archive"` has one and is not. That is §7's whole point, and it is
 * the gate answering correctly about a different query, not the gate being relaxed.
 */
export function ensureSubjectAnchor(query: string, anchor: string): string {
  const q = (query ?? "").replace(/\s+/g, " ").trim();
  const a = (anchor ?? "").replace(/\s+/g, " ").trim();
  if (!q) return "";
  /** §6 — no reliable subject, no anchor. A hallucinated one would be worse than none. */
  if (!a) return q;
  if (queryAlreadyNamesAnchor(q, a)) return q;
  const anchorWords = new Set(a.split(/\s+/).map(anchorWordKey).filter(Boolean));
  const rest = q.split(/\s+/).filter((w) => {
    const key = anchorWordKey(w);
    return key ? !anchorWords.has(key) : false;
  });
  return rest.length ? `${a} ${rest.join(" ")}` : a;
}

/**
 * One word, compared the way the rest of this codebase compares words: folded, unpunctuated.
 *
 * The possessive is stripped because a narration writes "Kim Kardashian's 2018" and means the same
 * person. Leaving it on produced "Kim Kardashian Kardashian's 2018" — precisely the doubling this
 * function exists to prevent, arriving through an apostrophe. Only the trailing possessive goes;
 * "O'Neill" and "Kylie's" as a word in its own right keep everything before it.
 */
function anchorWordKey(word: string): string {
  return foldSearchText(word)
    .replace(/[^\p{L}\p{N}'’-]/gu, "")
    .replace(/['’]s$/u, "")
    .replace(/['’]$/u, "");
}

/** Does the query already say the anchor, as a contiguous run of its own words? */
function queryAlreadyNamesAnchor(query: string, anchor: string): boolean {
  const q = query.split(/\s+/).map(anchorWordKey).filter(Boolean);
  const a = anchor.split(/\s+/).map(anchorWordKey).filter(Boolean);
  if (a.length === 0) return true;
  for (let i = 0; i + a.length <= q.length; i++) {
    if (a.every((w, j) => q[i + j] === w)) return true;
  }
  return false;
}

/**
 * THE SUBJECT THIS BEAT PROVES — or nothing.
 *
 * The order is the codebase's own order of authority, the same one `visualTermsFromIntent` uses:
 * the planner's stated subject, then the people it typed, then the persons and organisations the
 * semantic profile extracted. Every candidate is put through `termProvableFrom` against the beat's
 * own text plus its scene — the gate's own measure — so an anchor is only ever a thing the script
 * actually says. A model that invents a person cannot become the anchor of twenty queries.
 *
 * ── What is deliberately NOT a candidate ────────────────────────────────────────────────────
 *
 *   `videoContext.people` / `videoContext.period` / `videoContext.locations`
 *       Derived by an LLM from the video TITLE. RONDE 90 refused the title as evidence and this
 *       round does not re-open it: a title-derived name prefixed onto every query of every beat is
 *       precisely the contamination that rule exists to stop.
 *
 *   locations, objects, events, years
 *       These answer "where / what / when", not "who or what is this about". An anchor is the
 *       SUBJECT; a beat whose only proven noun is a place has no subject, and §6 says the honest
 *       answer then is no anchor rather than a plausible one.
 */
export function subjectAnchorForBeat(
  profile: Pick<BeatSemanticProfile, "entities">,
  input: VisualSearchPlanInput
): string {
  const evidence = `${input.beatText ?? ""} ${input.sceneText ?? ""}`;
  const candidates = [
    input.intent?.subject ?? "",
    ...(input.intent?.people ?? []),
    ...profile.entities.persons,
    ...profile.entities.companies,
  ];
  for (const raw of candidates) {
    const term = (raw ?? "").replace(/\s+/g, " ").trim();
    if (!term) continue;
    /** The gate's own evidence measure, so this can only ever name a word the beat states. */
    if (!termProvableFrom(term, evidence)) continue;
    return term;
  }
  return "";
}

/**
 * Apply the invariant to one band's worth of tier-derived queries.
 *
 * The reason string records that it happened, because a plan log that shows "Kim Kardashian news"
 * without saying where the first two words came from is a log that hides a rewrite.
 */
function anchorTierQueries(items: ScoredQuery[], anchor: string): ScoredQuery[] {
  if (!anchor) return items;
  return items.map((item) => {
    const anchored = ensureSubjectAnchor(item.query, anchor);
    if (anchored === item.query) return item;
    return { ...item, query: anchored, reason: `${item.reason} (subject-anchored)` };
  });
}

/**
 * NARROW EVERY BAND TO TWO CONCEPTS, IN THE ONE PLACE THAT RUNS BEFORE ANY PROVIDER ADAPTER.
 *
 * ── Why here and not in each adapter ────────────────────────────────────────────────────────
 *
 * Render 593's queries did not come from one builder. `"masterclass other"` came out of the
 * SerpAPI/Openverse fallback, `"sword tuned"` out of the YouTube query builder, `"Rumors
 * kardashians Kardashians"` out of a tier read as a sentence. Narrowing each adapter separately
 * would be five copies of one rule, and §13 names the outcome: the rule drifts and the long
 * queries come back through whichever copy was forgotten.
 *
 * `buildVisualSearchPlan` is the last point where a query is still a semantic object rather than
 * a provider's parameter. Everything downstream — `searchPlanRounds`, the tier fetchers, the
 * YouTube turn — reads the bands this function returns. So the policy is applied once, to the
 * plan, and the adapters below are left to do formatting and nothing else.
 *
 * ── The anchor is passed, not re-derived ────────────────────────────────────────────────────
 *
 * `narrowToSubjectPlusConcept` needs to know which words are the subject so it can keep them
 * whole and count them as one concept. Re-deriving the anchor inside it would be a second
 * `subjectAnchorForBeat` with its own opinion; passing the one this plan already chose is what
 * keeps the two from disagreeing.
 *
 * A band with no anchor is not narrowed at all — see the §6 note inside the function, which is
 * where that decision is made and why.
 */
/**
 * A LATER ROUND MAY NOT RE-ASK WHAT AN EARLIER ONE ALREADY ASKED.
 *
 * Narrowing makes this necessary. A tier term that is a category — `celebrity`, `documentary
 * archive` — collapses onto the subject, and three bands that each held one now each hold the same
 * bare `kim kardashian`. The rounds are consumed in order and stop at the first hit, so a later
 * round only runs when the earlier ones found NOTHING: re-sending a query that has already come
 * back empty spends a retrieval round to learn what the render was told a minute ago.
 *
 * Only exact repeats go. A band that narrowed to something new keeps it, and `primary` is never
 * filtered against anything — it is the first question asked.
 */
function withoutQueriesAlreadyAsked(items: ScoredQuery[], earlier: ScoredQuery[]): ScoredQuery[] {
  const asked = new Set(earlier.map((q) => q.query.trim().toLowerCase()));
  return items.filter((q) => !asked.has(q.query.trim().toLowerCase()));
}

function narrowBand(
  items: ScoredQuery[],
  anchor: string,
  intent: VisualSearchPlanInput["intent"],
  /** The beat's own words, so a category that this beat never said cannot become its concept. */
  sourceText: string
): ScoredQuery[] {
  /**
   * §6 — A BEAT WITH NO PROVEN SUBJECT IS LEFT EXACTLY AS IT WAS.
   *
   * The shape this round enforces is `[MAIN SUBJECT] + [SENTENCE VISUAL CONCEPT]`, and without a
   * subject there is no such shape to enforce: what is left is a set of terms the extractors could
   * not attribute to anybody, and choosing two of them is a guess rather than a narrowing.
   *
   * Found by `aCategoryIsNotASearch`, which asserts that not one query changes when there is no
   * anchor. It changed. The unanchored beat "It filled the news that year." lost `news` as a
   * padding word and was given `filled` in its place — a verb, standing in for the picture,
   * which is `sword tuned` and `shaped` from render 593 arriving through this round's own door.
   * Narrowing coverage for the beats this round does not help was never part of it.
   *
   * `narrowToSubjectPlusConcept` keeps its unanchored branch — §12's "Berlin 1945" is two
   * concepts and not a subject plus a concept, and the function still answers that correctly for
   * any caller that has reason to ask. This is the PLAN deciding where the policy applies.
   */
  if (!anchor.trim()) return items;

  const out: ScoredQuery[] = [];
  for (const item of items) {
    const narrowed = narrowToSubjectPlusConcept(item.query, anchor, intent, sourceText);
    if (!narrowed.query) continue;
    out.push(
      narrowed.query === item.query
        ? item
        : { ...item, query: narrowed.query, reason: `${item.reason} (2-concept: ${narrowed.reason})` }
    );
  }
  return out;
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

// ─── Plan builder ─────────────────────────────────────────────────────────────

/**
 * Turn one beat's semantic profile into its six rounds of queries.
 *
 * Exported so the invariant below can be tested through the real builder rather than through a
 * re-implementation of it — the helper alone passing proves nothing about what reaches a provider.
 * The LLM enrichment and the cache stay in `getOrGenerateSearchPlan`, which is what makes this
 * callable from a test without a network.
 */
export function buildVisualSearchPlan(
  profile: BeatSemanticProfile,
  input: VisualSearchPlanInput,
  anchorIn?: string
): VisualSearchPlan {
  const e = profile.entities;
  const ctx = input.videoContext;
  /**
   * THE SUBJECT EVERY TIER-DERIVED QUERY IS ABOUT — see `ensureSubjectAnchor` for what went out
   * without it. Empty when the beat proves no subject, and then nothing below changes at all.
   */
  const anchor = anchorIn ?? subjectAnchorForBeat(profile, input);

  const tier0 = dedupStrings(profile.searchTiers[0] ?? []);
  const tier1 = dedupStrings(profile.searchTiers[1] ?? []);
  const tier2 = dedupStrings(profile.searchTiers[2] ?? []);
  const restTiers = dedupStrings(profile.searchTiers.slice(3).flat());

  /**
   * Primary: highest confidence — direct match from beat text + tier0.
   *
   * RONDE 213: the second entry used to be `input.beatText.slice(0, 80)` — the narration itself,
   * cut mid-word, at confidence 0.85, which put a whole English sentence at the front of the round
   * every provider is asked first. It is now the sentence's own content words, in the sentence's
   * own order, capped at four. `contentTermsFromText` returns "" for a sentence that names no
   * subject, and an empty query is dropped rather than replaced by the raw text.
   */
  const beatTerms = beatQueryTerms(input);
  /**
   * RENDER 580 — AND THE SINGLE-WORD QUERIES, WHICH ARE WHERE "illuminate" ACTUALLY CAME FROM.
   *
   *     scene=2 beat=0 query="illuminate" terms=["Kylie Jenner"] reason=OK
   *
   * That is one WORD, not a term list, so it did not come from `contentTermsFromText` — it came
   * from `profile.searchTiers[0]`, which this function sends as its own query at confidence 0.9,
   * ahead of everything else. Fixing only the joined term list would have left the measured symptom
   * in place, which is the whole reason this round reconstructs before it repairs.
   *
   * `dropActionOnlyQueries` removes a query whose every content word is one of THIS beat's typed
   * actions. A verb still rides along behind a subject — "Kylie Jenner illuminate amplify" keeps
   * its anchor and is untouched — and a verb alone no longer goes to a provider that can only
   * answer it wrongly. See this module's own note: "a verb rarely narrows a search and often
   * widens it".
   */
  /**
   * The order is the one §4 mandates, and each step has to be where it is:
   *
   *     validity (drop the action-only queries)  →  subject anchor  →  deduplicate  →  cap
   *
   * · `dropActionOnlyQueries` FIRST, because anchoring would otherwise rescue exactly what it
   *   exists to refuse: "illuminate" is not allowed to become a legitimate search by acquiring a
   *   subject it never had. Render 580's defect and this round's fix must not cancel out.
   * · `dedupScored` AFTER the anchor, because anchoring MERGES queries. Under the anchor "Kim
   *   Kardashian" the tier terms "kim" and "kardashian" both collapse onto it, and a dedup that
   *   ran first would leave the duplicate standing.
   *
   * `dedupScored` keeps the first of each query, and the list is already in tier order, so the
   * cap still takes the strongest.
   */
  const primary = dedupScored(
    narrowBand(
      anchorTierQueries(
        dropActionOnlyQueries(
          [
            ...tier0.map((q) => scored(q, 0.9, "direct semantic match from narration")),
            ...(beatTerms ? [scored(beatTerms, 0.85, "content terms from narration")] : []),
          ],
          input.intent
        ),
        anchor
      ),
      anchor,
      input.intent,
      input.beatText
    )
  ).slice(0, 6);

  /**
   * Secondary: synonyms/variations + named persons.
   *
   * Only the TIER half is anchored. `videoContext.people` is a SECOND person, and "Kim Kardashian
   * Kanye West" asserts a meeting the beat may never have described — `buildPrioritisedQueries`
   * refuses to join two people for exactly that reason ("a caller-supplied context person is a
   * different claim … must ask about each SEPARATELY"). `e.events` names a happening the beat
   * states, which is a subject in its own right and already a standalone question in the contract's
   * own ladder.
   */
  const secondary = withoutQueriesAlreadyAsked(
    dedupScored([
      ...narrowBand(
        anchorTierQueries(tier1.map((q) => scored(q, 0.75, "synonym or variation")), anchor),
        anchor,
        input.intent,
        input.beatText
      ),
      ...e.events.map((q) => scored(q, 0.7, "detected event")),
      ...(ctx?.people ?? []).map((p) => scored(p, 0.65, "main character from video context")),
    ]),
    primary
  ).slice(0, 8);

  // Concepts: abstracted from objects + tier2
  const concepts = withoutQueriesAlreadyAsked(
    dedupScored([
      ...narrowBand(
        anchorTierQueries(tier2.map((q) => scored(q, 0.6, "conceptual abstraction")), anchor),
        anchor,
        input.intent,
        input.beatText
      ),
      ...e.objects.map((q) => scored(q, 0.55, "detected object")),
    ]),
    [...primary, ...secondary]
  ).slice(0, 8);

  /**
   * Context: adjacent beats + video-level context.
   *
   * RONDE 213: the same two sentence fragments, cut at 60 characters instead of 80. A neighbouring
   * beat is weaker evidence than this one, so it gets fewer terms — but it is reduced the same way,
   * because a truncated sentence is no better a query at confidence 0.5 than at 0.85.
   */
  const adjacentTerms = (text: string | undefined): string =>
    text ? contentTermsFromText(text, ADJACENT_QUERY_TERMS) : "";
  const prevTerms = adjacentTerms(input.adjacentContext?.prevBeat);
  const nextTerms = adjacentTerms(input.adjacentContext?.nextBeat);
  const contextQueries = dedupScored([
    ...(prevTerms ? [scored(prevTerms, 0.5, "previous beat context")] : []),
    ...(nextTerms ? [scored(nextTerms, 0.45, "next beat context")] : []),
  ]).slice(0, 4);

  /**
   * Historical: era, period, locations, companies — AND DELIBERATELY NOT ANCHORED. §5 C.
   *
   * This round is the one place the plan asks a geographic and chronological question on its own,
   * and the answer to §5's "onderzoek eerst hoe locations worden gebruikt" is that it has to stay
   * that way. Three findings, all from the code as it stands:
   *
   *   1. It is not built from `searchTiers` at all. Every other band here maps a tier; this one
   *      maps the TYPED entity lists. The defect this round repairs — a tier read as if it were a
   *      list of finished queries — does not exist on this path.
   *   2. `searchQueryContract` already decided the same question the other way and wrote down why:
   *      "Deliberately NO bare-place query: 'Berlin' on its own returns anything ever shot in
   *      Berlin. The archival-footage variant at the end covers the place-only case." It emits
   *      place+year, place+event and place+period as questions in their own right. A place asked
   *      WITH its era is how era-correct establishing footage is found, and that is this round's
   *      job in the ladder — `searchPlanRounds` consumes it as "context+historical" and
   *      "period+style", behind every subject round.
   *   3. Two of its six sources — `ctx.period` and `ctx.locations` — come from `videoContext`,
   *      which an LLM derived from the video TITLE. Prefixing a beat-proven person onto a
   *      title-derived place would manufacture a claim neither the beat nor the title makes:
   *      "Kim Kardashian Paris" says she was in Paris. §5 C names that risk by name, and it is the
   *      contamination RONDE 90 refused the title as evidence to prevent.
   *
   * So a location stays a standalone geographic question, and it stays BEHIND the anchored rounds.
   */
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
    /**
     * §7 — THE DOMAIN FALLBACK STOPS GOING OUT UNGROUNDED.
     *
     * `domainFallbackTiers` appends `["documentary archive", "historical footage"]` to the end of
     * every general-topic profile, and `restTiers` is `searchTiers.slice(3).flat()`, so those two
     * phrases were the last two queries of most beats in the render — as themselves, naming
     * nothing. `hasContentAnchor` refuses both (every word is production vocabulary), so they were
     * built, gated and thrown away once per beat per provider.
     *
     * Behind a proven subject they become "Kim Kardashian documentary archive" — a question an
     * archive can answer. Where there is no proven subject they are left exactly as they were and
     * the gate refuses them exactly as it did.
     *
     * `dedupScored` is new here and is required by the anchoring, not by taste: two fallback terms
     * that differ only inside the anchor collapse onto one query.
     */
    fallback: dedupScored(
      anchorTierQueries(restTiers.map((q) => scored(q, 0.3, "broad fallback tier")), anchor)
    ).slice(0, 8),
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
  "styles": [{"query": "painting", "confidence": 0.8, "reason": "historical era"}]  // visual media types, max 6
}

RONDE 88: do NOT invent subjects. Every term you return must be a MEDIA TYPE or
VISUAL STYLE (painting, engraving, newsreel, black and white photograph). Never a
place, person, event or object that is not already in the narration above.`,
        },
      ],
      preferProvider: "groq",
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

function logPlan(
  sceneLabel: string,
  beatLabel: string,
  plan: VisualSearchPlan,
  anchor: string
): void {
  const fmtRound = (items: ScoredQuery[]) =>
    items
      .slice(0, 3)
      .map((s) => `"${s.query}" (${s.confidence.toFixed(2)})`)
      .join(", ");

  console.log(
    `\n[VisualSearchPlan] ${sceneLabel} "${beatLabel}"\n` +
      /** §6 — a beat with no proven subject says so, rather than quietly searching for categories. */
      `  Anchor:     ${anchor || "(none — tier queries left unanchored)"}\n` +
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
/**
 * The beat's own query terms: what it is ABOUT when the extractors typed something, and the
 * sentence's reading order only when they did not.
 *
 * One function so the plan route and the planless route cannot drift apart — render 580's
 * `query="illuminate"` came from the plan route, and the planless branch builds the SAME query in
 * the same way, so fixing one and not the other would leave the defect reachable with a flag.
 *
 * `contentTermsFromText` stays for a beat whose extractors typed nothing. That beat is no worse
 * off than it is today; a beat that HAS a subject now asks about the subject.
 */
/**
 * Remove queries that ask only for a doing, WHEN THE BEAT HAS SOMETHING BETTER TO ASK ABOUT.
 *
 * ── Narrow on three counts, each for a reason ───────────────────────────────────────────────
 *
 *   · A query is dropped only when EVERY one of its content words is a term this beat's own
 *     extractors typed as an `action`. A verb the intent never typed is left alone: this round
 *     repairs the term source, it does not start judging vocabulary it has no evidence about.
 *
 *   · A query with any other content word in it keeps its anchor and is untouched, so
 *     "Kylie Jenner illuminate amplify" survives while "illuminate" alone does not.
 *
 *   · NOTHING IS DROPPED WHEN THE ACTIONS ARE ALL THE BEAT TYPED. An earlier round decided that
 *     deliberately and pinned it — `visualTermsFromIntent({action:["cremation"]})` must still
 *     answer "cremation" — and it is right: "cremation" names an event a camera can be pointed
 *     at, and a beat with nothing else is better served by it than by nothing. What render 580
 *     proved is narrower: an action must not be asked about INSTEAD OF a subject that exists.
 */
function dropActionOnlyQueries(
  queries: ScoredQuery[],
  intent: VisualSearchPlanInput["intent"]
): ScoredQuery[] {
  const actions = new Set(
    (intent?.action ?? []).map((a) => foldSearchText(a)).filter(Boolean)
  );
  if (actions.size === 0) return queries;
  /** Something better to ask about. Without one, the actions are all this beat has. */
  const hasVisualAnchor = Boolean(
    intent?.subject ||
      intent?.people?.length ||
      intent?.event?.length ||
      intent?.location?.length ||
      intent?.period?.length ||
      intent?.objects?.length
  );
  if (!hasVisualAnchor) return queries;
  return queries.filter((q) => {
    const words = q.query
      .split(/[^\p{L}\p{N}'’-]+/u)
      .map((w) => foldSearchText(w))
      .filter(Boolean);
    if (words.length === 0) return true;
    return !words.every((w) => actions.has(w));
  });
}

function beatQueryTerms(input: VisualSearchPlanInput): string {
  const source = `${input.beatText ?? ""} ${input.sceneText ?? ""}`;
  return (
    visualTermsFromIntent(input.intent, source, BEAT_QUERY_TERMS) ||
    contentTermsFromText(input.beatText, BEAT_QUERY_TERMS)
  );
}

export async function getOrGenerateSearchPlan(
  cacheKeyIn: string,
  input: VisualSearchPlanInput
): Promise<VisualSearchPlan> {
  // Prefixed with the active render's videoId so a scene-index cache key can never collide
  // across different videos — a worker process renders many videos over its lifetime, and a
  // later video reaching the same scene index as an earlier one would otherwise silently reuse
  // that earlier, unrelated video's search plan (wrong topic, wrong entities, wrong era). Same
  // bug class and same fix pattern already applied to the sibling storyboard cache in
  // editorialSequencePlanner.ts.
  const cacheKey = `v${getActiveVideoId() ?? "?"}:${cacheKeyIn}`;
  const cached = _planCache.get(cacheKey);
  if (cached) return cached;

  if (!visualSearchPlanEnabled()) {
    /**
     * RONDE 213 — the worst case of the same defect: with the plan switched off this was the ONLY
     * query the beat ever had, at confidence 1, and it was the raw sentence. A beat whose narration
     * names no subject now searches for nothing here rather than for its own truncated grammar; the
     * rescue ladder below it is what such a beat has always relied on.
     *
     * `intent` is a label for the log, not a query, so it keeps the readable sentence.
     *
     * Not subject-anchored, and it needs no anchoring: there is no profile and therefore no tier
     * here, so the category query this round repairs cannot arise. The one query this route builds
     * comes from `beatQueryTerms`, which leads with the intent's own subject already.
     */
    const planless = beatQueryTerms(input);
    const empty: VisualSearchPlan = {
      intent: input.beatText.slice(0, 80),
      reasoning: "",
      primary: planless ? [scored(planless, 1, "content terms from narration")] : [],
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

  const anchor = subjectAnchorForBeat(profile, input);
  const plan = buildVisualSearchPlan(profile, input, anchor);
  await enrichWithLlm(plan, input);

  logPlan(`s${cacheKey}`, input.beatText.slice(0, 60), plan, anchor);

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
    /**
     * RONDE 88 (§10) — the "visual-equiv" round is REMOVED.
     *
     * It carried plan.fallback, which the LLM prompt used to request explicitly as "metaphorical
     * equivalents" — its own example was "empty harbor" for "trade collapse". Those words are not
     * in the script by construction, and the round was consumed with visionFloor: 0, so an
     * invented subject faced no picture check either. The field remains on the type so plans
     * stored before this round still parse; nothing reads it into a query any more.
     */
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
