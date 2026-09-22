import { AsyncLocalStorage } from "node:async_hooks";
import { admitProviderForTier } from "./centralVisualSourcing";

import { foldSearchText } from "./searchTextNormalize";

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
/**
 * RONDE 214 — DUTCH GRAMMAR, BECAUSE THIS PIPELINE NARRATES IN DUTCH.
 *
 * ── What was measured ───────────────────────────────────────────────────────────────────────
 *
 * `FUNCTION_WORDS` was English-only, and said so. Everything that reads it therefore treated a
 * Dutch function word as a SUBJECT. RONDE 213 turned that from a quiet inaccuracy into a broken
 * query, because it caps a beat at its first four content words:
 *
 *     "Het was een van de grootste rampen uit de Nederlandse geschiedenis."
 *         → "Het een van de"        four grammar words, nothing to search for
 *     "De eerste bewoners van het eiland bouwden hun huizen op palen in het veen."
 *         → "De eerste bewoners van"    two of four slots spent on grammar
 *
 * `hasContentAnchor` could not catch it either: "het", "een", "van" and "de" are in neither the
 * English function set nor the production vocabulary, so the query read as having a subject and
 * went out to the providers.
 *
 * ── Why it goes here and not in a second list ───────────────────────────────────────────────
 *
 * Function words are a closed grammatical class PER LANGUAGE. This set is that class; it was
 * simply missing a language the product actually speaks. A separate Dutch stoplist beside it would
 * be two spellings of one rule — and `visualBeatTags`'s LABEL_STOP already is a third, which is
 * how this went unnoticed: the Dutch words were known in one corner of the codebase and absent in
 * the one the gate reads.
 *
 * ── Checked against every consumer before adding ────────────────────────────────────────────
 *
 *   `blocksPersonName`     — the name particles ("de", "van", "den", "der", "ten", "ter") are
 *                            matched by `isNameParticleToken` and `continue`d BEFORE this is
 *                            reached, so "Vincent van Gogh" and "Charles de Gaulle" are unaffected.
 *                            Every other word added here is lower case and already failed
 *                            `isNameShapedToken`; only the stated reason changes.
 *   `hasContentAnchor`     — Dutch-grammar-only queries are now refused. A tightening.
 *   `provenToken`          — they become "technical" and need no evidence, exactly as their
 *                            English counterparts do. A word that carries no claim cannot
 *                            introduce content.
 *   person extraction      — a Dutch function word is not a person. Correct to skip.
 *
 * `FORBIDDEN_PERSON_PRONOUNS` is deliberately NOT extended: that set drives an outright query
 * REJECTION, and widening a rejection is a bigger change than this evidence supports.
 *
 * Like English "will" and "may", a few of these have a content sense ("haar" is also hair, "zijn"
 * also a verb). The closed grammatical class wins, as it already does for English.
 */
export const DUTCH_FUNCTION_WORDS: readonly string[] = [
  "de", "het", "een", "der", "des", "den", "ten", "ter",
  "en", "of", "maar", "want", "dus", "omdat", "als", "dan", "toen", "terwijl", "hoewel", "zodat",
  "van", "in", "op", "aan", "bij", "met", "voor", "naar", "uit", "over", "onder", "tussen",
  "door", "tegen", "tot", "om", "na", "sinds", "zonder", "binnen", "buiten", "langs", "tijdens",
  "dat", "die", "dit", "deze", "er", "hier", "daar", "wat", "wie", "welke", "zulke",
  "ik", "jij", "hij", "zij", "wij", "jullie", "ze", "hem", "haar", "hun", "men", "u",
  "is", "zijn", "was", "waren", "ben", "bent", "worden", "wordt", "werd", "werden",
  "heeft", "hebben", "had", "hadden", "heb", "zal", "zou", "zouden",
  "kan", "kunnen", "kon", "konden", "moet", "moeten", "moest", "mag", "mogen",
  "wil", "willen", "doen", "doet", "deed",
  "niet", "ook", "al", "nog", "wel", "te", "toch", "alleen", "zelfs", "heel", "zeer",
  "meer", "meest", "echter", "daarom", "elke", "iedere", "sommige", "veel", "andere",
  "zo", "geen", "zich", "waar", "hoe", "waarom", "iets", "niets", "alles",
  "elk", "ieder", "eigen", "beide",
  /**
   * Deliberately NOT here: "weer". It is an adverb ("again") and a noun ("the weather"), and a
   * documentary about a flood or a climate is exactly where the noun carries the subject. English
   * "own" and "will" are admitted despite the same ambiguity because their content senses are
   * marginal in narration; "het weer" is not.
   */
];

export const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  ...FORBIDDEN_PERSON_PRONOUNS,
  ...DUTCH_FUNCTION_WORDS,
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
 * THE WORDS THAT NAME NOTHING YOU COULD PHOTOGRAPH.
 *
 * ── The query that put a Brink's van in a film about 1945 ────────────────────────────────────
 *
 * Render 578's opening sentence is "Standing on the brink of utter defeat, his empire crumbling",
 * and its own trace records what it asked an image provider for:
 *
 *     [AssetTrace] provider=openverse scene=0 beat=2 query="standing brink"
 *                  sourceUrl=https://live.staticflickr.com/8314/7941253338_802399d09d_b.jpg
 *
 * A Flickr photograph of a BRINK'S armoured security truck. The query was not wrong about the
 * narration — those two words are in it. It was wrong about pictures: neither word names a thing
 * a camera can be pointed at, so the only handle the provider had was a brand name.
 *
 * ── Why this belongs beside PRODUCTION_VOCABULARY and not in a new mechanism ─────────────────
 *
 * That set already answers half of this question. "documentary" and "establishing" describe the
 * FILM rather than its subject, and `hasContentAnchor` refuses a query built only from them —
 * render 578 had `documentary` ×88 and `establishing` ×80 refused on exactly that ground, without
 * emptying anything. The words below describe the MEANING rather than its subject, which fails the
 * same question for the same reason and had no answer at all: `hasContentAnchor("standing brink")`
 * returned true, and so did `validateSearchQuery`.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────────────────────
 *
 * Anything a camera can be pointed at, however grim or abstract it sounds: `war`, `bunker`,
 * `funeral`, `grave`, `cyanide`, `pistol`, `rubble`, `surrender`, `military`, `street`, `crowd`.
 * Every one of those returns real pictures of a real thing, and blocking them would empty films
 * to no purpose — the failure this codebase has paid for before. The test for membership is not
 * "is the word gloomy" or "is it abstract-sounding" but "would an image provider have to guess
 * what to show me". Nothing here is specific to a subject or an era; it is ordinary English.
 *
 * A word here is not forbidden — it is simply not an ANCHOR. "brink of war" still searches,
 * because `war` is a thing; "standing brink" no longer does, because nothing in it is.
 */
export const ABSTRACTION_VOCABULARY: ReadonlySet<string> = new Set([
  // States of affairs and outcomes — real, and not photographable.
  "brink", "defeat", "victory", "triumph", "downfall", "collapse", "doom", "fate", "destiny",
  "outcome", "consequence", "result", "impact", "influence", "legacy", "aftermath",
  // Inner life.
  "pride", "shame", "guilt", "honour", "honor", "glory", "courage", "fear", "hope", "despair",
  "ambition", "obsession", "madness", "genius", "betrayal", "loyalty", "desperation",
  // Ideas about ideas.
  "meaning", "reason", "purpose", "cause", "truth", "mystery", "secret", "decision", "choice",
  "importance", "significance", "existence", "power", "authority", "control", "freedom",
  "liberty", "justice", "evil", "chaos", "order",
  // Time and position in a story, which every narration is full of and no picture contains.
  "moment", "era", "epoch", "period", "beginning", "ending", "opening", "closing", "start",
  "finish", "rise", "fall", "end", "future", "past", "present", "history", "death", "life",
  // Participles and adjectives that qualify a subject without being one.
  "standing", "sitting", "lying", "walking", "running", "holding", "facing", "waiting",
  "crumbling", "shattered", "haunted", "unavoidable", "utter", "final", "ultimate",
  "unimaginable", "unthinkable", "steadfast", "formidable", "secluded", "dim", "sheer",
]);

/** A word that qualifies or interprets a subject, but cannot BE one. See the set's own note. */
export function isAbstractionWord(token: string): boolean {
  return ABSTRACTION_VOCABULARY.has(token.trim().toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, ""));
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
 *
 * ── RONDE 88A: "the same word" has to survive an umlaut ─────────────────────────────────────
 *
 * Render 568 refused six queries for the term `fuhrerbunker`. The script says "Führerbunker" —
 * `scriptVisualKeywords`, `curatedMediaSourcing`, `mediaResearchEngine` and `scriptGuidedClipFinder`
 * all run their text through `foldSearchText` first, because `ü` is a letter and an English-language
 * archive spells it `u`. This function did not fold, so the folded query token `fuhrerbunker` was
 * compared against the unfolded evidence `führerbunker`, matched nothing, and the gate reported
 * UNVERIFIED_TERM about a word the beat actually contains.
 *
 * That is the failure mode this module was built to prevent, arriving from the other side: not a
 * guess accepted, but the script's own word refused. Folding here makes the comparison symmetric —
 * `führerbunker`, `Fuhrerbunker` and `fuhrerbunker` are one word, and every one of them still has
 * to be IN the evidence to be proven. Nothing becomes allowed that the script does not say.
 */
/**
 * THE SHORTEST PART OF A COMPOUND THAT STILL MEANS SOMETHING.
 *
 * Five, so `bunker` (6) and `fuhrer` (6) qualify and `ear`, `art`, `war` do not. Both halves must
 * clear it, which is what makes this a compound rule rather than a substring rule.
 */
const COMPOUND_MIN_PART = 5;

/**
 * DOES A WORD THE SCRIPT ACTUALLY SAYS PROVE THIS QUERY TERM AS ONE OF ITS PARTS?
 *
 * ── The refusal this answers ────────────────────────────────────────────────────────────────
 *
 * Render 597, twice:
 *
 *     [SearchQueryRejected] query="hitler bunker"                term="bunker" UNVERIFIED_TERM
 *     [SearchQueryRejected] query="fuhrer historical photograph" term="fuhrer" UNVERIFIED_TERM
 *
 * The narration says "Führerbunker". Folded, the evidence holds `fuhrerbunker`; the query holds
 * `bunker` and `fuhrer`. `evidenceStems` compares WHOLE WORDS and strips suffixes, so a German
 * compound proves neither of the two words it is made of — and the contextual query collapses to
 * `Adolf`, which is what put a baby on a chair in front of the picture editor.
 *
 * This is RONDE 568's failure from one level down. That round made `führerbunker` and
 * `fuhrerbunker` one word; this makes `Führerbunker` prove the words it contains.
 *
 * ── Why this cannot become a sieve ──────────────────────────────────────────────────────────
 *
 * ONE DIRECTION ONLY. The evidence word must be LONGER than the term, so `Führerbunker` in the
 * script proves `bunker` in a query and `bunker` in the script proves nothing about
 * `Führerbunker`. That asymmetry is the whole safety property: a query may never be broader than
 * the script.
 *
 * ON COMPOUND BOUNDARIES, not anywhere. The term must sit at the START or the END of the evidence
 * word, and the REMAINDER must itself be a meaningful length. `research` therefore proves nothing:
 * the leftover after `research` is `er`, two letters. An arbitrary-substring rule would have let
 * `research` prove `ear` and this module would stop being a gate.
 *
 * FROM THE SAME EVIDENCE AS BEFORE. The caller passes the words it already proved — narration,
 * scene, verified entities, the user's own prompt. No new source is admitted. Nothing becomes
 * allowed that the script does not say; what changes is that the script saying it as part of a
 * compound now counts as saying it.
 *
 * Returns the evidence word that did the proving, so the decision can be logged rather than felt.
 */
export function compoundEvidenceFor(
  term: string,
  evidenceWords: Iterable<string>
): string | null {
  const t = foldSearchText(term.trim()).replace(/[^\p{L}\p{N}'-]/gu, "");
  if (t.length < COMPOUND_MIN_PART) return null;
  for (const word of evidenceWords) {
    if (word.length <= t.length) continue;
    const rest = word.startsWith(t)
      ? word.slice(t.length)
      : word.endsWith(t)
        ? word.slice(0, word.length - t.length)
        : null;
    if (rest != null && rest.length >= COMPOUND_MIN_PART) return word;
  }
  return null;
}

export function evidenceStems(word: string): string[] {
  const w = foldSearchText(word.trim()).replace(/[^\p{L}\p{N}'-]/gu, "");
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

/**
 * RONDE 97 §1 — THE PLANNER'S HALF OF THE INTENT, WHICH THE CONTEXT DOES NOT CARRY.
 *
 * `VerifiedQueryContext` holds everything the EXTRACTORS proved: persons, places, events, actions,
 * objects, time. The builder below has always used all of it, so eight of the intent's ten fields
 * already reached query generation.
 *
 * The two that did not are the two the planner supplies rather than the extractors: what the beat
 * MUST contain, and the shot it was planned for. Passed as a structural shape rather than as
 * `BeatVisualIntent` so this module keeps its direction of dependency — `beatVisualIntent` imports
 * from here, and importing back would be a cycle.
 */
export type QueryIntentHints = {
  /** The planner's hard requirement. A query naming it answers the beat more exactly. */
  subject?: string;
  /** The framing this beat was planned for — camera vocabulary, and only ever an addition. */
  preferredShot?: string;
};

/** Shot vocabulary the archive providers actually index, keyed by the planner's shot names. */
const SHOT_VOCABULARY: Readonly<Record<string, string>> = {
  establishing: "establishing shot",
  extreme_wide: "wide shot",
  wide: "wide shot",
  medium_wide: "",
  medium: "",
  close_up: "close up",
  extreme_close_up: "close up",
  detail: "detail",
  overhead: "overhead",
  aerial: "aerial",
  pov: "",
  reaction: "",
  cutaway: "",
  b_roll: "",
  archive_footage: "archival footage",
  overlay_shot: "",
};

export function buildPrioritisedQueries(
  ctx: VerifiedQueryContext,
  intent?: QueryIntentHints
): PrioritisedQuery[] {
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

  /** RONDE 97 §1 — the planner's two fields, applied last. See `applyIntentHints`. */
  return applyIntentHints(out, intent);
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
/**
 * RONDE 97 §1 — the planner's two fields, applied to a finished query list.
 *
 * Two effects, both additive, and neither able to introduce content:
 *
 *   · A query naming the planner's `mustContain` subject is moved to the front. The planner
 *     stating a hard requirement is a stronger claim than an extractor reporting a word, and the
 *     bounded shortlist means the order queries run in decides what is ever seen.
 *   · The planned shot becomes camera vocabulary APPENDED to the strongest query that already has
 *     a content anchor — never a query of its own. RONDE 95 established that camera vocabulary
 *     with no subject is `NO_CONTENT_ANCHOR`, and this cannot produce one: it only ever extends a
 *     query that already passed.
 */
function applyIntentHints(
  queries: PrioritisedQuery[],
  intent: QueryIntentHints | undefined
): PrioritisedQuery[] {
  if (!intent || queries.length === 0) return queries;

  let out = queries;
  const subject = foldSearchText(intent.subject ?? "");
  if (subject) {
    const names = (q: PrioritisedQuery) => foldSearchText(q.query).includes(subject);
    out = [...out.filter(names), ...out.filter((q) => !names(q))];
  }

  const vocab = SHOT_VOCABULARY[(intent.preferredShot ?? "").trim().toLowerCase()] ?? "";
  const lead = out[0];
  if (vocab && lead && hasContentAnchor(lead.query) && !foldSearchText(lead.query).includes(foldSearchText(vocab))) {
    const extended: PrioritisedQuery = {
      ...lead,
      query: `${lead.query} ${vocab}`.replace(/\s+/g, " ").trim(),
      priority: 0,
    };
    /** Added, never substituted: the un-extended query stays available behind it. */
    out = [extended, ...out];
  }

  return out.map((q, i) => ({ ...q, priority: i + 1 }));
}

export function buildBeatSearchLadder(
  ctx: VerifiedQueryContext,
  intent?: QueryIntentHints
): Array<{ level: 1 | 2 | 3 | 4; queries: PrioritisedQuery[] }> {
  const all = buildPrioritisedQueries(ctx, intent);
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
 * RONDE 88A P4 — does this query ask for anything, or only for a way of filming it?
 *
 * ── What render 568 measured ────────────────────────────────────────────────────────────────
 *
 *     reason=NO_CONTENT_ANCHOR   documentary ×68   establishing ×40   historical ×20
 *
 * 128 queries built, gated and thrown away. The gate was right every time — "documentary" names a
 * genre, not a subject, and "wide establishing aerial" is a camera instruction with nothing to
 * point the camera at. What the gate cannot do is stop them being BUILT, and a builder that
 * produces 128 unsendable queries has spent the render's time on all of them.
 *
 * This is check H, lifted out so a generator can ask the same question BEFORE it builds. Not a
 * second rulebook: `validateSearchQuery` now calls this function for check H, so there is exactly
 * one definition of "has a subject" and the generator and the gate cannot drift apart.
 *
 * It answers about the query's WORDS only. Whether those words are PROVEN is a different question,
 * needs the beat's context, and stays where it is.
 */
export function hasContentAnchor(query: string): boolean {
  const q = queryProper(query ?? "").trim();
  if (!q) return false;
  return q
    .split(/[^\p{L}\p{N}'’-]+/u)
    .filter(Boolean)
    .some((raw) => {
      /**
       * RONDE 213 — a token of pure punctuation is not a subject.
       *
       * The split keeps the apostrophe and the hyphen INSIDE a token, so "Churchill's" and
       * "Marie-Curie" survive as one word each. The cost was that `"---"` survived as one word
       * too, `foldSearchText` handed it back unchanged, and this answered TRUE: the gate's own
       * subject check said a row of hyphens asks for something. `validateSearchQuery("---")`
       * returned `ok` on the strength of it.
       *
       * This narrows what passes — a direction the brief permits, and the only honest reading of
       * the question this function asks. A query with no letter and no digit anywhere in it names
       * nothing that any provider could return.
       */
      if (!/[\p{L}\p{N}]/u.test(raw)) return false;
      const w = foldSearchText(raw);
      /**
       * `isAbstractionWord` is the third of the same question, added after render 578 asked
       * Openverse for "standing brink" and was handed a Brink's armoured truck. A word that names
       * the film, a word that joins a sentence together, and a word that names a meaning rather
       * than a thing all fail to point a camera at anything. See ABSTRACTION_VOCABULARY.
       */
      return Boolean(w) && !isProductionWord(w) && !isFunctionWord(w) && !isAbstractionWord(w);
    });
}

/**
 * RONDE 213 — A SENTENCE IS NOT A SEARCH QUERY.
 *
 * ── What was being sent ─────────────────────────────────────────────────────────────────────
 *
 * `visualSearchPlan` built its highest-confidence query as `beatText.slice(0, 80)`, and the
 * Wikimedia rescue appended the same thing. Measured on three ordinary narration sentences from
 * three unrelated subjects, all three produced a whole sentence cut mid-word:
 *
 *     "In the winter of 1953 the North Sea broke through the dikes and drowned more tha"
 *     "The factory floor fell silent for the first time in forty years, and the town un"
 *     "Researchers had been measuring the glacier since 1912, but nobody expected the r"
 *
 * And `validateSearchQuery` answered `ok: true` for them, correctly: without a proven context it
 * can only ask whether a query contains a pronoun and whether it contains any subject at all, and
 * a sentence contains plenty of subjects. The gate was never the problem. The gate is not being
 * changed. What produced these was the builder, and that is what this repairs.
 *
 * ── What this does, and the line it does not cross ──────────────────────────────────────────
 *
 * It only ever REMOVES. The words come out in the order the sentence said them, so the result is
 * a SUBSEQUENCE of the narration: nothing invented, nothing reordered, no term the script did not
 * say. That is what keeps it on the right side of R91 §3 — a builder may not introduce content —
 * and it is why this is not a second query generator.
 *
 * Only function words are dropped. They are a closed grammatical class carrying no subject, which
 * is exactly why FUNCTION_WORDS exists and why it is safe to strip by. PRODUCTION_VOCABULARY is
 * deliberately NOT used here: that set says which words need no evidence, not which words carry no
 * meaning, and stripping by it would delete "black" from a black market and "period" from a period
 * of famine.
 *
 * Cutting on whole words makes "more tha" structurally impossible rather than merely unlikely.
 *
 * ── Why it can return nothing ───────────────────────────────────────────────────────────────
 *
 * A sentence whose remaining words are all production vocabulary ("the archival footage was
 * restored") describes the film and names no subject. `hasContentAnchor` — the same helper the
 * gate uses, so the two cannot drift — refuses it, and the honest answer is an empty string. The
 * caller must then emit NO query, not fall back to the raw sentence: that fallback is the defect.
 */
export function contentTermsFromText(text: string, maxTerms = 4): string {
  if (maxTerms <= 0) return "";
  const words = queryProper(text ?? "")
    .split(/[^\p{L}\p{N}'’-]+/u)
    .filter(Boolean);
  const kept: string[] = [];
  for (const w of words) {
    /** Same rule as `hasContentAnchor`: a token with no letter and no digit is not a term. */
    if (!/[\p{L}\p{N}]/u.test(w)) continue;
    if (isFunctionWord(w)) continue;
    kept.push(w);
    if (kept.length >= maxTerms) break;
  }
  const query = kept.join(" ");
  return hasContentAnchor(query) ? query : "";
}

/**
 * THE BEAT'S TYPED TERMS, IN THE ORDER A PICTURE NEEDS THEM.
 *
 * ── What render 577 measured ────────────────────────────────────────────────────────────────
 *
 *     ALLOWED : "shaped"×11  "life"×10  "evidence"×10  "instructions"×9
 *     BLOCKED : "establishing"×32 "documentary"×30 "funeral"×14 "corpse"×14 "bunker"×4
 *
 * The allowed column is not a list of things a viewer can be shown. It is the first four
 * non-function words of a sentence, which is exactly what `contentTermsFromText` returns: it
 * walks the narration in READING order and keeps what it finds. On "The instructions shaped the
 * final hours of life" that is "instructions shaped final hours" — a grammatical fact about the
 * sentence and a query no archive can answer.
 *
 * The primary builder never had this problem. `buildPrioritisedQueries` works from the beat's
 * TYPED tokens — persons, places, events, objects, times — which is a model of what the beat is
 * about rather than of how its sentence is ordered. This gives the FALLBACK the same source, so
 * the two no longer mean different things by "the beat's own words".
 *
 * ── Why this cannot loosen the gate ─────────────────────────────────────────────────────────
 *
 * Every term is put through `termProvableFrom` against the same evidence the gate checks — so a
 * term this returns is a term `validateSearchQuery` was always going to accept. It can only ever
 * return a SUBSET of what was already allowed, reordered. A planner term with no evidence behind
 * it ("Führerbunker" on a beat that says only "Hitler was in Berlin") is dropped here exactly as
 * the gate would drop it, and dropping it here saves the render the round trip.
 *
 * That is also why this is not a second query generator: it introduces no word that the beat did
 * not already prove, and it decides nothing about admission.
 *
 * ── The order ───────────────────────────────────────────────────────────────────────────────
 *
 * `subject` first because it is what a person would say the beat is ABOUT. Then people, event,
 * location, period, objects — nouns that narrow an archive, strongest first. `action` last: a
 * verb rarely narrows a search and often widens it, which is how "shaped" became a query in the
 * first place.
 *
 * Structurally typed rather than importing `BeatVisualIntent`, because that module imports this
 * one and the dependency may not run both ways.
 */
export function visualTermsFromIntent(
  intent:
    | {
        subject?: string;
        people?: readonly string[];
        event?: readonly string[];
        location?: readonly string[];
        period?: readonly string[];
        objects?: readonly string[];
        action?: readonly string[];
        forbidden?: readonly string[];
      }
    | null
    | undefined,
  sourceText: string,
  maxTerms = 4
): string {
  if (!intent || maxTerms <= 0) return "";
  const forbidden = new Set(
    (intent.forbidden ?? []).map((t) => foldSearchText(t)).filter(Boolean)
  );
  const ordered = [
    ...(intent.subject ? [intent.subject] : []),
    ...(intent.people ?? []),
    ...(intent.event ?? []),
    ...(intent.location ?? []),
    ...(intent.period ?? []),
    ...(intent.objects ?? []),
    ...(intent.action ?? []),
  ];
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of ordered) {
    const term = queryProper(raw ?? "").trim();
    if (!term) continue;
    const folded = foldSearchText(term);
    if (!folded || seen.has(folded) || forbidden.has(folded)) continue;
    /** The gate's own measure, so this can only ever narrow what was already allowed. */
    if (!termProvableFrom(term, sourceText)) continue;
    seen.add(folded);
    kept.push(term);
    if (kept.length >= maxTerms) break;
  }
  const query = kept.join(" ");
  return hasContentAnchor(query) ? query : "";
}

/**
 * RONDE 216 — ASK BEFORE YOU BUILD, WITH THE GATE'S OWN MEASURE.
 *
 * ── What render 575 measured ────────────────────────────────────────────────────────────────
 *
 *     query="germany" status=BLOCKED blockedTerms=["germany"] reason=UNVERIFIED_TERM
 *     terms=["General Georgy Zhukov","General George","Adolf Hitler","Berlin","German"]
 *
 * 104 times. The script says "German"; a hardcoded anchor table turns that into "Germany", and
 * "Germany" is a word the script never said. The gate refuses it — correctly, and this round does
 * not touch that. What it stops is the BUILDING: a table that emits a term its own source cannot
 * support has spent the render's clock on a query that could only be thrown away, which is RONDE
 * 88 §P4's finding in a second table.
 *
 * The tempting wrong fix was a looser stemmer, so that "German" would prove "germany". That would
 * open the gate rather than fix the builder, and it would let "arm" prove "army" — a different
 * word, and exactly the kind of false match the evidence rule exists to stop.
 *
 * ── The measure ─────────────────────────────────────────────────────────────────────────────
 *
 * The same one `validateSearchQuery` applies: every CONTENT word must be traceable to the source
 * by stem. Function words and production vocabulary are exempt here for the same reason they are
 * exempt there — they carry no claim. An anchor with nothing but those in it is not provable by
 * anything and is refused; `hasContentAnchor` says why.
 */
export function termProvableFrom(term: string, sourceText: string): boolean {
  const q = queryProper(term ?? "").trim();
  if (!q || !hasContentAnchor(q)) return false;
  const sourceStems = new Set<string>();
  for (const raw of (sourceText ?? "").split(/[^\p{L}\p{N}'’-]+/u)) {
    if (!raw) continue;
    for (const stem of evidenceStems(raw)) sourceStems.add(stem);
  }
  if (sourceStems.size === 0) return false;
  for (const raw of q.split(/[^\p{L}\p{N}'’-]+/u)) {
    if (!raw) continue;
    const w = foldSearchText(raw);
    if (!w || isFunctionWord(w) || isProductionWord(w)) continue;
    if (!evidenceStems(raw).some((stem) => sourceStems.has(stem))) return false;
  }
  return true;
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
  /**
   * ── H (hoisted). A query with no subject is wrong on its own terms, context or no context.
   *
   * RONDE 95 — this rule used to live at the bottom of the function, below the context-less early
   * return, so a caller that could prove nothing had `"documentary"`, `"historical footage"` and
   * `"documentary wide establishing aerial"` accepted as valid searches. Measured, not assumed:
   * the anchor helper already answered false for `"documentary"` while this function answered
   * `{ ok: true }` for it, and the two disagreeing is precisely the shape of the render-568
   * queries this contract exists to stop.
   *
   * It belongs above the early return because it needs no context at all: it asks whether the
   * query's own words contain anything but production vocabulary and function words. The comment
   * on the early return says the validator can then apply only "the checks that need none" — this
   * is one of them, and leaving it below was an ordering accident rather than a decision.
   *
   * The rule itself is unchanged and still delegates to the one helper, so the generator-side
   * check and the gate-side check remain a single definition. What changes is that a caller
   * without a proven context can no longer be given a pass it never earned.
   */
  if (!hasContentAnchor(q)) {
    return { ok: false, reason: "NO_CONTENT_ANCHOR", offendingTerm: q, blockedTerms: [] };
  }

  if (!ctx) return { ok: true };

  // Everything the context proves, by stem, so "canals" in the query is proven by "canal".
  const proven = new Set<string>();
  /**
   * The same evidence, kept as WHOLE FOLDED WORDS rather than stems.
   *
   * `proven` holds stems, and a stem cannot answer "is this term one of my parts" — `fuhrerbunker`
   * and `bunker` are two different stems. `compoundEvidenceFor` needs the intact word. Same
   * source, same moment, no second registry: every word written here was written to `proven` on
   * the line above it.
   */
  const provenWords = new Set<string>();
  const addProven = (term: string) => {
    for (const w of term.toLowerCase().split(/\s+/)) {
      const clean = w.replace(/[^\p{L}\p{N}'’-]/gu, "");
      if (!clean) continue;
      for (const form of evidenceStems(clean)) proven.add(form);
      const folded = foldSearchText(clean).replace(/[^\p{L}\p{N}'-]/gu, "");
      if (folded) provenWords.add(folded);
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
      // Folded, because the lookup below is folded — an unfolded key would silently mislabel a
      // refused LLM term as an anonymous UNVERIFIED_TERM, hiding WHO guessed it.
      for (const w of foldSearchText(token.term).split(/\s+/)) rejected.set(w, token.source);
    }
  }

  // ── C/D/E. Every content word traceable; a term that IS traceable to a forbidden route is
  // named by that route rather than lumped in with the anonymous ones.
  const blocked: string[] = [];
  let firstReason: QueryRejectReason | undefined;
  let firstTerm: string | undefined;
  /**
   * Terms admitted only because a compound in the script contains them, and the word that did it.
   *
   * Collected rather than waved through, because two rules below need to see the whole query
   * before any of them may be trusted — see `compoundAdmissionRefusal`.
   */
  const compoundAdmitted = new Map<string, { raw: string; evidence: string }>();
  /** Content words the evidence proved OUTRIGHT. A compound part may add to these, never replace them. */
  let wholeProvenCount = 0;
  for (const raw of words) {
    const w = foldSearchText(raw);
    if (isProductionWord(w) || isFunctionWord(w)) continue;
    if (evidenceStems(w).some((form) => proven.has(form))) {
      wholeProvenCount += 1;
      continue;
    }
    /**
     * AND THE SCRIPT'S OWN COMPOUNDS PROVE THE WORDS THEY ARE MADE OF — see `compoundEvidenceFor`.
     *
     * Tried only AFTER the whole-word test, so it changes nothing for a term the evidence already
     * proved outright. Admission is PROVISIONAL: the two rules after the loop can still refuse it,
     * because whether a compound part is a legitimate refinement depends on what else is in the
     * query, and that is not knowable one word at a time.
     */
    const compound = compoundEvidenceFor(w, provenWords);
    if (compound) {
      compoundAdmitted.set(w, { raw, evidence: compound });
      continue;
    }
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

  /**
   * ── E2. THE TWO WAYS A COMPOUND PART IS NOT A REFINEMENT.
   *
   * `compoundEvidenceFor` answers "does the script contain this word inside another one". That is
   * necessary and not sufficient, and two existing tests said so before this rule existed:
   *
   *     searchTextIsFolded            "still refuses a fragment of a compound the script does say"
   *     historicalEntityAndPreflight  refuses the fragment "fuhrer bunker Berlin"
   *
   * Both were RIGHT, and a first version of this rule broke them. They are kept, and what they
   * protect is now stated rather than implied:
   *
   * 1. A COMPOUND PART MAY NOT STAND ALONE. `bunker` as the whole query fetches golf bunkers and
   *    Cold War bunkers; the script said `Führerbunker`, which is a place. A part narrows a query
   *    that some outright-proven word already anchors — it may never BE the anchor.
   *
   * 2. TWO PARTS OF ONE COMPOUND IS A SPLIT, NOT A QUERY. `fuhrer bunker` is `Führerbunker` cut in
   *    half with a space, which is the same family as the ASCII-truncation artefact `hrebunker`
   *    that RONDE 568 caught. A query that takes both halves has not added context; it has
   *    damaged a word.
   *
   * What survives is the case render 597 actually lost: `hitler bunker`, where `hitler` is proven
   * outright and `bunker` narrows it. That query was refused, the beat fell back to `Adolf`, and a
   * baby on an upholstered chair was offered to the picture editor.
   */
  const compoundRefusal = ((): { term: string; why: string } | null => {
    if (compoundAdmitted.size === 0) return null;
    const first = [...compoundAdmitted.values()][0]!;
    if (wholeProvenCount === 0) {
      return { term: first.raw, why: "a compound part cannot be the query's only content word" };
    }
    const byEvidence = new Map<string, string[]>();
    for (const { raw, evidence } of compoundAdmitted.values()) {
      byEvidence.set(evidence, [...(byEvidence.get(evidence) ?? []), raw]);
    }
    for (const [evidence, terms] of byEvidence) {
      if (terms.length > 1) {
        return {
          term: terms[0]!,
          why: `"${terms.join('" and "')}" are both parts of "${evidence}" — that is the word split, not a query`,
        };
      }
    }
    return null;
  })();
  if (compoundRefusal) {
    return {
      ok: false,
      reason: "UNVERIFIED_TERM",
      offendingTerm: compoundRefusal.term,
      blockedTerms: [compoundRefusal.term],
    };
  }
  for (const { raw, evidence } of compoundAdmitted.values()) {
    console.log(
      `[QueryTermProvenByCompound] term="${raw}" provenBy="${evidence}" — the script says the ` +
        "compound, so the part it is built from is not a guess"
    );
  }

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
  //
  // RONDE 88A P4: the rule lives in the exported anchor helper, so a generator can ask it BEFORE
  // building a query the gate would only throw away. Delegated rather than duplicated — one
  // definition of "has a subject", which is what stops the generator-side check becoming a lie.
  //
  // RONDE 95 moved the check itself above the context-less early return, since it needs no
  // context; a query reaching this line has already passed it. Re-testing here would be a second
  // implementation of the same question, which is what this file's own history warns about.
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

/**
 * RONDE 88A P3 — `render= scene= beat=`, filled from the ambient scope when the caller gives none.
 *
 * One helper for all three lines, so they cannot drift into disagreeing about which render they
 * are describing. See `withQueryScope` for why the default lives here and not at the call sites.
 */
function scopeFields(meta: { renderId?: string; sceneIndex?: number; beatIndex?: number }): string {
  const scope = getQueryScope();
  const render = meta.renderId ?? (scope.videoId != null ? String(scope.videoId) : undefined);
  const scene = meta.sceneIndex ?? scope.sceneIndex;
  const beat = meta.beatIndex ?? scope.beatIndex;
  return `render=${render ?? "-"} scene=${scene ?? "?"} beat=${beat ?? "?"}`;
}

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
    `[SearchQuery] ${scopeFields(meta)} ` +
    `priority=${meta.priority ?? "?"} query="${meta.query}" ` +
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
    `[SearchQueryRejected] ${scopeFields(meta)} ` +
    `query="${meta.query}" term="${meta.offendingTerm ?? ""}" ` +
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
    `[SearchQueryAudit] ${scopeFields(meta)} ` +
    `provider=${meta.provider ?? "-"} route=${meta.route ?? "-"} ` +
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
 * RONDE 88A P3 — WHICH RENDER, WHICH SCENE, WHICH BEAT.
 *
 * ── What render 568 measured ────────────────────────────────────────────────────────────────
 *
 *     [SearchQueryAudit] render=- scene=? beat=? provider=pexels …
 *
 * Every one of them. Not some — all. Three fields the log has declared since RONDE 90, printed as
 * placeholders on every line of every render, which makes the whole audit unchaseable: a reader
 * counting 128 refusals for "documentary" cannot ask which beats asked for it, and a reader looking
 * at one bad shot cannot find the queries that produced it.
 *
 * ── Why they were empty ─────────────────────────────────────────────────────────────────────
 *
 * Not scope loss. `searchGateDecision` mints its ticket with `mintVerifiedQuery(text, ambient,
 * { route })` — route and nothing else — and `formatSearchQueryRejected` is called with no scope
 * arguments at all. The fields were never filled by anybody. `VerifiedQueryContext` carries what a
 * beat PROVES and deliberately not which beat it is, so there was nothing ambient to read either.
 *
 * ── Why the default lives in the formatters ─────────────────────────────────────────────────
 *
 * Filling in the two call sites would work today and would be the fifteenth instance of this
 * codebase's recurring seam: a rule every route has to remember. The formatters take the scope from
 * here when the caller gives none, so a new logging site — and `keepProvableDirectorQueries` in
 * scriptVisualKeywords, which also passed nothing — is scoped without knowing this exists. An
 * explicit value still wins, because a caller that knows better than the ambient scope is right.
 *
 * A search outside any beat scope still prints `-` and `?`, and must: that is the honest answer for
 * a query nobody can place, and it is the same answer strict mode already gives it.
 */
export type QueryScope = {
  /** `videos.id` — the render this query belongs to. */
  readonly videoId?: number;
  readonly sceneIndex?: number;
  readonly beatIndex?: number;
};

const queryScopeStorage = new AsyncLocalStorage<QueryScope>();

/** Where the current provider search is happening, or an empty scope outside any beat. */
export function getQueryScope(): QueryScope {
  return queryScopeStorage.getStore() ?? {};
}

/**
 * Run `fn` with `scope` as the ambient identity for every query logged inside it.
 *
 * Opened at the same leaf as the provenance (`withBeatProvenance`), for the reason RONDE 100B
 * states there: wrapping the entry points was tried and was not exhaustive.
 */
export function withQueryScope<T>(scope: QueryScope, fn: () => T): T {
  const clean: QueryScope = {
    ...(scope.videoId != null ? { videoId: scope.videoId } : {}),
    ...(scope.sceneIndex != null ? { sceneIndex: scope.sceneIndex } : {}),
    ...(scope.beatIndex != null ? { beatIndex: scope.beatIndex } : {}),
  };
  // Nothing to say is not worth a scope — an empty one would shadow an outer, richer one.
  if (Object.keys(clean).length === 0) return fn();
  return queryScopeStorage.run({ ...getQueryScope(), ...clean }, fn);
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
/**
 * Provider syntax, which this boundary must not touch.
 *
 * `title:(Kris Jenner) AND mediatype:movies` and `"Kris Jenner" station:CNN` are STRUCTURE, not
 * semantics: the field names and operators are how a provider is addressed, and narrowing them
 * would break the query rather than sharpen it. §3's rule is that the policy owns the semantic
 * content and the provider owns the syntax; this is the line between the two.
 */
function isProviderSyntax(text: string): boolean {
  return /\w+:/.test(text) || /\s(AND|OR|NOT)\s/.test(text);
}

/**
 * THE CANONICAL QUERY — ONE POLICY, AT THE ONE PLACE EVERY PROVIDER PASSES.
 *
 * ── What render 594 sent, with the policy already written ───────────────────────────────────
 *
 *     single documentary footage · kanye documentary footage · tweet documentary footage
 *     Rumors kardashians Kardashian · kanye other
 *     Kris Jenner New York City bombard · Kris Jenner Kardashian Rumors about the
 *
 * `narrowToSubjectPlusConcept` was applied in `buildVisualSearchPlan`, and the plan is ONE
 * consumer. Every query above came from a different builder — the wikimedia rescue, the
 * escalation tiers, the historical cascade — and reached `fetchWikimediaVideos`,
 * `fetchEuropeanaVideos`, `fetchSepiaSearchVideos`, `fetchInternetArchiveClips`, `fetchPexelsClips`
 * and the rest without ever meeting it. The previous round's claim that the policy sits "before
 * every provider adapter" was measured and found false.
 *
 * ── Why here ────────────────────────────────────────────────────────────────────────────────
 *
 * `searchGateDecision` is the one function every provider route already calls — scenePool's nine
 * sources and `admitProviderQuery`'s fetchers alike — which is why every one of those routes
 * appears in the `[SearchQueryAudit]` lines. It has audited without rewriting until now; §3 asks
 * for exactly one boundary, and a second one placed anywhere else would be a copy that drifts.
 *
 * It also already holds everything the policy needs, so nothing new is plumbed through: the
 * ambient `VerifiedQueryContext` carries the typed persons, objects, events, places and time, and
 * `evidence` is the beat's own words — the same ground truth `validateSearchQuery` checks against.
 *
 * ── What it will not do ─────────────────────────────────────────────────────────────────────
 *
 * No anchor, no narrowing — §6's rule, unchanged: a beat with no proven subject is left exactly
 * as it was. Provider syntax is left alone. And the narrowed text is still put through
 * `validateSearchQuery` afterwards, so this cannot admit anything the gate would have refused.
 */
export function narrowToCanonicalQuery(
  text: string,
  ctx: VerifiedQueryContext | undefined
): { query: string; narrowed: boolean } {
  const original = (text ?? "").trim();
  if (!original || !ctx || isProviderSyntax(original)) return { query: original, narrowed: false };

  const verifiedTerms = (tokens: QueryToken[] | undefined): string[] =>
    (tokens ?? []).filter((t) => t.verified && t.term.trim()).map((t) => t.term.trim());

  /**
   * ROUND 596 §8 — THE ANCHOR IS THE PERSON THIS QUERY IS ABOUT, NOT SIMPLY THE FIRST ONE.
   *
   * ── What render 595 sent ────────────────────────────────────────────────────────────────
   *
   *     [SearchQueryCanonical] was="Kylie Jenner" now="Kris Jenner Kylie"
   *
   * Two different people, merged into one query, by a function whose entire job is to make a
   * query narrower. It took `persons[0]` — the render's primary subject — and completed the
   * query "towards" it, and because `Kylie` was in the original and `Kris`/`Jenner` are the
   * anchor's own words, the subset rule below saw nothing introduced and let it through.
   *
   * A beat about one member of a family carries several verified persons, and the query names
   * which one. Reading that instead of assuming it is the whole of the first fix: overlap is
   * counted in WORDS, so "Kylie Jenner" matches `Kylie Jenner` on two and `Kris Jenner` on one,
   * and the query keeps its own subject. Ties and no-overlap keep the existing behaviour exactly
   * — `Rumors kardashians Kardashians` shares no word with any person and still anchors to the
   * render's primary subject, as it did in production.
   */
  const persons = verifiedTerms(ctx.persons);
  if (persons.length === 0) return { query: original, narrowed: false };
  const originalWords = conceptWords(original);
  const originalSet = new Set(originalWords);
  let anchor = persons[0]!;
  let bestOverlap = -1;
  for (const person of persons) {
    const overlap = conceptWords(person).filter((w) => originalSet.has(w)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      anchor = person;
    }
  }
  if (!anchor) return { query: original, narrowed: false };
  /**
   * AND A SECOND PERSON THE QUERY NAMES IN FULL IS NEVER OVERWRITTEN.
   *
   * Whoever ends up chosen above, a query that already carries some other verified person's
   * complete identity is left alone. That is the brief's rule stated directly: a complete subject
   * identity may not be replaced, nor combined with another one.
   */
  const anchorWords = new Set(conceptWords(anchor));
  const namesSomeoneElseInFull = persons.some((person) => {
    if (person === anchor) return false;
    const words = conceptWords(person);
    return words.length > 0 && words.every((w) => originalSet.has(w));
  });
  if (namesSomeoneElseInFull) return { query: original, narrowed: false };

  const out = narrowToSubjectPlusConcept(
    original,
    anchor,
    {
      subject: anchor,
      event: verifiedTerms(ctx.events),
      objects: verifiedTerms(ctx.objects),
      location: [...verifiedTerms(ctx.places), ...verifiedTerms(ctx.countries)],
      period: [...verifiedTerms(ctx.time), ...verifiedTerms(ctx.years)],
      action: verifiedTerms(ctx.actions),
    },
    ctx.evidence
  );
  if (!out.query || out.query === original) return { query: original, narrowed: false };

  /**
   * NARROWING REMOVES. IT NEVER INTRODUCES.
   *
   * `narrowToSubjectPlusConcept` prefers the beat's TYPED concepts, and a typed concept need not
   * stand in the query it is narrowing — that is deliberate and right where it lives, because the
   * planner types "The Titanic sank" as `sinking`. At THIS boundary it is wrong: a mutation showed
   * `Kanye West documentary` coming out as `Kanye West hurricane` on a beat typed `hurricane`
   * whose words never say it. The caller asked one question and a different one went to the
   * provider.
   *
   * That is the "substituted or repaired" case this gate has refused since RONDE 91, and the fact
   * that the replacement would pass validation — a verified token is proof, by the gate's own
   * standard — is exactly why the check has to be about the QUERY rather than about provability.
   *
   * So the canonical form must be built from the words that came in, plus the SUBJECT's own — a
   * half-name legitimately completes (`kanye` → `Kanye West`), because that is the same subject
   * rather than a different one. Anything else and the query is left exactly as it arrived: made
   * smaller or left alone, never made into a different question.
   */
  /**
   * ROUND 596 §8 — AND THE ANCHOR MAY COMPLETE A HALF-NAME, NEVER ABSORB A NEIGHBOUR'S.
   *
   * ── The case the person list cannot answer ──────────────────────────────────────────────
   *
   * The anchor choice above needs `Kylie Jenner` to be a VERIFIED person of this beat. When only
   * `Kris Jenner` is verified, the query "Kylie Jenner" still shares `jenner` with the anchor, the
   * anchor is still chosen, and completion still produces "Kris Jenner Kylie". The merge has to be
   * impossible on the words alone, without knowing who is a person.
   *
   * ── The rule, in one sentence ───────────────────────────────────────────────────────────
   *
   * A WORD STANDING NEXT TO PART OF A NAME IS PART OF THAT NAME.
   *
   * So the anchor may only supply words the query does not have when no SURVIVING word of the
   * query — one the narrowing judged meaningful rather than padding — sits beside an anchor word
   * in the original. Measured on survivors and on the original's own word order, which is what
   * separates the three real cases:
   *
   *   "kanye documentary footage" + Kanye West → the survivor is `kanye`, itself an anchor word;
   *                                              `documentary` and `footage` were dropped as
   *                                              padding and stand beside nothing. COMPLETES.
   *   "Rumors kardashians Kardashians" + Kris Jenner → the original holds no anchor word at all,
   *                                              so nothing of the query is beside a name part.
   *                                              COMPLETES, exactly as it did in production.
   *   "Kylie Jenner" + Kris Jenner            → the survivor `kylie` stands immediately beside
   *                                              `jenner`, which IS an anchor word. REFUSED.
   *
   * A refusal here returns the query exactly as it arrived. It does NOT fall back to the subject
   * alone: replacing "Kylie Jenner" with "Kris Jenner" is the same defect wearing the other face.
   */
  const outWords = new Set(conceptWords(out.query));
  const completes = conceptWords(anchor).some((w) => !originalSet.has(w) && outWords.has(w));
  if (completes) {
    const absorbsANeighbour = originalWords.some((w, i) => {
      if (anchorWords.has(w) || !outWords.has(w)) return false;
      const before = i > 0 ? originalWords[i - 1] : undefined;
      const after = originalWords[i + 1];
      return (before != null && anchorWords.has(before)) || (after != null && anchorWords.has(after));
    });
    if (absorbsANeighbour) return { query: original, narrowed: false };
  }

  const allowed = new Set([...originalWords, ...conceptWords(anchor)]);
  const introduced = conceptWords(out.query).filter((w) => !allowed.has(w));
  if (introduced.length > 0) {
    /**
     * The chosen concept came from the planner rather than from this query, so it may not be
     * sent. What is still true is that the query's OWN remaining words were judged padding — the
     * policy reached past them for a reason — so the honest canonical form is the subject alone.
     * That is a strict narrowing of what arrived, and it is what `kanye documentary footage`
     * becomes: `Kanye West`.
     */
    const subjectOnly = anchor.trim();
    if (!subjectOnly || subjectOnly === original) return { query: original, narrowed: false };
    return { query: subjectOnly, narrowed: true };
  }

  return { query: out.query, narrowed: true };
}

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
  /**
   * RONDE 88A P3 — the ticket says where it was minted, not only what it proves.
   *
   * `{ route }` was the whole meta object, so every ticket this gate produced carried
   * `sceneIndex: undefined`, and the audit line printed the `scene=? beat=?` it was reading off the
   * ticket. The scope is ambient (see `withQueryScope`), so this needs no new parameter and no
   * caller has to remember it.
   */
  const scope = getQueryScope();
  const meta = {
    route,
    ...(scope.videoId != null ? { renderId: String(scope.videoId) } : {}),
    ...(scope.sceneIndex != null ? { sceneIndex: scope.sceneIndex } : {}),
    ...(scope.beatIndex != null ? { beatIndex: scope.beatIndex } : {}),
  };
  const ticket: VerifiedSearchQuery =
    preVerified ??
    (ambient ? mintVerifiedQuery(text, ambient, meta) : { ...legacyQueryTicket(text, route), ...meta });

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
    /**
     * RONDE 224 — THE LINE ASKED WHERE THE TERM CAME FROM AND NOBODY ANSWERED.
     *
     * `formatSearchQueryRejected` has carried a `termSource` field since RONDE 90, and this — its
     * only caller — never filled it in. So every refusal in every production log reads
     * `termSource=unknown`: render 576 printed that 410 times, and the one question a reader needs
     * answered to fix the builder is the one the line will not answer.
     *
     * It was never missing information, only unpassed information. `ticket.tokens` already carries
     * a `source` per term — that is what `QueryTokenSource` exists for — so the offending term's
     * own provenance is one lookup away.
     *
     * Matched case-insensitively because the gate lowercases as it tokenises, and falling back to
     * the type's own `"unknown"` when no token matches, which is itself a fact worth seeing: it
     * means the term reaching the gate is not one of the tokens the ticket was built from.
     */
    const offending = verdict.offendingTerm?.trim().toLowerCase();
    const offendingToken = offending
      ? ticket.tokens.find((t) => t.term.trim().toLowerCase() === offending)
      : undefined;
    console.warn(
      formatSearchQueryRejected({
        query: text, provider, route: ticket.route,
        reason: verdict.reason ?? "UNVERIFIED_TERM",
        offendingTerm: verdict.offendingTerm,
        termSource: offendingToken?.source,
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

  /**
   * THE SOURCING LADDER, ASKED WHERE EVERY PROVIDER ALREADY PASSES.
   *
   * Last, and deliberately so. This is a question about ORDER — may this tier run yet — and it is
   * only worth asking about a query the contract has already accepted. Asking it earlier would
   * let a malformed query mark a tier as attempted.
   *
   * Outside a beat's sourcing scope the answer is always yes: the scene pool, a warm-up and a test
   * have no ladder, and there is no order to enforce where there is no beat. See
   * `admitProviderForTier`.
   */
  const tierVerdict = admitProviderForTier(provider);
  if (!tierVerdict.admitted) {
    searchGateAudit.record("queriesBlocked", provider, ticket.route);
    console.warn(audit("BLOCKED", tierVerdict.reason as never));
    return { admitted: false, text };
  }

  /**
   * §3 — THE CANONICAL QUERY, AND WHY IT IS DECIDED HERE AND NOT SOONER.
   *
   * ── The invariant this must not break ───────────────────────────────────────────────────
   *
   * RONDE 91 §5: "one unproven term blocks the WHOLE query", and its TEST 16 —
   * "the proven prefix is NOT quietly sent instead". `Hitler Berlin Germany` on a beat that never
   * says Germany is REFUSED; sending `Hitler Berlin` in its place would turn a refusal into a
   * different, quieter search, which is the thing that round exists to prevent.
   *
   * Narrowing before validation does exactly that. It was written that way first and the RONDE
   * 89/90/91 suites caught it: eight tests, all of them saying the same thing. So the order is
   * the other way round — validate, refuse, and only THEN narrow what was already going to be
   * sent. A refusal stays a refusal; an admission is made sharper.
   *
   * ── What this still fixes ───────────────────────────────────────────────────────────────
   *
   * Render 594's polluted queries were ADMITTED ones — `Kris Jenner New York City bombard` and
   * `Kris Jenner Kardashian Rumors about the` both carry `status=ALLOWED` in the production log.
   * Those are exactly what this narrows, at the one boundary every provider passes.
   *
   * Narrowing only ever REMOVES terms from an admitted query, so the result cannot contain a
   * word the gate has not already proven — but it is re-validated rather than assumed, because
   * "cannot" and "checked" are different claims and this is the line where that matters.
   */
  const canonical = narrowToCanonicalQuery(text, ambient);
  let sent = text;
  if (canonical.narrowed && canonical.query) {
    const recheck = validateSearchQuery(canonical.query, preVerified ? undefined : ambient);
    if (recheck.ok) {
      sent = canonical.query;
      console.log(
        `[SearchQueryCanonical] provider=${provider} route=${ticket.route} ` +
          `was="${text}" now="${sent}"`
      );
    }
  }

  searchGateAudit.record("queriesSent", provider, ticket.route);
  if (searchQueryAuditLogEnabled()) console.log(audit("ALLOWED"));
  return { admitted: true, text: sent };
}

/* ═══════════════════════ SUBJECT + CONCEPT — the two-concept query policy ═══════════════════════ */

/**
 * WHAT A BEAT OFFERS A QUERY, RANKED THE WAY AN ARCHIVE ANSWERS IT.
 *
 * Structurally typed for the same reason `visualTermsFromIntent` is: `BeatVisualIntent`'s module
 * imports this one, and the dependency may not run both ways.
 */
export type ConceptSource = {
  subject?: string;
  people?: readonly string[];
  event?: readonly string[];
  location?: readonly string[];
  period?: readonly string[];
  objects?: readonly string[];
  action?: readonly string[];
};

/**
 * The order the SECOND term is chosen in — and it is NOT `visualTermsFromIntent`'s order.
 *
 * That function ranks by what the beat is ABOUT, so `subject` and `people` lead. This one runs
 * after the subject is already in hand and asks a different question: of everything left, which
 * one word narrows an archive most? The answer is the concrete happening or thing, then where,
 * then when.
 *
 * `action` is absent on purpose. `dropActionOnlyQueries` already records why — "a verb rarely
 * narrows a search and often widens it" — and render 593 shipped `"sword tuned"` and
 * `"masterclass other"` to providers because a verb and a filler noun were allowed to stand as
 * queries. A verb may still ride along inside a concept the planner typed; it may not BE the
 * concept.
 *
 * `people` is absent too, and for a sharper reason: a second person is a second subject. "Kim
 * Kardashian Kanye West" asserts a meeting the beat may never have described, which is the exact
 * claim `buildPrioritisedQueries` refuses to manufacture.
 */
const CONCEPT_RANK = ["event", "objects", "location", "period"] as const;

/**
 * Words that carry no picture, and may therefore never be the concept half of a query.
 *
 * Every one of these was measured in a production log, not imagined. Render 593 sent `"news
 * other"`, `"masterclass other"`, `"single day"` and `"news kim"` to real providers; `other` and
 * `day` are the words that made those queries unanswerable. A provider asked for "other" returns
 * whatever it likes and the beat then fails its picture gate for a reason that has nothing to do
 * with the beat.
 *
 * This is NOT a stopword list — `isFunctionWord` already owns that job and runs first. These are
 * content words by grammar that name nothing to photograph.
 */
const EMPTY_CONCEPT_WORDS = new Set(
  [
    "other", "others", "thing", "things", "stuff", "item", "items",
    "day", "days", "time", "times", "year", "years", "moment", "moments",
    "way", "ways", "kind", "kinds", "sort", "sorts", "part", "parts",
    "news", "video", "videos", "footage", "clip", "clips", "documentary",
    "latest", "official", "single", "new", "old", "big", "small",
    "masterclass", "tuned", "content", "media", "story", "stories",
  ].map((w) => foldSearchText(w))
);

/** Is this word capable of being the concept half of a query at all? */
function wordCanBeConcept(word: string): boolean {
  const folded = foldSearchText(word).replace(/[^\p{L}\p{N}'’-]/gu, "");
  if (!folded) return false;
  if (isFunctionWord(word)) return false;
  return !EMPTY_CONCEPT_WORDS.has(folded);
}

/** The words of a phrase, folded, with punctuation stripped — the codebase's own comparison. */
function conceptWords(phrase: string): string[] {
  return (phrase ?? "")
    .split(/[^\p{L}\p{N}'’-]+/u)
    .map((w) => foldSearchText(w).replace(/[^\p{L}\p{N}'’-]/gu, ""))
    .filter(Boolean);
}

export type NarrowedQuery = {
  /** `subject concept`, or just the subject when the beat offered no usable concept. */
  query: string;
  /** What it is built from, in order. Never more than two entries. */
  concepts: string[];
  /** Why the second concept is the one it is — for the plan log, never for a decision. */
  reason: string;
};

/**
 * ── MAXIMAAL TWEE BETEKENISVOLLE TERMEN: [MAIN SUBJECT] + [SENTENCE VISUAL CONCEPT] ─────────
 *
 * ── What render 593 actually sent ───────────────────────────────────────────────────────────
 *
 * Two failure shapes, both measured, and they need opposite repairs:
 *
 *     "Rumors kardashians Kardashians"            a sentence, with the subject said twice
 *     "it's documentary footage"                  four words, no subject at all
 *     "masterclass other" · "single day"          content words that name nothing
 *     "sword tuned" · "shaped" · "evidence"       the sentence's grammar, not its picture
 *
 * The first is too long. The rest are the wrong two words. A cap alone fixes only the first, and
 * `ensureSubjectAnchor` alone fixes only the last — this function is where the two meet.
 *
 * ── Why this is not a truncation ────────────────────────────────────────────────────────────
 *
 * `query.split(" ").slice(0, 2)` on "Kim Kardashian launched a new beauty collection" gives
 * "Kim Kardashian" — the subject, and nothing about this beat. On "The Titanic sank in 1912" it
 * gives "The Titanic". Position is not meaning, and every example in this codebase's logs where
 * a query lost its point lost it to exactly that kind of arithmetic.
 *
 * So the subject is kept WHOLE, however many words it spans, and the second term is CHOSEN: the
 * highest-ranked concept the planner typed whose words the remaining query actually contains.
 * Only when the beat typed no usable concept does this fall back to reading the remainder, and
 * even then it takes the first word that can name a picture rather than the first word.
 *
 * ── The subject is never traded away ────────────────────────────────────────────────────────
 *
 * `ensureSubjectAnchor` put it there and this may not take it out. A beat with a subject and no
 * concept searches for the subject alone, which is a narrower question than the subject plus a
 * word that means nothing. §9's rule — "het hoofdonderwerp mag NOOIT verloren gaan" — is the one
 * thing this function has no branch to violate.
 *
 * ── An empty anchor changes nothing about that ──────────────────────────────────────────────
 *
 * With no proven subject there is nothing to protect and nothing to compose against, so the query
 * is returned narrowed to its own strongest concept and no subject is invented. §6's rule, which
 * `ensureSubjectAnchor` already holds, reaches this function unchanged.
 */
export function narrowToSubjectPlusConcept(
  query: string,
  anchor: string,
  intent?: ConceptSource | null,
  /**
   * The beat's own narration, when the caller has it.
   *
   * Used for one thing only: deciding whether a word taken from the query is something this beat
   * actually says, or a category that arrived from a fallback tier. See the note at the fallback
   * loop. Omitted, the function behaves exactly as it did.
   */
  sourceText?: string | null
): NarrowedQuery {
  const q = (query ?? "").replace(/\s+/g, " ").trim();
  const a = (anchor ?? "").replace(/\s+/g, " ").trim();
  if (!q) return { query: "", concepts: [], reason: "empty query" };

  /**
   * Surface forms are carried alongside the folded ones throughout.
   *
   * Folding is how this codebase compares words — case, diacritics and punctuation removed — and
   * comparing any other way would miss "Kardashian's" against "Kardashian". But a query is also
   * a string somebody reads in a log and a provider may index case-sensitively, so what comes
   * OUT has to be the words as the narration wrote them. An earlier version returned the folded
   * form and turned "Berlin 1945" into "berlin 1945": correct as a comparison, wrong as a query.
   */
  const qSurface = (q.match(/[\p{L}\p{N}'’-]+/gu) ?? []).filter((w) => conceptWords(w).length > 0);
  const qWords = conceptWords(q);
  const aWords = conceptWords(a);

  /**
   * The subject's own words come out first, so the concept search cannot pick one of them and
   * hand back "Kim Kardashian kim". `ensureSubjectAnchor` refuses that doubling on the way in;
   * this refuses it on the way out.
   */
  const anchorSet = new Set(aWords);
  const surfaceOf = new Map<string, string>();
  qWords.forEach((folded, i) => {
    if (!surfaceOf.has(folded) && qSurface[i]) surfaceOf.set(folded, qSurface[i]!);
  });
  const remainder = qWords.filter((w) => !anchorSet.has(w));

  /** The planner's own typed concepts, strongest first, filtered to what this query still says. */
  const typed: Array<{ term: string; field: string }> = [];
  if (intent) {
    for (const field of CONCEPT_RANK) {
      for (const raw of (intent[field] ?? []) as readonly string[]) {
        const term = (raw ?? "").replace(/\s+/g, " ").trim();
        if (term) typed.push({ term, field });
      }
    }
  }

  /**
   * How many concepts there is room for. The subject already occupies one of the two, so an
   * anchored query gets ONE more; an unanchored one gets both.
   *
   * §12 is the reason the second branch exists. The historical round deliberately asks a
   * geographic and chronological question with no subject in front of it — "Berlin 1945" — and
   * that is two concepts, not a subject plus a concept. Narrowing it to one would throw away the
   * era, which is the half that makes archival footage era-correct.
   */
  const room = a ? 1 : 2;
  const picked: string[] = [];
  const reasons: string[] = [];

  for (const { term, field } of typed) {
    if (picked.length >= room) break;
    const words = conceptWords(term).filter((w) => !anchorSet.has(w));
    const kept = words.filter((w) => wordCanBeConcept(w));
    if (kept.length === 0) continue;
    /**
     * A TYPED CONCEPT DOES NOT HAVE TO APPEAR IN THE QUERY VERBATIM.
     *
     * An earlier version required it, and "The Titanic sank in 1912 after hitting an iceberg"
     * then searched for "Titanic iceberg": the planner had typed the event as `sinking`, the
     * sentence says `sank`, and a word-containment check cannot see that those are the same
     * happening. It fell through to the object, which is the thing the ship hit rather than the
     * thing the beat is about.
     *
     * The intent is the beat's own model, not a rendering of its grammar, and it was already put
     * through `termProvableFrom` where it was built. `validateSearchQuery` still judges whatever
     * this composes, so the gate — not this function — remains the authority on admission.
     */
    /** The narration's spelling where the query has it, the planner's where it does not. */
    const termSurface = term.match(/[\p{L}\p{N}'’-]+/gu) ?? [];
    const concept = kept
      .map((w) => surfaceOf.get(w) ?? termSurface.find((t) => conceptWords(t)[0] === w) ?? w)
      .join(" ");
    if (picked.includes(concept)) continue;
    picked.push(concept);
    reasons.push(`planner ${field}`);
  }

  /**
   * Nothing typed survived, so the sentence's own remaining words are all there is. The first one
   * that can name a picture — which is not the same as the first one — and nothing if none can.
   *
   * ── A CATEGORY IS NOT A CONCEPT, AND THE BEAT ITSELF SAYS WHICH IS WHICH ────────────────────
   *
   * `celebrity` reaches this loop and passes every test above it: it is not a function word, it is
   * not in the padding set, and it is one word long. `Kim Kardashian celebrity` then satisfies the
   * two-concept rule while naming nothing anybody can photograph — which is the shape render 593
   * sent and got generic results back from.
   *
   * The tempting fix is a longer padding list. That is the brittle query logic this programme has
   * removed twice, and it cannot scale: every domain has its own category vocabulary and a list
   * written today is wrong for the next topic.
   *
   * The distinction is already in the data. `beauty` and `rumors` are in the beat's own narration;
   * `celebrity`, `documentary archive` and `historical footage` are not — they are appended by
   * `domainFallbackTiers` and by semantic simplification, which is why render 593 sent them on
   * beats whose scripts never contained the words. So the measure is the one the gate itself uses:
   * a concept taken from the query's remaining words must be PROVABLE from the beat, by stem.
   *
   * Typed concepts do not go through this. They are the beat's own semantic model rather than a
   * rendering of its grammar, they were put through `termProvableFrom` where they were built, and
   * requiring provability again would break the case that proves the point: the planner types
   * "The Titanic sank in 1912" as `event: sinking`, and `sank` does not stem to `sinking`.
   *
   * Without a `sourceText` nothing changes — a caller that cannot supply the beat has proven
   * nothing, and refusing on that basis would be guessing rather than measuring.
   */
  if (picked.length < room) {
    const source = (sourceText ?? "").trim();
    const taken = new Set(picked.flatMap((c) => conceptWords(c)));
    for (const w of remainder) {
      if (picked.length >= room) break;
      if (taken.has(w) || !wordCanBeConcept(w)) continue;
      const surface = surfaceOf.get(w) ?? w;
      if (source && !termProvableFrom(surface, source)) {
        reasons.push(`"${surface}" is not in this beat — category, not concept`);
        continue;
      }
      taken.add(w);
      picked.push(surface);
      reasons.push("strongest content word in the narration");
    }
  }

  if (picked.length === 0) {
    return a
      ? { query: a, concepts: [a], reason: "no concept in this beat — subject alone" }
      : { query: "", concepts: [], reason: "no subject and no concept" };
  }
  const concepts = a ? [a, ...picked] : picked;
  return {
    query: concepts.join(" "),
    concepts,
    reason: [...new Set(reasons)].join(" + "),
  };
}

/**
 * How many SEMANTIC concepts a query carries, counted against the subject it is about.
 *
 * The subject is one concept however many words it spans — "Kim Kardashian" is a person, not two
 * search terms — so this cannot be a word count, and §15's invariant cannot be checked with one.
 * Everything outside the subject is counted as content words, because a concept the planner typed
 * as two words ("Los Angeles") is still one thing to find a picture of.
 *
 * Function words and the empty-concept vocabulary are not counted at all: they were never terms.
 */
export function semanticConceptCount(query: string, anchor = ""): number {
  const qWords = conceptWords(query);
  const aWords = new Set(conceptWords(anchor));
  const namesAnchor = aWords.size > 0 && [...aWords].every((w) => qWords.includes(w));
  const rest = qWords.filter((w) => !aWords.has(w) && wordCanBeConcept(w));
  return (namesAnchor ? 1 : 0) + rest.length;
}
