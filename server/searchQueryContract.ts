import { AsyncLocalStorage } from "node:async_hooks";

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
  /**
   * RONDE 160 — THE USER'S OWN WORDS: `videos.prompt`, exactly as typed into the form.
   *
   * ── The bug this closes ────────────────────────────────────────────────────────────────────
   *
   * A production log rejected the query "WWII archival footage" with UNVERIFIED_TERM on a video
   * whose whole subject was WWII. Reproduced: a beat reading "German commanders redrew the front
   * line in the winter of 1942" proves "German", "commanders" and "1942", and does not contain the
   * string "WWII" anywhere. The evidence was the beat plus its scene, and nothing else, so the one
   * word that names the subject of the entire video was the one word the query could not use.
   *
   * ── Why this is not the title hole re-opening ──────────────────────────────────────────────
   *
   * RONDE 90 deliberately refused the video's TITLE as evidence, and that stays refused —
   * `title_inference` is still on the forbidden list below. The distinction is who wrote it:
   *
   *   videos.title    LLM-GENERATED. A claim the model made about the video. Admitting it let
   *                   "Adolf Hitler France" be measured on a beat that names neither. Forbidden.
   *
   *   videos.prompt   WHAT THE USER TYPED. Not a derivation, not an inference — it is the
   *                   authorisation itself. A person who asks for a documentary about WWII has
   *                   authorised the word "WWII".
   *
   * So this admits INPUT and still refuses DERIVED CONTENT. Note for anyone wiring a new call
   * site: this must be fed from `videos.prompt`. Feeding it a title, a summary or any other
   * model output would silently turn it into the hole RONDE 90 closed.
   */
  | "topic"
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
  /**
   * RONDE 90 (§3) — the text this term was read out of, and where in it.
   *
   * "It came from the beat" is a claim; `evidence` plus `[start,end)` is that claim made
   * checkable. A term whose offsets do not slice back to the term itself did not come from the
   * text it names, and the audit log says so instead of taking the source label at face value.
   * Optional because a proven_entity (a caller fetching footage OF a named person) has no offset
   * into any script — its evidence is the caller's own request.
   */
  evidence?: string;
  start?: number;
  end?: number;
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
  /**
   * RONDE 90 (§3) — the beat's own words, plus the scene text that corroborates them.
   *
   * This is the ground truth a content word is checked against. RONDE 89's gate could only ask
   * "is this word one of the typed tokens?", which refused every legitimate word the extractors
   * happen not to type — a beat about canals and cyclists proves "canal" and "cyclists" whether
   * or not an extractor labelled them. A word that literally stands in the script is proven by
   * the script; a word that does not is not, no matter which builder produced it.
   */
  evidence: string;
  /**
   * RONDE 160 — the user's own prompt (`videos.prompt`), verbatim.
   *
   * Held SEPARATELY from `evidence` rather than concatenated into it, because the two answer
   * different questions and the audit log has to be able to tell them apart: `evidence` is what
   * this beat says, `topic` is what the person asked for. A term proven only by the topic is a
   * term the script never used — legitimate, but worth being able to see.
   *
   * Empty when the caller has no prompt to hand, which changes nothing: a term then has to be
   * proven by the script exactly as before.
   */
  topic?: string;
};

export function emptyQueryContext(evidence = "", topic = ""): VerifiedQueryContext {
  return {
    persons: [], places: [], countries: [], events: [], actions: [], objects: [], time: [], years: [],
    evidence,
    ...(topic.trim() ? { topic: topic.trim() } : {}),
  };
}

/** Only these sources may put a CONTENT word into a query. */
const PROVEN_SOURCES: ReadonlySet<QueryTokenSource> = new Set([
  "beat_text",
  "scene_text",
  "proven_entity",
  /** RONDE 160 — the user's own prompt. See `QueryTokenSource` for why this is not the title. */
  "topic",
]);

export function isProvenSource(source: QueryTokenSource): boolean {
  return PROVEN_SOURCES.has(source);
}

export function provenToken(
  term: string,
  type: QueryTokenType,
  source: QueryTokenSource = "beat_text",
  /** RONDE 90 (§3): the text this term is claimed to come from. Offsets are located, not asserted. */
  evidence?: string
): QueryToken {
  const t = term.trim();
  const token: QueryToken = { term: t, type, source, verified: isProvenSource(source) && t.length > 0 };
  if (evidence) {
    const at = evidence.toLowerCase().indexOf(t.toLowerCase());
    token.evidence = evidence;
    if (at >= 0) {
      token.start = at;
      token.end = at + t.length;
    }
  }
  return token;
}

/**
 * RONDE 90 (§3) — does this token's own evidence actually contain it, at the offsets it claims?
 *
 * A token with no evidence attached cannot be checked here and is not failed here; §11's check G
 * is where an unbacked person is refused. This answers only: when a token DOES carry evidence,
 * does that evidence hold up.
 */
export function tokenEvidenceHolds(token: QueryToken): boolean {
  if (!token.evidence) return true;
  if (token.start == null || token.end == null) {
    return containsContiguous(token.evidence, token.term);
  }
  return token.evidence.slice(token.start, token.end).toLowerCase() === token.term.trim().toLowerCase();
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
  "other", "others", "another", "same", "such", "there", "here",
  "when", "where", "why", "how", "then", "than", "as", "if", "because",
]);

export function isPronounToken(token: string): boolean {
  return FORBIDDEN_PERSON_PRONOUNS.has(token.trim().toLowerCase().replace(/[^\p{L}]/gu, ""));
}

export function isFunctionWord(token: string): boolean {
  return FUNCTION_WORDS.has(token.trim().toLowerCase().replace(/[^\p{L}']/gu, ""));
}

/**
 * RONDE 90 (§8/§11) — camera and format vocabulary. A closed class, like the function words.
 *
 * "aerial", "close up", "b-roll", "timelapse" and "establishing" say how a shot was taken, not
 * what happened in the world. They make no claim a script could contradict, which is precisely
 * why they are allowed without evidence — and why the list can be closed: production vocabulary
 * is a finite craft vocabulary, unlike the open set of things a documentary can be ABOUT.
 *
 * Deliberately NOT on this list: every word that names a subject. "canal", "protest", "factory"
 * and "skyline" describe the world and must be proven by the script like any other content word,
 * even though a query builder is fond of appending them.
 */
export const PRODUCTION_VOCABULARY: ReadonlySet<string> = new Set([
  "archival", "footage", "film", "video", "clip", "clips", "reel", "stock",
  "documentary", "broll", "b-roll", "newsreel", "archive", "archives",
  "aerial", "wide", "closeup", "close-up", "close", "up", "medium", "shot", "shots",
  "establishing", "pan", "tilt", "tracking", "handheld", "static", "overhead", "topdown",
  "timelapse", "time-lapse", "slowmotion", "slow-motion", "montage", "cutaway",
  "colour", "color", "black", "white", "monochrome", "restored",
  /*
   * ── RONDE 205: "drone", "4k", "hd" and "1080p" are NOT era-neutral, and are not here ───────
   *
   * Everything in this set is a word that describes the FILM rather than its subject, and is
   * therefore allowed on any query without evidence. These four break that rule: they describe
   * the film in a way that dates it.
   *
   * A drone did not exist in 1945. 4K, HD and 1080p are modern capture formats, and no genuine
   * 1945 archival material is any of them. So "Berlin 1945 drone footage" and "Berlin 1945 4k"
   * were queries the gate waved through unconditionally, and they can only be answered by modern
   * re-creations, colourised uploads or footage of somewhere else entirely — the exact modern
   * mismatch the visual gates exist to catch, licensed at the source.
   *
   * They are not BANNED: they are ordinary content words now. A beat that says "a drone surveyed
   * the site in 2019" proves "drone" and may search for it, exactly like any other word the
   * script actually said. What changed is that a beat which never mentioned one can no longer
   * borrow it.
   *
   * Reachability at the time of the change: the only builder that emitted "aerial drone" is
   * `buildVidrushOpeningQueries`, which has no production caller, so this closed a hole rather
   * than changing a live query. It is fixed anyway — a gate that permits a wrong query is a bug
   * whether or not something currently walks through it.
   */
  // Words that describe the FOOTAGE rather than its subject. "historical footage of X" makes
  // one claim about X (that it exists) and one about the film (that it is old); only the
  // first needs proving, and X still has to prove itself.
  "historical", "historic", "original", "vintage", "period", "old", "retro", "silent",
  "newsreels", "rare", "authentic", "real", "raw", "unedited", "compilation",
  "mediatype", "movies", "level", "street-level", "photo", "photos", "photograph", "image", "images",
  /**
   * RONDE 93 — provider QUERY-LANGUAGE keywords, not content.
   *
   * Archive.org takes Lucene-style field queries: `title:(Winston Churchill) AND mediatype:movies`,
   * `collection:tvnews`, `subject:"Churchill"`. RONDE 90 admitted "mediatype" and "movies" and
   * stopped there, so the audit read "title", "subject", "collection" and "tvnews" as unproven
   * SUBJECTS and blocked every field query the archive route builds — a whole provider's syntax
   * refused for saying which index to search rather than what to search for. These name a field,
   * never a thing in the world, which is what keeps this a closed class.
   */
  "title", "subject", "collection", "tvnews", "identifier", "creator", "date", "and", "or", "not",
  /**
   * RONDE 100B — the same closed class, one provider further on.
   *
   * GDELT's TV API takes `"<person>" station:CNN`, where `station` names which broadcaster's
   * index to search. RONDE 93 admitted archive.org's field syntax and stopped there, so the
   * validator read `station`, `CNN`, `FOXNEWS`, `MSNBC` and `BBCNEWS` as unproven subjects and
   * refused every GDELT query ever built: production logged built=176, validated=0, rejected=176
   * — an entire provider dark because it said where to look rather than what to look for.
   *
   * Verified before adding, per the brief: buildGdeltTvQueries emits `station:${station}` from
   * GDELT_TV_STATIONS, and fetchGdeltTvNewsClips passes the whole string to the GDELT endpoint as
   * `query=`. The four names are that API's own station identifiers; no other provider uses them.
   * A station is a channel, not a claim about the world, which is what keeps this class closed —
   * and the person or event in the same query still has to prove itself as before.
   */
  "station", "cnn", "foxnews", "msnbc", "bbcnews",
]);

export function isProductionWord(token: string): boolean {
  return PRODUCTION_VOCABULARY.has(token.trim().toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, ""));
}

/**
 * RONDE 90 (§3) — the forms of an English word that count as the same word, for evidence only.
 *
 * A beat that says "canals" proves "canal"; one that says "bridge" proves "bridges". Refusing
 * those would not make the pipeline more honest, only wrong in the other direction — the script
 * really does say the thing.
 *
 * Every candidate is returned rather than one canonical stem, because a single stem does not
 * commute: stripping "s" turns "bridges" into "bridge" while "bridge" stays itself, and the two
 * then fail to match. Comparing the candidate SETS makes the relation symmetric, which is what
 * "the same word" has to be.
 *
 * Strictly INFLECTIONAL: plurals and simple verb forms, nothing else, and never below four
 * characters. "cycling" and "cyclists" stay different words here — they are related by
 * derivation, not inflection, and proving one from the other is the kind of inference this round
 * exists to refuse. A builder that appends "cyclists" to a beat about cycling is guessing, and
 * the gate says so.
 */
export function evidenceStems(word: string): string[] {
  const w = word.trim().toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, "");
  if (!w) return [];
  const out = new Set<string>([w]);
  const add = (s: string) => {
    if (s.length >= 4) out.add(s);
  };
  for (const suffix of ["s", "es", "ed", "er", "ers", "ing", "ies"]) {
    if (w.length - suffix.length >= 4 && w.endsWith(suffix)) {
      add(w.slice(0, w.length - suffix.length));
    }
  }
  // "cities" -> "city": the one spelling change common enough that ignoring it reads as a bug.
  if (w.endsWith("ies") && w.length >= 5) add(w.slice(0, -3) + "y");
  return [...out];
}

/** The shortest form of a word — the single canonical stem, where one value is needed. */
export function evidenceStem(word: string): string {
  const stems = evidenceStems(word);
  return stems.length ? stems.reduce((a, b) => (b.length < a.length ? b : a)) : "";
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
const NAME_TOKEN_RE = /^\p{Lu}[\p{Ll}\p{M}'’‐-―-]+$/u;

/**
 * RONDE 125 — the shapes this refused that are ordinary names.
 *
 * The pattern above requires everything after the first capital to be lower case, so a name with
 * a capital after a hyphen or an apostrophe was "not_name_shaped". Measured against the real
 * checker, before this:
 *
 *     Jean-Luc  → false        Mary-Kate → false
 *     el-Sisi   → false        O'Neill   → false
 *
 * A capital is allowed ONLY immediately after a hyphen or an apostrophe, never mid-word, so
 * "McDonald" and "BRAUN" are refused exactly as before. The lower-case half of a hyphenated
 * particle ("el-Sisi") is admitted for the same reason: it is part of one written name.
 */
const HYPHENATED_NAME_TOKEN_RE =
  /^(?:\p{Lu}['’]|(?:de|del|della|der|den|des|di|do|dos|du|da|van|von|vom|zu|ten|ter|la|le|les|bin|ibn|bint|al|el|ben|bar|abu|af|av)-)?\p{Lu}[\p{Ll}\p{M}]+(?:(?:['’]\p{Lu}|[-‐―]\p{Lu}?)[\p{Ll}\p{M}]+)*$/u;

export function isNameShapedToken(token: string): boolean {
  const t = token.trim();
  return NAME_TOKEN_RE.test(t) || HYPHENATED_NAME_TOKEN_RE.test(t);
}

/**
 * RONDE 125 — the lower-case words that belong inside a surname.
 *
 * "Charles de Gaulle" failed `not_name_shaped` on "de", and "Vincent van Gogh" on "van". These
 * are name particles, not function words: they carry no meaning of their own in the middle of a
 * name. A particle is only ever accepted BETWEEN two capitalised tokens — never first, never
 * last — which is what stops "de" becoming a name by itself.
 *
 * Kept as its own list rather than folded into isNameShapedToken so the positional rule can be
 * enforced by the caller that knows the position.
 */
const NAME_PARTICLE_SET = new Set([
  "de", "del", "della", "der", "den", "des", "di", "do", "dos", "du", "da",
  "van", "von", "vom", "zu", "ten", "ter", "la", "le", "les",
  "bin", "ibn", "bint", "al", "el", "ben", "bar", "abu", "af", "av",
]);

export function isNameParticleToken(token: string): boolean {
  return NAME_PARTICLE_SET.has(token.trim().toLowerCase());
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
  // RONDE 125: a particle is not one of the name's own words for counting purposes — "Ludwig van
  // Beethoven" and "Abdel Fattah el-Sisi" are three-part names, and the old cap of 3 turned
  // "Mohammed bin Salman" into too_many_tokens the moment particles were admitted at all.
  const significantTokens = tokens.filter((t) => !isNameParticleToken(t));
  if (significantTokens.length > 3) return { ok: false, reason: "too_many_tokens" };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isPronounToken(token)) return { ok: false, reason: "pronoun" };
    /**
     * RONDE 125: a particle is accepted only BETWEEN two of the name's own words. First or last,
     * it is an ordinary word again and the old refusals apply — so "de" alone is still not a
     * name, and neither is "Hermann de".
     */
    if (isNameParticleToken(token)) {
      if (i === 0 || i === tokens.length - 1) return { ok: false, reason: "function_word" };
      continue;
    }
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
  /**
   * RONDE 103 (phases 9–13) — how specific this question is, 4 (most) down to 1 (least).
   *
   *   4  a concrete event WITH its context ......... "Hitler Berlin bunker 1945"
   *   3  the event itself ......................... "Battle of Berlin"
   *   2  an entity with context ................... "Hitler Berlin", "Reichstag 1945"
   *   1  the bare entity ......................... "Hitler", "Berlin archival footage"
   *
   * Derived from the token TYPES that are already in the query rather than from a second builder:
   * the levels are a reading of what the beat proved, not a new source of terms. Nothing here can
   * introduce a word, so a labelled query is exactly as provable as the unlabelled one was.
   *
   * What the level is FOR is the descent rule. Asking every question a beat supports costs a
   * render 1600 provider calls to fill twenty slots, and the broad ones are where the wrong
   * pictures come from — a level-1 "Berlin" returns anything ever shot in Berlin. Walking down
   * from 4 and stopping at the first level that yields a clip the relevance gate accepts asks the
   * narrow questions first and the broad ones only when the narrow ones came back empty.
   */
  level: 1 | 2 | 3 | 4;
};

/**
 * The specificity level of one combination, read off the token types it contains.
 *
 * `technical` never counts toward specificity — "archival footage" is a phrasing for an archive,
 * not something the beat says about the world.
 */
function queryLevel(tokens: QueryToken[]): 1 | 2 | 3 | 4 {
  const types = new Set(tokens.filter((t) => t.type !== "technical").map((t) => t.type));
  const hasEvent = types.has("event");
  const entities = ["person", "place", "country", "object"].filter((t) => types.has(t as QueryTokenType));
  const hasContext = types.has("year") || types.has("time") || types.has("place") || types.has("country");
  if (hasEvent && (entities.length > 0 || types.has("year") || types.has("time"))) return 4;
  if (hasEvent) return 3;
  // Two entities are context for each other — "Hitler Berlin" narrows as hard as "Hitler 1945".
  if (entities.length > 1 || (entities.length > 0 && hasContext) || types.has("action")) return 2;
  return 1;
}

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
    out.push({ query, tokens, priority: out.length + 1, level: queryLevel(tokens) });
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
  /**
   * RONDE 90 (§5) — a THIRD name the beat states is asked about too.
   *
   * Measured: "Churchill, Roosevelt and Stalin met at Yalta" produced six queries and not one of
   * them contained Stalin, because every combination stopped at two people. §5 does not say the
   * two strongest names — it says no name a beat states may be lost. The third is asked on its
   * own and with the place, never joined to the first two: "Churchill Roosevelt Stalin" reads as
   * one search for a group portrait, which is a narrower question than the beat asked.
   */
  for (const extra of persons.slice(2)) {
    if (extra.source !== "beat_text") continue;
    if (place) push(extra, place);
    else push(extra);
  }
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

/**
 * RONDE 103 (phases 9–13) — the beat's questions, grouped by how specific they are.
 *
 * Returns the levels present in this beat, most specific first, each with its own queries in the
 * priority order `buildPrioritisedQueries` established. A level that this beat cannot support is
 * simply absent — there is no padding and no invented rung, because a beat that names nobody has
 * no level-1 person question to ask and pretending otherwise is how "documentary" got sent to
 * Pexels forty times.
 *
 * The caller walks the rungs and stops at the first one that produced a clip the relevance gate
 * accepted. Nothing here performs a search or decides anything; it only says which questions
 * belong together and in what order they should be asked.
 */
export function buildBeatSearchLadder(
  ctx: VerifiedQueryContext
): Array<{ level: 1 | 2 | 3 | 4; queries: PrioritisedQuery[] }> {
  const all = buildPrioritisedQueries(ctx);
  const out: Array<{ level: 1 | 2 | 3 | 4; queries: PrioritisedQuery[] }> = [];
  for (const level of [4, 3, 2, 1] as const) {
    const queries = all.filter((q) => q.level === level);
    if (queries.length > 0) out.push({ level, queries });
  }
  return out;
}

/** One line per rung, so a render's descent is readable in the log. */
export function formatSearchLadder(
  ladder: Array<{ level: 1 | 2 | 3 | 4; queries: PrioritisedQuery[] }>
): string[] {
  return ladder.map(
    (rung) =>
      `[SearchLadder] level ${rung.level}: ${rung.queries.length} question(s) — ` +
      rung.queries.map((q) => `"${q.query}"`).slice(0, 4).join(", ")
  );
}

// ─── The validator every provider search passes through ──────────────────────

export type QueryRejectReason =
  | "UNVERIFIED_TERM"
  | "FORBIDDEN_PRONOUN"
  | "TITLE_INFERENCE_NOT_ALLOWED"
  | "LLM_GENERATED_TERM"
  | "PERSON_AFTER_PLACE"
  | "EMPTY_QUERY"
  /** RONDE 90 (§11 G): a person token whose evidence does not contain it. */
  | "PERSON_WITHOUT_EVIDENCE"
  /** RONDE 90 (§11 H): nothing but production vocabulary and function words — no subject at all. */
  | "NO_CONTENT_ANCHOR"
  /**
   * RONDE 91 (§3): a term the visual-director plan introduced that its own sentence does not
   * state. Distinct from UNVERIFIED_TERM so the log answers WHO guessed, not just THAT somebody
   * did — a builder appending "aerial" and a language model inventing a bunker are different
   * problems with different fixes.
   */
  | "LLM_UNPROVEN_CONTENT";

export type QueryValidation = {
  ok: boolean;
  reason?: QueryRejectReason;
  offendingTerm?: string;
  /**
   * RONDE 90 (§13) — every query word that could not be traced, not just the first.
   *
   * The gate stops at the first failure, but the audit log names them all: a query rejected for
   * one word when four are unprovable is a different problem from one that is a single word away
   * from being sendable, and only the full list tells them apart.
   */
  blockedTerms?: string[];
};

/**
 * RONDE 90 — the part of a cache key that is actually a search query.
 *
 * Three callers fold a request parameter into the string they hand the render-scoped query cache
 * — `${query}#n${perPage}` for Flickr and NARA, `${query}#${licence}#n${n}` for YouTube — because
 * replaying a 4-result payload for a later 12-result request would silently shrink the candidate
 * list. That suffix is a cache discriminator, never sent to any provider, and validating it as
 * content read "#creative_common#n5" as an unproven term and blocked a perfectly good query.
 *
 * `#` cannot occur in a query this pipeline builds, which is what makes it usable as the boundary.
 */
export function queryProper(query: string): string {
  const hash = query.indexOf("#");
  return hash === -1 ? query : query.slice(0, hash);
}

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
  const q = queryProper(query ?? "").trim();
  if (!q) return { ok: false, reason: "EMPTY_QUERY" };

  /**
   * RONDE 93 — punctuation SEPARATES words; it does not disappear inside them.
   *
   * The old form split on whitespace and then stripped punctuation from each piece, so
   * `title:(Winston` collapsed to the single token `titleWinston` — a word no script contains,
   * and every Archive.org field query was refused for it. Splitting on the punctuation instead
   * yields `title`, `Winston`, which is what the query actually says. The apostrophe and hyphen
   * stay inside a token, because "Churchill's" and "Marie-Curie" are one word each.
   */
  const words = q.split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean);

  // ── A. empty ── handled above.

  // ── B. a pronoun is never a legitimate search term, with or without a context.
  for (const w of words) {
    if (isPronounToken(w) && /^\p{Lu}/u.test(w)) {
      return { ok: false, reason: "FORBIDDEN_PRONOUN", offendingTerm: w, blockedTerms: [w] };
    }
  }
  if (!ctx) return { ok: true };

  // Everything the context proves, by stem, so "canals" in the query is proven by "canal".
  const proven = new Set<string>();
  const addProven = (term: string) => {
    for (const w of term.toLowerCase().split(/\s+/)) {
      const clean = w.replace(/[^\p{L}\p{N}'’-]/gu, "");
      if (!clean) continue;
      for (const form of evidenceStems(clean)) proven.add(form);
    }
  };
  for (const list of allTokenLists(ctx)) {
    for (const token of list) {
      if (token.verified) addProven(token.term);
    }
  }
  // ── C (evidence). The script's own words prove themselves. An extractor that failed to type
  // "canal" does not make the beat's mention of canals a guess.
  for (const w of (ctx.evidence ?? "").split(/[^\p{L}\p{N}'’-]+/u)) {
    if (w) addProven(w);
  }
  /**
   * ── C (topic). RONDE 160 — the words the USER typed prove themselves too.
   *
   * A person who asked for a documentary about WWII authorised the word "WWII", whether or not any
   * individual beat happens to spell it out. See `QueryTokenSource` for why this is the prompt and
   * never the title.
   */
  for (const w of (ctx.topic ?? "").split(/[^\p{L}\p{N}'’-]+/u)) {
    if (w) addProven(w);
  }

  const rejected = new Map<string, QueryTokenSource>();
  for (const list of [ctx.persons, ctx.places, ctx.countries, ctx.events, ctx.actions, ctx.objects]) {
    for (const token of list) {
      if (token.verified) continue;
      for (const w of token.term.toLowerCase().split(/\s+/)) rejected.set(w, token.source);
    }
  }

  // ── C/D/E. Every content word traceable; a term that IS traceable to a forbidden route is
  // named by that route rather than lumped in with the anonymous ones.
  const blocked: string[] = [];
  let firstReason: QueryRejectReason | undefined;
  let firstTerm: string | undefined;
  let contentWords = 0;
  for (const raw of words) {
    const w = raw.toLowerCase();
    if (isProductionWord(w) || isFunctionWord(w)) continue;
    contentWords++;
    if (evidenceStems(w).some((form) => proven.has(form))) continue;
    const source = rejected.get(w);
    const reason: QueryRejectReason =
      source === "title_inference" ? "TITLE_INFERENCE_NOT_ALLOWED"
        : source === "llm_generated" ? "LLM_GENERATED_TERM"
          : "UNVERIFIED_TERM";
    blocked.push(raw);
    if (!firstReason) {
      firstReason = reason;
      firstTerm = raw;
    }
  }
  if (firstReason) return { ok: false, reason: firstReason, offendingTerm: firstTerm, blockedTerms: blocked };

  // ── F. Ordering: a proven person must not appear after a proven place.
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
    return { ok: false, reason: "PERSON_AFTER_PLACE", offendingTerm: words[personAt], blockedTerms: [words[personAt]!] };
  }

  // ── G. A person the query names must be backed by evidence that actually contains that person.
  for (const person of ctx.persons) {
    if (!person.verified) continue;
    const head = person.term.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!head || !words.some((w) => w.toLowerCase() === head)) continue;
    if (!tokenEvidenceHolds(person)) {
      return { ok: false, reason: "PERSON_WITHOUT_EVIDENCE", offendingTerm: person.term, blockedTerms: [person.term] };
    }
  }

  // ── H. A query of nothing but camera vocabulary asks for "aerial footage" of the world in
  // general. It is not wrong about anything, which is exactly the problem: it has no subject.
  if (contentWords === 0) {
    return { ok: false, reason: "NO_CONTENT_ANCHOR", offendingTerm: q, blockedTerms: [] };
  }
  return { ok: true };
}

/**
 * RONDE 160 — WHY is this term allowed to be in a query?
 *
 * `validateSearchQuery` answers yes/no for a whole query. This answers, for one word, the question
 * an audit actually needs: which channel proved it, and what text is the receipt. The order below
 * is the order of authority — a term the beat itself uses is proven by the beat even if the topic
 * also happens to contain it, because the narrower claim is the stronger one.
 *
 *   term: "WWII"  ->  { provenance: "topic",     source: "video.prompt", approved: true  }
 *   term: "1942"  ->  { provenance: "beat_text", source: "beat.text",    approved: true  }
 *   term: "panzer" -> { provenance: "unknown",   source: null,           approved: false }
 */
export type TermProvenance = {
  term: string;
  provenance: QueryTokenSource;
  /** The field this came out of, for a human reading the log. Null when nothing proved it. */
  source: string | null;
  approved: boolean;
};

export function termProvenance(term: string, ctx: VerifiedQueryContext): TermProvenance {
  const raw = term.trim();
  const w = raw.toLowerCase().replace(/[^\p{L}\p{N}'’-]/gu, "");
  const deny = (): TermProvenance => ({ term: raw, provenance: "unknown", source: null, approved: false });
  if (!w) return deny();

  /** Camera and provider vocabulary is allowed without content evidence, and is never content. */
  if (isProductionWord(w)) {
    return { term: raw, provenance: "technical", source: "production_vocabulary", approved: true };
  }
  if (isFunctionWord(w)) {
    return { term: raw, provenance: "technical", source: "function_word", approved: true };
  }

  const stems = evidenceStems(w);
  const containsStem = (text: string | undefined): boolean => {
    if (!text) return false;
    for (const piece of text.split(/[^\p{L}\p{N}'’-]+/u)) {
      if (!piece) continue;
      const forms = evidenceStems(piece.toLowerCase());
      if (stems.some((s) => forms.includes(s))) return true;
    }
    return false;
  };

  /** A typed token the extractors proved — the most specific answer available. */
  for (const list of allTokenLists(ctx)) {
    for (const token of list) {
      if (!token.verified) continue;
      if (containsStem(token.term)) {
        return { term: raw, provenance: token.source, source: `${token.type}_token`, approved: true };
      }
    }
  }
  if (containsStem(ctx.evidence)) {
    return { term: raw, provenance: "beat_text", source: "beat.text/scene.text", approved: true };
  }
  if (containsStem(ctx.topic)) {
    return { term: raw, provenance: "topic", source: "video.prompt", approved: true };
  }

  /** Traceable to a route that is not allowed to introduce content — named, still refused. */
  for (const list of allTokenLists(ctx)) {
    for (const token of list) {
      if (token.verified) continue;
      if (containsStem(token.term)) {
        return { term: raw, provenance: token.source, source: null, approved: false };
      }
    }
  }
  return deny();
}

/** Every typed list of a context, in the mandated priority order. */
export function allTokenLists(ctx: VerifiedQueryContext): QueryToken[][] {
  return [ctx.persons, ctx.places, ctx.countries, ctx.events, ctx.actions, ctx.objects, ctx.time, ctx.years];
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

/**
 * RONDE 90 (§13) — one line per query decision, naming what was sent and what was refused.
 *
 * The two lines above answer "was this query allowed?". This one answers the question the round
 * is actually about: which terms did the pipeline believe it could prove, which could it not, and
 * on what grounds. A rejection that names one word hides how far the query was from sendable;
 * `blockedTerms` shows the whole gap.
 */
export function formatSearchQueryAudit(meta: {
  renderId?: string;
  sceneIndex?: number;
  beatIndex?: number;
  query: string;
  terms?: readonly string[];
  blockedTerms?: readonly string[];
  reason?: QueryRejectReason | LegacyRejectReason;
  verified: boolean;
  /**
   * RONDE 91 (§11) — did this query reach the provider, yes or no.
   *
   * `verified` says whether the contract could prove the query; `status` says what was DONE
   * about it. They are not the same field and conflating them made the log ambiguous in exactly
   * the case that matters: an unverified query is BLOCKED under strict mode and ALLOWED with
   * SEARCH_GATE_STRICT=false, and the line read identically either way.
   */
  status?: "ALLOWED" | "BLOCKED";
  route?: string;
  provider?: string;
}): string {
  return (
    `[SearchQueryAudit] render=${meta.renderId ?? "-"} scene=${meta.sceneIndex ?? "?"} ` +
    `beat=${meta.beatIndex ?? "?"} provider=${meta.provider ?? "-"} route=${meta.route ?? "-"} ` +
    `query="${meta.query}" status=${meta.status ?? (meta.verified ? "ALLOWED" : "BLOCKED")} ` +
    `verified=${meta.verified} ` +
    `terms=${JSON.stringify([...(meta.terms ?? [])])} ` +
    `blockedTerms=${JSON.stringify([...(meta.blockedTerms ?? [])])} ` +
    `reason=${meta.reason ?? (meta.verified ? "OK" : "UNVERIFIED_TERM")}`
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
 * RONDE 90 (§12) — the ONLY sanctioned answer to a refused query, and it is not a repair.
 *
 * Stripping the offending word out of a rejected query and sending the remainder is the silent
 * repair this round forbids: the result still carries the provenance of the query it was cut
 * down from, so it claims a proof it never had, and nothing downstream can tell it apart from a
 * query that was right the first time.
 *
 * This does the opposite. The rejected query is DISCARDED. A new query is built from the
 * context's verified tokens only, in the mandated priority order, with a NEW provenance object,
 * and it goes back through validateSearchQuery like any other. If the context proves nothing, the
 * answer is null — "no reliable query" is a correct outcome, not a failure to work around.
 */
export function rebuildFromVerifiedTokens(
  ctx: VerifiedQueryContext | undefined,
  meta: { route: string; renderId?: string; sceneIndex?: number; beatIndex?: number }
): VerifiedSearchQuery | null {
  if (!ctx) return null;
  for (const candidate of buildPrioritisedQueries(ctx)) {
    if (candidate.query === TECHNICAL_ARCHIVAL_TERM) continue;
    const minted = mintVerifiedQuery(candidate.query, ctx, meta);
    if (minted.verified) return minted;
  }
  return null;
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
 * RONDE 90 (§1): ON unless somebody explicitly turns it off. RONDE 89 shipped it OFF because
 * turning it on would have blocked every call site that could not supply a context — which was
 * all of them, because nothing minted a verified query anywhere in the pipeline. That is now
 * fixed at the source: the beat's proven context is ambient (withSearchProvenance), so the gate
 * can verify a query the caller passed as a bare string.
 *
 * The default matters more than the flag. A safety property that has to be switched on is a
 * safety property that is off in production, and "unproven content may not reach a provider" is
 * not a mode — it is the contract. `SEARCH_GATE_STRICT=false` remains, for one purpose only: to
 * measure what strict mode is blocking without having to ship a code change to find out.
 */
export function searchGateStrict(): boolean {
  return process.env.SEARCH_GATE_STRICT !== "false";
}

// ─── RONDE 90/91: the provenance scope and THE gate decision ─────────────────

/**
 * RONDE 90 (§2) — the beat's proven context, ambient for everything the beat fetches.
 *
 * RONDE 89 put every provider search behind one gate and then had to leave that gate permissive,
 * because a gate can only check a query against the context that produced it and no call site
 * could supply one. Threading a VerifiedQueryContext through the ~100 signatures between a beat
 * and a provider fetch would have been a refactor of the whole file, and a signature a caller can
 * forget to fill in is a gate a caller can forget to pass.
 *
 * The context is therefore scoped, not passed. Whoever begins sourcing a beat states what that
 * beat proves; every provider search inside that scope — however deep, through whichever of the
 * legacy query builders — is validated against it without knowing the scope exists. A search that
 * runs outside any beat scope has no proof behind it, which is the honest reading of a query
 * nobody can trace, and strict mode refuses it.
 *
 * AsyncLocalStorage rather than a field on RenderCtx: scenes are sourced concurrently within one
 * render, and a mutable per-render slot would let one beat's context validate another beat's
 * query — the exact class of cross-contamination this round exists to remove.
 */
const searchProvenanceStorage = new AsyncLocalStorage<VerifiedQueryContext>();

/** The proven context of the beat currently being sourced, or undefined outside any beat scope. */
export function getSearchProvenance(): VerifiedQueryContext | undefined {
  return searchProvenanceStorage.getStore();
}

/** Run `fn` with `ctx` as the ambient proof for every provider search it makes. */
export function withSearchProvenance<T>(ctx: VerifiedQueryContext | undefined, fn: () => T): T {
  return ctx ? searchProvenanceStorage.run(ctx, fn) : fn();
}

/**
 * The RENDER'S topic — `videos.prompt`, what the person typed — for the whole render.
 *
 * ── The production failure this closes ──────────────────────────────────────────────────────
 *
 * R160 built the `topic` evidence channel for one specific reported bug: a documentary whose whole
 * subject was WWII had "WWII archival footage" rejected with UNVERIFIED_TERM, because the beat's
 * own sentence did not contain the string "WWII". It added the field, the provenance rule and the
 * documentation — and then NO production call site ever supplied it. Zero. The channel existed and
 * carried nothing.
 *
 * The first real Railway render is the receipt: 101 of 157 queries BLOCKED, and "WWII" named in
 * `blockedTerms` eighteen times on a video about the July 20 plot, with the proven terms reading
 * `["Claus von Stauffenberg","Adolf Hitler","Berlin"]`. The people and the place were proven; the
 * era the person asked for was not.
 *
 * ── Why ambient rather than a parameter ─────────────────────────────────────────────────────
 *
 * `buildVerifiedQueryContextForBeat` is reached from helpers that take a bare string — typedQuery
 * Ladder, typedQueryLead, beatSearchProvenance, the celebrity fetcher — and those are called from
 * dozens of places that have no render object to thread. Adding a parameter to each is a wide
 * change with many chances to pass the wrong thing, and passing the wrong thing here is not a
 * cosmetic error: feeding it `videos.title` re-opens the exact hole RONDE 90 closed.
 *
 * So the topic is set ONCE, at the top of a render, by the one caller that legitimately holds the
 * prompt — the same reasoning `searchProvenanceStorage` above is built on, and the same mechanism.
 *
 * ── The rule this must never break ──────────────────────────────────────────────────────────
 *
 * `videos.prompt` ONLY. Not the title, not a summary, not any model output. The prompt is what the
 * person typed and is therefore the authorisation itself; a title is a claim the model made about
 * the video, and admitting it lets "Adolf Hitler France" be measured on a beat naming neither.
 * The parameter is deliberately named `videoPrompt` so a call site passing a title reads wrong.
 */
const renderTopicStorage = new AsyncLocalStorage<string>();

/** The current render's topic, or undefined outside any render scope. */
export function getRenderTopic(): string | undefined {
  const t = renderTopicStorage.getStore();
  return t && t.trim() ? t : undefined;
}

/**
 * Run `fn` with the user's prompt as the ambient topic for every query context built inside it.
 *
 * Pass `videos.prompt` and nothing else — see the note above on why a title must never reach this.
 */
export function withRenderTopic<T>(videoPrompt: string | null | undefined, fn: () => T): T {
  const topic = (videoPrompt ?? "").trim();
  return topic ? renderTopicStorage.run(topic, fn) : fn();
}

/**
 * RONDE 90 (§13) — should every ADMITTED query be logged, not only the refused ones?
 *
 * Off by default: a render asks providers thousands of questions and a line per question buries
 * the ones that matter. Refusals are always logged, because a refusal is the thing that changed
 * what the video shows. Turn this on to see the full decision trail.
 */
export function searchQueryAuditLogEnabled(): boolean {
  return process.env.SEARCH_QUERY_AUDIT_LOG === "true";
}

/**
 * RONDE 90 (§2/§18) — the one decision both entry points make, so they cannot drift apart.
 *
 * Three inputs decide the outcome, and only three:
 *
 *   · a VerifiedSearchQuery — the caller minted its own proof; it is taken at face value because
 *     `verified` can only have been set by mintVerifiedQuery agreeing with the validator.
 *   · a bare string INSIDE a beat's provenance scope — validated against what that beat actually
 *     proves. This is the case RONDE 89 could not handle and the reason strict mode had to stay
 *     off; it is now the common case.
 *   · a bare string outside any scope — nothing backs it, so strict mode refuses it. Not because
 *     the string looks wrong, but because nobody can say where it came from.
 *
 * There is deliberately no fourth outcome in which a refused query is trimmed and re-sent. §12:
 * rebuildFromVerifiedTokens builds a NEW query from proven tokens with new provenance, and it is
 * the caller's explicit choice to do so, never something that happens quietly inside the gate.
 */
export function searchGateDecision(
  provider: string,
  query: string | VerifiedSearchQuery,
  route: string
): { admitted: boolean; text: string } {
  const ambient = getSearchProvenance();
  const preVerified = isVerifiedSearchQuery(query) ? query : undefined;
  const text = String(preVerified ? preVerified.query : (query ?? ""));
  // A caller's own ticket already carries its proof; a bare string is judged against the beat it
  // is running inside. The proof comes from where the search happens, not from the string.
  const verdict = validateSearchQuery(text, preVerified ? undefined : ambient);
  const ticket: VerifiedSearchQuery =
    preVerified ??
    (ambient ? mintVerifiedQuery(text, ambient, { route }) : legacyQueryTicket(text, route));

  searchGateAudit.record("queriesBuilt", provider, ticket.route);

  const audit = (status: "ALLOWED" | "BLOCKED", reason?: string) =>
    formatSearchQueryAudit({
      query: text,
      provider,
      route: ticket.route,
      status,
      verified: ticket.verified,
      terms: ticket.tokens.filter((t) => t.verified).map((t) => t.term),
      blockedTerms: verdict.blockedTerms,
      reason: reason as never,
      sceneIndex: ticket.sceneIndex,
      beatIndex: ticket.beatIndex,
    });

  if (!verdict.ok) {
    searchGateAudit.record("queriesRejected", provider, ticket.route, verdict.reason);
    searchGateAudit.record("queriesBlocked", provider, ticket.route);
    console.warn(
      formatSearchQueryRejected({
        query: text, provider, route: ticket.route,
        reason: verdict.reason ?? "UNVERIFIED_TERM",
        offendingTerm: verdict.offendingTerm,
      })
    );
    console.warn(audit("BLOCKED", verdict.reason));
    return { admitted: false, text };
  }

  if (!ticket.verified) {
    searchGateAudit.record("bypassAttempts", provider, ticket.route, ticket.rejectReason);
    if (searchGateStrict()) {
      /**
       * RONDE 100B — count the reason once, on the counter that owns it.
       *
       * This passed the reason a second time, so one scope-less query bumped
       * LEGACY_QUERY_BUILDER twice. Production reported bypassAttempts=425 and
       * LEGACY_QUERY_BUILDER=850: the same 425 queries, counted double, which made the reason
       * look larger than UNVERIFIED_TERM (390) when it was in fact comparable.
       *
       * The validator branch above already gets this right — queriesRejected carries the reason,
       * queriesBlocked does not — and this now matches it. Deliberately done AFTER the scopes
       * that removed the bypasses themselves: halving a number is not fixing it.
       */
      searchGateAudit.record("queriesBlocked", provider, ticket.route);
      console.warn(audit("BLOCKED", ticket.rejectReason ?? "NO_SEARCH_CONTEXT"));
      return { admitted: false, text };
    }
  } else {
    searchGateAudit.record("queriesValidated", provider, ticket.route);
  }

  searchGateAudit.record("queriesSent", provider, ticket.route);
  if (searchQueryAuditLogEnabled()) console.log(audit("ALLOWED"));
  return { admitted: true, text };
}
