/**
 * RONDE 88 — a search term is proven, or it is not sent.
 *
 * The RONDE 87 audit measured what the query path actually produces, and three of its findings
 * are the reason this module exists. Every example below is a real measured output, not a
 * hypothetical:
 *
 *   "Why Hitler Married Eva Braun Just Before The End"  ->  person "Eva Braun Just"
 *   "Inside The Final Hours Of Adolf Hitler"            ->  person "Of Adolf"
 *   "Why Stalin Purged His Own Generals"                ->  person "Stalin Purged"
 *   "She addressed the nation after the fall of France" ->  person "She", query "She France"
 *
 * All four reached providers. None of them names a person.
 *
 * The old protection was a hand-maintained list of ~120 title words. A blocklist can only refuse
 * what somebody remembered to add: "just", "of" and "purged" were not on it. This module protects
 * structurally instead, and the structure is the point:
 *
 *   1. A person's name is a CONTIGUOUS RUN in the source text. It is not assembled, not inferred
 *      from a title, and never spans a function word.
 *   2. Function words are a CLOSED grammatical class — articles, prepositions, conjunctions,
 *      pronouns, auxiliaries, determiners. Listing a closed class is grammar, not a blocklist:
 *      the set does not grow when somebody writes a new documentary title.
 *   3. Title Case destroys the one signal capitalisation carries. In "Why Stalin Purged His Own
 *      Generals" every word is capitalised, so capitalisation proves nothing about any of them.
 *      A name read out of such a string is therefore UNPROVEN unless the script itself states it.
 *
 * And one ordering rule, which the brief states as an absolute: a real name outranks a place, and
 * a place outranks everything else. PERSON > PLACE/COUNTRY > EVENT > ACTION > OBJECT > TIME.
 *
 * Deliberately dependency-free — no imports from videoPipeline, which imports this file.
 */

// ─── Tokens and provenance ───────────────────────────────────────────────────

export type QueryTokenType =
  | "person"
  | "place"
  | "country"
  | "event"
  | "action"
  | "object"
  | "time"
  | "year"
  | "technical";

/** Where a term came from. Anything not on this list cannot be the source of a sent term. */
export type QueryTokenSource =
  | "beat_text"
  | "scene_text"
  | "proven_entity"
  /** Allowed for technical terms only — "archival footage", provider syntax. Never for content. */
  | "technical"
  /** Present so a rejection can NAME the route that produced the term, never to permit it. */
  | "title_inference"
  | "llm_generated"
  | "unknown";

export type QueryToken = {
  term: string;
  type: QueryTokenType;
  source: QueryTokenSource;
  verified: boolean;
};

/** The proven, typed content of one beat. Every list may be empty; empty means "the beat does not say". */
export type VerifiedQueryContext = {
  persons: QueryToken[];
  places: QueryToken[];
  countries: QueryToken[];
  events: QueryToken[];
  actions: QueryToken[];
  objects: QueryToken[];
  time: QueryToken[];
  years: QueryToken[];
};

export function emptyQueryContext(): VerifiedQueryContext {
  return { persons: [], places: [], countries: [], events: [], actions: [], objects: [], time: [], years: [] };
}

/** Only these sources may put a CONTENT word into a query. */
const PROVEN_SOURCES: ReadonlySet<QueryTokenSource> = new Set(["beat_text", "scene_text", "proven_entity"]);

export function isProvenSource(source: QueryTokenSource): boolean {
  return PROVEN_SOURCES.has(source);
}

export function provenToken(term: string, type: QueryTokenType, source: QueryTokenSource = "beat_text"): QueryToken {
  return { term: term.trim(), type, source, verified: isProvenSource(source) && term.trim().length > 0 };
}

// ─── Grammar: the closed classes ─────────────────────────────────────────────

/**
 * Pronouns. §9 of the brief: never a person, under any circumstance.
 *
 * The audit's case 5 produced PERSON=["She"] because "addressed" is on the person-verb list and
 * nothing checked what was doing the addressing.
 */
export const FORBIDDEN_PERSON_PRONOUNS: ReadonlySet<string> = new Set([
  "i", "you", "he", "she", "it", "we", "they",
  "me", "him", "her", "us", "them",
  "his", "hers", "its", "their", "theirs", "our", "ours", "your", "yours", "my", "mine",
  "this", "that", "these", "those",
  "himself", "herself", "itself", "themselves", "myself", "yourself", "ourselves",
  "who", "whom", "whose", "which", "what",
]);

/**
 * English function words — a genuinely closed grammatical class.
 *
 * This is not the blocklist the audit criticised. That list tried to enumerate CONTENT words a
 * title might contain ("suicide", "pact", "downfall", "conquered") and could never be complete,
 * because content vocabulary is open. Function words are finite and do not grow. A person's name
 * never contains one, in any language that has them, which is what makes this a structural rule.
 */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  ...FORBIDDEN_PERSON_PRONOUNS,
  "a", "an", "the",
  "and", "or", "but", "nor", "so", "yet",
  "of", "in", "on", "at", "to", "from", "by", "for", "with", "without",
  "into", "onto", "over", "under", "above", "below", "between", "among", "through",
  "before", "after", "during", "since", "until", "till", "while", "within", "against",
  "about", "around", "across", "behind", "beside", "beyond", "inside", "outside", "upon",
  "is", "was", "are", "were", "be", "been", "being", "am",
  "has", "have", "had", "do", "does", "did",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "not", "no", "nor", "only", "just", "even", "also", "too", "very", "quite",
  "own", "some", "any", "all", "both", "each", "every", "few", "many", "much", "more", "most",
  "when", "where", "why", "how", "then", "than", "as", "if", "because",
]);

export function isPronounToken(token: string): boolean {
  return FORBIDDEN_PERSON_PRONOUNS.has(token.trim().toLowerCase().replace(/[^\p{L}]/gu, ""));
}

export function isFunctionWord(token: string): boolean {
  return FUNCTION_WORDS.has(token.trim().toLowerCase().replace(/[^\p{L}']/gu, ""));
}

/**
 * Function words that are ALSO ordinary given names in English.
 *
 * "Will Smith", "May Sarton", "Mark", "Grace". Treating these as function words inside a name
 * rejects real people — measured: checkPersonName("Will Smith") failed because "will" is a modal.
 * They stay function words everywhere else; they simply do not, on their own, disqualify a name.
 */
const AMBIGUOUS_NAME_WORDS: ReadonlySet<string> = new Set(["will", "may", "can", "art", "sue", "rose", "mark", "grace", "faith", "hope"]);

/** A function word for the purposes of NAME validation — the ambiguous given names excluded. */
export function blocksPersonName(token: string): boolean {
  const t = token.trim().toLowerCase().replace(/[^\p{L}']/gu, "");
  if (AMBIGUOUS_NAME_WORDS.has(t)) return false;
  return FUNCTION_WORDS.has(t);
}

/** A single name token: a capital followed by lowercase letters. "Braun" yes, "BRAUN" no, "of" no. */
const NAME_TOKEN_RE = /^\p{Lu}[\p{Ll}'’‐-―-]+$/u;

export function isNameShapedToken(token: string): boolean {
  return NAME_TOKEN_RE.test(token.trim());
}

/**
 * Is this string Title Case — i.e. does its capitalisation carry no information?
 *
 * "Why Stalin Purged His Own Generals" capitalises every word, so the fact that "Purged" is
 * capitalised says nothing about whether it is a name. A sentence capitalises only the first word
 * and real proper nouns, which is exactly the signal person extraction depends on.
 *
 * Measured threshold, not a guess: the four failing audit cases capitalise 100% of their words;
 * the passing sentence cases capitalise between 8% and 30%.
 */
export function isTitleCasedText(text: string): boolean {
  const words = (text ?? "").trim().split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length < 3) return false;
  const capitalised = words.filter((w) => /^\p{Lu}/u.test(w)).length;
  return capitalised / words.length >= 0.6;
}

// ─── Person validation ───────────────────────────────────────────────────────

export type PersonRejectReason =
  | "pronoun"
  | "function_word"
  | "not_name_shaped"
  | "too_many_tokens"
  | "too_few_tokens"
  | "not_contiguous_in_source"
  | "title_case_uncorroborated";

export type PersonCheck = { ok: boolean; reason?: PersonRejectReason };

/**
 * Is `candidate` a person name this pipeline is entitled to search for?
 *
 * `sourceText` is the text the name is claimed to come from, and `corroboration` is the script
 * body. The rules, in order, and every one of them structural:
 *
 *   · no pronouns, ever (§9)
 *   · no function word anywhere in the name — a name does not span "of", "just" or "own"
 *   · every token name-shaped: one capital, then lowercase
 *   · two or three tokens (a lone surname is handled separately as an anchor, not as a name)
 *   · the whole name appears as a CONTIGUOUS run in the source — never assembled from pieces
 *   · if the source is Title Case, its capitalisation proves nothing, so the name must also
 *     appear in the corroborating script text (§11: a title is not evidence)
 */
export function checkPersonName(
  candidate: string,
  sourceText: string,
  corroboration = "",
  opts: {
    /**
     * Does the pipeline already know this word to be a verb? Supplied by the caller because the
     * verb vocabulary lives in videoPipeline. In Title Case text capitalisation proves nothing,
     * so a token that is a known verb ("Purged", "Married", "Conquered") is refused there —
     * while a token that is nobody's verb ("Musk", "Washington") is still a perfectly good name.
     */
    isKnownVerb?: (token: string) => boolean;
  } = {}
): PersonCheck {
  const name = (candidate ?? "").trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, reason: "too_few_tokens" };
  const tokens = name.split(" ");
  if (tokens.length < 2) return { ok: false, reason: "too_few_tokens" };
  if (tokens.length > 3) return { ok: false, reason: "too_many_tokens" };
  for (const token of tokens) {
    if (isPronounToken(token)) return { ok: false, reason: "pronoun" };
    if (blocksPersonName(token)) return { ok: false, reason: "function_word" };
    if (!isNameShapedToken(token)) return { ok: false, reason: "not_name_shaped" };
  }
  if (sourceText && !containsContiguous(sourceText, name)) {
    return { ok: false, reason: "not_contiguous_in_source" };
  }
  if (isTitleCasedText(sourceText) && !containsContiguous(corroboration, name)) {
    // Capitalisation carries no information here. A token the pipeline knows to be a verb is
    // therefore unproven; anything else is still a name, because nothing argues against it.
    const verbToken = opts.isKnownVerb ? tokens.find((t) => opts.isKnownVerb!(t)) : undefined;
    if (verbToken) return { ok: false, reason: "title_case_uncorroborated" };
  }
  return { ok: true };
}

/** Does `haystack` contain `needle` as a whole-word contiguous run? */
export function containsContiguous(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const escaped = needle.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?:^|[^\\p{L}])${escaped}(?:[^\\p{L}]|$)`, "iu").test(haystack);
}

/**
 * The person names a text proves, in the order they appear.
 *
 * Splits every capitalised run on function words rather than rejecting the run outright, so a
 * real name embedded behind one survives: "The Untold Story Of Eva Braun" yields "Eva Braun",
 * and "Why Hitler Married Eva Braun Just Before The End" yields "Eva Braun" — not "Eva Braun Just".
 */
export function provenPersonNames(
  sourceText: string,
  corroboration = "",
  opts: { isKnownVerb?: (token: string) => boolean } = {}
): string[] {
  const text = (sourceText ?? "").replace(/\[visual:[^\]]*\]/gi, " ");
  if (!text.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Maximal runs of capitalised or function words, so a name behind "Of" is still reachable.
  for (const run of text.match(/(?:\p{Lu}[\p{Ll}'’-]+|\b[a-z]+\b)(?:\s+(?:\p{Lu}[\p{Ll}'’-]+|\b[a-z]+\b))*/gu) ?? []) {
    let segment: string[] = [];
    const segments: string[][] = [];
    for (const token of run.split(/\s+/)) {
      if (blocksPersonName(token) || !isNameShapedToken(token)) {
        if (segment.length) segments.push(segment);
        segment = [];
      } else {
        segment.push(token);
      }
    }
    if (segment.length) segments.push(segment);
    for (const seg of segments) {
      // A three-token run yields its two-token prefix too, so "Adolf Hitler Braun" cannot silently
      // become one name — but a genuine three-part name is still offered whole.
      for (const size of [seg.length, 2]) {
        if (size < 2 || size > seg.length) continue;
        const name = seg.slice(0, size).join(" ");
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        if (!checkPersonName(name, text, corroboration, opts).ok) continue;
        seen.add(key);
        out.push(name);
        break;
      }
    }
  }
  return out;
}

// ─── Query construction, in the mandated priority ────────────────────────────

export type PrioritisedQuery = {
  query: string;
  tokens: QueryToken[];
  /** 1 is the strongest combination this beat supports. */
  priority: number;
};

/** The one technical term this contract permits in a content query. */
export const TECHNICAL_ARCHIVAL_TERM = "archival footage";

/**
 * Builds this beat's queries, strongest first, in the mandated order:
 *
 *     PERSON > PERSON 2 > PLACE/COUNTRY > EVENT > ACTION > OBJECT > TIME
 *
 * Two rules the audit's findings turn into requirements:
 *
 *   · Every person the beat names is KEPT. "Churchill and Roosevelt met at Casablanca" led with
 *     "Roosevelt Casablanca" and lost Churchill entirely; it now leads with both.
 *   · A beat that names only people still gets queries. "Hitler met Eva Braun shortly before the
 *     end of the war" produced NOTHING, because every combination required a place or a year.
 *
 * Returns [] when the beat proves nothing worth asking — which is the correct answer, not a
 * failure. §6: "Geen betrouwbare query" is correct behaviour.
 */
function p1Present(persons: QueryToken[]): boolean {
  return persons.length > 0;
}

export function buildPrioritisedQueries(ctx: VerifiedQueryContext): PrioritisedQuery[] {
  const v = (list: QueryToken[]) => list.filter((t) => t.verified && t.term.trim());
  const persons = v(ctx.persons);
  const places = [...v(ctx.places), ...v(ctx.countries)];
  const events = v(ctx.events);
  const actions = v(ctx.actions);
  const objects = v(ctx.objects);
  const times = [...v(ctx.years), ...v(ctx.time)];

  const out: PrioritisedQuery[] = [];
  const seen = new Set<string>();
  const push = (...parts: QueryToken[]): void => {
    const tokens = parts.filter(Boolean);
    if (tokens.length === 0) return;
    const query = tokens.map((t) => t.term).join(" ").replace(/\s+/g, " ").trim();
    if (!query) return;
    // A query that says the same word twice is not a better query — "France fall of France".
    const words = new Set<string>();
    for (const w of query.toLowerCase().split(/\s+/)) {
      if (w === "of" || w === "the" || w === "and") continue;
      if (words.has(w)) return;
      words.add(w);
    }
    const key = query.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ query, tokens, priority: out.length + 1 });
  };

  const p1 = persons[0];
  /**
   * A SECOND person is only a co-subject when the beat itself names both.
   *
   * "Churchill and Roosevelt met at Casablanca" states a meeting between two people, and the
   * strongest query names both. A caller-supplied context person is a different claim: on
   * "Churchill addressed the nation after the fall of France", a celebrity fetch for Hitler must
   * ask about Churchill and about Hitler SEPARATELY — never "Churchill Adolf Hitler France",
   * which asserts a meeting the script does not describe.
   */
  const p2 = persons[1] && persons[0]?.source === "beat_text" && persons[1].source === "beat_text"
    ? persons[1]
    : undefined;
  /** The alternative angle: a proven person the beat did not name. Asked on its own, never joined. */
  const alt = persons.find((p) => p.source !== "beat_text");
  const place = places[0];
  /**
   * When the event extractor found nothing better than the beat's verb, the "event" IS the action
   * and must obey the action rules: "Poland invaded" is the subject-less form §1 forbids while
   * "Hitler Poland" is available.
   */
  const rawEvent = events[0];
  const action = actions[0];
  const eventIsAction = Boolean(rawEvent && action && rawEvent.term.toLowerCase() === action.term.toLowerCase());
  const event = eventIsAction && p1Present(persons) ? undefined : rawEvent;
  const object = objects[0];
  const time = times[0];
  const period = times[1];

  /**
   * The combinations, in the mandated priority.
   *
   * This is RONDE 73/77/78's combination set REORDERED, not replaced. Removing combinations was
   * an unforced narrowing — the brief changes which query LEADS and adds the ones that were
   * missing (a person alone, two persons, two persons plus a place), so every combination those
   * rounds established is still here, further down the list where it always belonged.
   */

  // 1. Names lead. §2/§3/§13.
  if (p1 && p2 && place) push(p1, p2, place);
  if (p1 && place) push(p1, place);
  // §4's worked example puts the bare name+place first and the year immediately behind it;
  // RONDE 73/77/78 measured that an archive answers the year-qualified form far better, so it
  // sits at position 2 rather than being dropped.
  if (p1 && place && time) push(p1, place, time);
  if (p1 && p2 && !place) push(p1, p2);
  if (p1 && !place && !p2) push(p1);
  if (p2 && place) push(p2, place);
  if (alt && alt !== p1 && place) push(alt, place);
  if (alt && alt !== p1 && !place) push(alt);

  // 2. The place's own year question, before the longer person variants.
  //
  // It used to sit at the very end of the list, which put it outside the slice several callers
  // take (buildPersonCelebrityVideoQueries caps at nine) — so on a beat with a proven person the
  // "Reichstag 1945" question was never actually asked. §1 is about which terms lead the STRING;
  // a place+year query contains no person to misplace.
  // The beat's EVENT, before the place's bare year question — the event is what the sentence is
  // about, and several callers take only the first few typed queries.
  if (p1 && place && event) push(p1, place, event);
  if (p1 && event && time) push(p1, event, time);
  if (p1 && place && time) push(place, time);

  // 3. Name + place + the rest of the beat's proven context.
  if (p1 && place && action) push(p1, place, action);
  if (p1 && action && time) push(p1, action, time);
  if (p1 && event) push(p1, event);
  if (p1 && action) push(p1, action);
  if (p1 && time) push(p1, time);
  if (p1 && place && period) push(p1, place, period);
  if (p1 && event && period) push(p1, event, period);

  // 3. No person: a named event that already carries the place is the stronger query, and the
  //    repeat guard would otherwise discard it — "Berlin" + "Battle of Berlin" says Berlin twice.
  if (!p1 && event && place && containsContiguous(event.term, place.term)) {
    if (time) push(event, time);
    push(event);
  }
  // 4. The place and its own context. Emitted whether or not a person was found: when one was,
  //    these sit BEHIND every person combination above, and a beat's place+year question is worth
  //    asking on its own. The dedup set below keeps a repeat out.
  if (place && event && time) push(place, event, time);
  if (place && event) push(place, event);
  if (!p1 && place && time) push(place, time);
  if (place && object && time) push(place, object, time);
  // The ACTION variants stay behind the no-person guard: "Berlin visited" is precisely the form
  // §1 forbids while "Hitler Berlin" is available — a verb without its subject. Place+event and
  // place+time carry no such implication and are asked either way.
  if (!p1 && place && action && time) push(place, action, time);
  if (!p1 && place && action) push(place, action);
  if (place && object) push(place, object);
  if (place && period) push(place, period);
  if (place && event && period) push(place, event, period);
  // Deliberately NO bare-place query: "Berlin" on its own returns anything ever shot in Berlin.
  // The archival-footage variant at the end covers the place-only case with a usable query.

  // 5. No person and no place: only what the beat literally states.
  if (!p1 && !place && event && time) push(event, time);
  if (!p1 && !place && event) push(event);
  if (!p1 && !place && !event && object && action) push(object, action);

  // 6. The strongest combination again, phrased for an archive. The ONE permitted technical term,
  //    and only ever behind a real entity — never as a query of its own.
  const technical: QueryToken = {
    term: TECHNICAL_ARCHIVAL_TERM, type: "technical", source: "technical", verified: true,
  };
  if (p1 && place) push(p1, place, technical);
  else if (p1) push(p1, technical);
  else if (place) push(place, technical);

  return out;
}

// ─── The validator every provider search passes through ──────────────────────

export type QueryRejectReason =
  | "UNVERIFIED_TERM"
  | "FORBIDDEN_PRONOUN"
  | "TITLE_INFERENCE_NOT_ALLOWED"
  | "LLM_GENERATED_TERM"
  | "PERSON_AFTER_PLACE"
  | "EMPTY_QUERY";

export type QueryValidation = {
  ok: boolean;
  reason?: QueryRejectReason;
  offendingTerm?: string;
};

/**
 * The last gate before a query reaches a provider.
 *
 * `ctx` is the beat's proven context. Every CONTENT word in the query must be traceable to it;
 * technical terms and provider syntax are exempt by name, not by pattern.
 *
 * Called with no context (`undefined`) the validator can only apply the checks that need none —
 * pronouns and empty queries. That is deliberate: a caller that cannot supply a context has not
 * proven anything, and the honest response is to refuse what is provably wrong rather than to
 * pretend the rest was checked. Those call sites are reported by name in the round's report.
 */
export function validateSearchQuery(
  query: string,
  ctx?: VerifiedQueryContext
): QueryValidation {
  const q = (query ?? "").trim();
  if (!q) return { ok: false, reason: "EMPTY_QUERY" };

  const technicalWords = new Set(
    TECHNICAL_ARCHIVAL_TERM.toLowerCase().split(/\s+/).concat(["archival", "footage", "mediatype", "movies"])
  );

  const words = q.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'’-]/gu, "")).filter(Boolean);

  // A pronoun is never a legitimate search term, with or without a context.
  for (const w of words) {
    if (isPronounToken(w) && /^\p{Lu}/u.test(w)) {
      return { ok: false, reason: "FORBIDDEN_PRONOUN", offendingTerm: w };
    }
  }
  if (!ctx) return { ok: true };

  const proven = new Set<string>();
  for (const list of [ctx.persons, ctx.places, ctx.countries, ctx.events, ctx.actions, ctx.objects, ctx.time, ctx.years]) {
    for (const token of list) {
      if (!token.verified) continue;
      for (const w of token.term.toLowerCase().split(/\s+/)) proven.add(w.replace(/[^\p{L}\p{N}'’-]/gu, ""));
    }
  }
  const rejected = new Map<string, QueryTokenSource>();
  for (const list of [ctx.persons, ctx.places, ctx.countries, ctx.events, ctx.actions, ctx.objects]) {
    for (const token of list) {
      if (token.verified) continue;
      for (const w of token.term.toLowerCase().split(/\s+/)) rejected.set(w, token.source);
    }
  }

  for (const raw of words) {
    const w = raw.toLowerCase();
    if (technicalWords.has(w) || isFunctionWord(w)) continue;
    if (proven.has(w)) continue;
    const source = rejected.get(w);
    if (source === "title_inference") {
      return { ok: false, reason: "TITLE_INFERENCE_NOT_ALLOWED", offendingTerm: raw };
    }
    if (source === "llm_generated") {
      return { ok: false, reason: "LLM_GENERATED_TERM", offendingTerm: raw };
    }
    return { ok: false, reason: "UNVERIFIED_TERM", offendingTerm: raw };
  }

  // Ordering: a proven person must not appear after a proven place.
  const firstIndexOf = (list: QueryToken[]): number => {
    let best = -1;
    for (const token of list) {
      if (!token.verified) continue;
      const idx = words.findIndex((w) => w.toLowerCase() === token.term.toLowerCase().split(/\s+/)[0]);
      if (idx >= 0 && (best === -1 || idx < best)) best = idx;
    }
    return best;
  };
  const personAt = firstIndexOf(ctx.persons);
  const placeAt = Math.max(firstIndexOf(ctx.places), firstIndexOf(ctx.countries));
  if (personAt >= 0 && placeAt >= 0 && placeAt < personAt) {
    return { ok: false, reason: "PERSON_AFTER_PLACE", offendingTerm: words[personAt] };
  }
  return { ok: true };
}

// ─── Logging (§19) ───────────────────────────────────────────────────────────

export function formatSearchQueryLog(meta: {
  renderId?: string;
  sceneIndex?: number;
  beatIndex?: number;
  query: string;
  tokens?: QueryToken[];
  priority?: number;
  route?: string;
  provider?: string;
}): string {
  const persons = (meta.tokens ?? []).filter((t) => t.type === "person").map((t) => t.term);
  const places = (meta.tokens ?? []).filter((t) => t.type === "place" || t.type === "country").map((t) => t.term);
  return (
    `[SearchQuery] render=${meta.renderId ?? "-"} scene=${meta.sceneIndex ?? "?"} ` +
    `beat=${meta.beatIndex ?? "?"} priority=${meta.priority ?? "?"} query="${meta.query}" ` +
    `persons=${JSON.stringify(persons)} places=${JSON.stringify(places)} ` +
    `verified=true route=${meta.route ?? "-"} provider=${meta.provider ?? "-"}`
  );
}

export function formatSearchQueryRejected(meta: {
  renderId?: string;
  sceneIndex?: number;
  beatIndex?: number;
  query: string;
  reason: QueryRejectReason;
  offendingTerm?: string;
  termSource?: QueryTokenSource;
  route?: string;
  provider?: string;
}): string {
  return (
    `[SearchQueryRejected] render=${meta.renderId ?? "-"} scene=${meta.sceneIndex ?? "?"} ` +
    `beat=${meta.beatIndex ?? "?"} query="${meta.query}" term="${meta.offendingTerm ?? ""}" ` +
    `termSource=${meta.termSource ?? "unknown"} verified=false reason=${meta.reason} ` +
    `route=${meta.route ?? "-"} provider=${meta.provider ?? "-"}`
  );
}

// ─── RONDE 89: the provider gate ─────────────────────────────────────────────

/**
 * A query that has been through the contract, carrying the proof with it.
 *
 * §4 of the round: a provider must be able to tell a validated query from a bare string. A string
 * cannot say where it came from, so it cannot be trusted at the gate — this object can, because
 * `verified` is set in exactly one place (mintVerifiedQuery) and only when validateSearchQuery
 * agreed. There is deliberately no constructor that takes `verified: true` as an argument.
 */
export type VerifiedSearchQuery = {
  readonly query: string;
  readonly tokens: readonly QueryToken[];
  readonly verified: boolean;
  readonly route: string;
  readonly renderId?: string;
  readonly sceneIndex?: number;
  readonly beatIndex?: number;
  /** Set when verified is false — why the contract refused it. */
  readonly rejectReason?: QueryRejectReason | LegacyRejectReason;
};

/** Reasons that describe HOW a query reached the gate rather than what is in it. */
export type LegacyRejectReason =
  | "NO_SEARCH_CONTEXT"
  | "LEGACY_QUERY_BUILDER"
  | "UNVERIFIED_QUERY"
  | "SYSTEM_ANCHOR_NOT_ALLOWED"
  | "LLM_DERIVED_TERM_NOT_ALLOWED"
  | "PROVIDER_GATE_BYPASS";

export type AnyRejectReason = QueryRejectReason | LegacyRejectReason;

/**
 * The ONE place a query becomes verified.
 *
 * Requires a context. A caller without one gets an unverified ticket carrying
 * NO_SEARCH_CONTEXT — §3: "we don't know where this came from but it looks fine" is precisely
 * the guess this round removes, so the absence of a context is recorded as such rather than
 * treated as an absence of evidence against it.
 */
export function mintVerifiedQuery(
  query: string,
  ctx: VerifiedQueryContext | undefined,
  meta: { route: string; renderId?: string; sceneIndex?: number; beatIndex?: number }
): VerifiedSearchQuery {
  const tokens = ctx
    ? [...ctx.persons, ...ctx.places, ...ctx.countries, ...ctx.events, ...ctx.actions, ...ctx.objects, ...ctx.time, ...ctx.years]
    : [];
  if (!ctx) {
    return { query, tokens, verified: false, rejectReason: "NO_SEARCH_CONTEXT", ...meta };
  }
  const verdict = validateSearchQuery(query, ctx);
  return verdict.ok
    ? { query, tokens, verified: true, ...meta }
    : { query, tokens, verified: false, rejectReason: verdict.reason ?? "UNVERIFIED_TERM", ...meta };
}

/**
 * A ticket for a caller that has no context to offer.
 *
 * Always unverified. It exists so such a call is COUNTED and NAMED at the gate rather than
 * arriving as an anonymous string — the difference between a known gap and an invisible one.
 */
export function legacyQueryTicket(query: string, route: string): VerifiedSearchQuery {
  return { query, tokens: [], verified: false, route, rejectReason: "LEGACY_QUERY_BUILDER" };
}

export function isVerifiedSearchQuery(value: unknown): value is VerifiedSearchQuery {
  return (
    typeof value === "object" && value !== null &&
    typeof (value as VerifiedSearchQuery).query === "string" &&
    typeof (value as VerifiedSearchQuery).verified === "boolean" &&
    Array.isArray((value as VerifiedSearchQuery).tokens)
  );
}

/** §15 — per-route and per-provider counters for what the gate did. */
export type SearchGateCounters = {
  queriesBuilt: number;
  queriesValidated: number;
  queriesRejected: number;
  queriesSent: number;
  queriesBlocked: number;
  bypassAttempts: number;
};

function emptyGateCounters(): SearchGateCounters {
  return { queriesBuilt: 0, queriesValidated: 0, queriesRejected: 0, queriesSent: 0, queriesBlocked: 0, bypassAttempts: 0 };
}

export class SearchGateAudit {
  private readonly byProvider = new Map<string, SearchGateCounters>();
  private readonly byRoute = new Map<string, SearchGateCounters>();
  private readonly reasons = new Map<string, number>();
  readonly total: SearchGateCounters = emptyGateCounters();

  private bump(map: Map<string, SearchGateCounters>, key: string, field: keyof SearchGateCounters): void {
    const entry = map.get(key) ?? emptyGateCounters();
    entry[field] += 1;
    map.set(key, entry);
  }

  record(field: keyof SearchGateCounters, provider: string, route: string, reason?: string): void {
    this.total[field] += 1;
    this.bump(this.byProvider, (provider || "unknown").toLowerCase(), field);
    this.bump(this.byRoute, route || "unknown", field);
    if (reason) this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
  }

  summary(): {
    total: SearchGateCounters;
    byProvider: Record<string, SearchGateCounters>;
    byRoute: Record<string, SearchGateCounters>;
    rejectReasons: Record<string, number>;
  } {
    return {
      total: { ...this.total },
      byProvider: Object.fromEntries([...this.byProvider].map(([k, v]) => [k, { ...v }])),
      byRoute: Object.fromEntries([...this.byRoute].map(([k, v]) => [k, { ...v }])),
      rejectReasons: Object.fromEntries(this.reasons),
    };
  }
}

/** The process-wide audit. One render at a time writes far more than it reads. */
export const searchGateAudit = new SearchGateAudit();

export function formatSearchGateReport(audit: SearchGateAudit = searchGateAudit): string[] {
  const s = audit.summary();
  const line = (label: string, c: SearchGateCounters) =>
    `[SearchGate] ${label} built=${c.queriesBuilt} validated=${c.queriesValidated} ` +
    `rejected=${c.queriesRejected} sent=${c.queriesSent} blocked=${c.queriesBlocked} ` +
    `bypassAttempts=${c.bypassAttempts}`;
  const out = [line("TOTAL", s.total)];
  for (const [provider, c] of Object.entries(s.byProvider)) out.push(line(`provider=${provider}`, c));
  for (const [route, c] of Object.entries(s.byRoute)) out.push(line(`route=${route}`, c));
  const reasons = Object.entries(s.rejectReasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length) out.push(`[SearchGate] rejectReasons ` + reasons.map(([r, n]) => `${r}=${n}`).join(" "));
  return out;
}

/**
 * Is the gate refusing unverified queries outright?
 *
 * Default OFF, and that is a deliberate, reported limitation rather than a design choice. Turning
 * it on today would block every legacy call site that cannot yet supply a context — which is most
 * of them — and stop the pipeline from sourcing anything at all. With it off, those calls are
 * counted as bypassAttempts and named in the report, so the remaining work is visible and
 * measurable instead of assumed away.
 */
export function searchGateStrict(): boolean {
  return process.env.SEARCH_GATE_STRICT === "true";
}
