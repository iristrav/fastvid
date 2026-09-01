/**
 * RONDE 112 — the last INHOUDELIJKE fallback: footage of the beat's subject.
 *
 * ── The gap this fills ───────────────────────────────────────────────────────────────────────
 *
 * RONDE 111 capped slow motion at 2x and made the coverage backfill search harder below that cap.
 * What it left underneath was still technical: re-use the scene's own shot in motion, then hold a
 * frame. Both of those answer "we have no picture" with "here is the previous picture again".
 *
 * There is a better answer, and it is the one a documentary editor reaches for. A beat reads
 *
 *     "Hitler died in his bunker in 1945."
 *
 * and the archive has nothing of the bunker, nothing of 1945, nothing of the death. It does have
 * Hitler. A shot of Hitler under that line is honest and useful; a frozen frame of the previous
 * shot is neither.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────────────────────
 *
 * Not a new NER, not an LLM call, not a new query builder, not a second relevance decider. Every
 * signal below is already extracted by the existing chain — the beat's semantic profile, the
 * video's person lock, the name extractor the pipeline already runs. This module only CHOOSES
 * among them, and the choice is deliberately conservative: when nothing here is a real named
 * subject it returns null, and the pipeline falls through to the technical fallbacks rather than
 * searching for a random word out of the sentence.
 *
 * The search that follows is the existing cascade, and the picture it finds still goes through
 * the same vision gate. The gate is simply asked a narrower question — "is this Hitler" instead
 * of "is this Hitler dying in a bunker in 1945" — and the answer is recorded as
 * `subject_fallback`, never as a verified fit for the beat's full claim.
 */

/** The adopt route recorded for a clip found this way. Never "primary", never a verified fit. */
export const SUBJECT_FALLBACK_ROUTE = "subject_fallback";

export type BeatSubjectKind = "person" | "organisation" | "place" | "event";

export type BeatSubject = {
  /** The subject to search for, e.g. "Hitler". */
  subject: string;
  kind: BeatSubjectKind;
  /** Which already-existing signal this came from, for the log. */
  origin:
    | "semantic_persons"
    | "semantic_companies"
    | "semantic_locations"
    | "semantic_events"
    | "person_lock"
    | "beat_names"
    /**
     * RONDE 132 §4 — the beat said nothing, but the scene did.
     *
     * These are deliberately last and deliberately named apart. A subject the beat itself
     * supplied is a claim about THIS sentence; a subject borrowed from the scene is a claim about
     * the passage the sentence sits in, which is weaker and must be readable as such in the log.
     */
    | "scene_persons"
    | "neighbour_beat_persons"
    | "scene_locations"
    | "scene_events";
};

/** What the resolver was given. Every field is produced elsewhere in the existing chain. */
export type BeatSubjectSignals = {
  beatText: string;
  /** BeatSemanticProfile.entities, when the beat has a profile. */
  entities?: {
    persons?: string[];
    locations?: string[];
    companies?: string[];
    events?: string[];
  };
  /** The video-level topic lock, when one was established. */
  primaryPerson?: string;
  /** Names the pipeline's own extractor found in the beat text. */
  namesInBeat?: string[];
  /**
   * RONDE 132 §4 — the entities of the SCENE this beat belongs to.
   *
   * Every lookup below was beat-local: the beat's own semantic profile, names in the beat's own
   * text, and a person lock gated on the beat literally spelling the name. So a sentence like
   * "That's the chilling story hidden beneath the battlefields" resolved to nothing, in a scene
   * whose other beats named Hitler twice.
   *
   * Optional, so a caller that has no scene profile behaves exactly as before.
   */
  sceneEntities?: {
    persons?: string[];
    locations?: string[];
    companies?: string[];
    events?: string[];
  };
  /**
   * Persons named by the beats immediately before and after this one.
   *
   * Narrower than the scene and closer to the sentence: a passage that names someone and then says
   * "his obsession cost thousands of lives" is about that person, and the pronoun is the evidence.
   */
  neighbourPersons?: string[];
};

/**
 * Words that look like names to a capitaliser but are not subjects.
 *
 * Kept tiny on purpose. This is not a stop-word list for search — the query builder has its own
 * and this module must not grow a second one. It exists only so a sentence-initial word or a
 * calendar word cannot become "the subject of the beat".
 */
const NOT_A_SUBJECT = new Set([
  "the", "this", "that", "these", "those", "they", "there", "then", "when", "what", "which", "who",
  "his", "her", "their", "its", "it", "he", "she", "we", "you", "i", "a", "an", "and", "but", "or",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
  "sunday", "today", "tomorrow", "yesterday", "history", "story", "world", "people", "year",
  "years", "time", "war", "death", "life", "end", "beginning", "one", "two", "three",
]);

/**
 * Is this a subject worth searching for on its own?
 *
 * A subject has to be specific enough that footage OF it means something. "war" is a topic, not a
 * subject; "Hitler" is a subject. The test is deliberately mechanical — length, not a bare
 * stop-word, not a pure number — because anything cleverer would be a second content decider,
 * and this module is not allowed to be one.
 */
export function isUsableSubject(raw: string): boolean {
  const s = String(raw ?? "").trim();
  if (s.length < 3 || s.length > 60) return false;
  if (/^\d+$/.test(s)) return false;
  const words = s.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  return !words.every((w) => NOT_A_SUBJECT.has(w.replace(/[^a-z]/g, "")));
}

function firstUsable(list: readonly string[] | undefined): string | null {
  for (const candidate of list ?? []) {
    const s = String(candidate ?? "").trim();
    if (isUsableSubject(s)) return s;
  }
  return null;
}

/**
 * The one thing this beat is about, or null.
 *
 * Order is by how much a picture OF it would mean under this narration:
 *
 *   1. a person the beat's own semantic profile named — the strongest signal, and beat-specific;
 *   2. an organisation it named;
 *   3. the video's person lock, but only when the beat actually mentions them, so a video about
 *      one man does not answer every beat with his face regardless of what the beat says;
 *   4. a name the pipeline's extractor found in the beat text, when there is no profile;
 *   5. a place, then an event.
 *
 * Returning null is a real outcome, not a failure to try: a beat with no named subject has
 * nothing specific to fall back to, and inventing one would be exactly the "random word from the
 * sentence" this fallback exists to avoid.
 */
export function resolveBeatSubject(signals: BeatSubjectSignals): BeatSubject | null {
  const person = firstUsable(signals.entities?.persons);
  if (person) return { subject: person, kind: "person", origin: "semantic_persons" };

  const company = firstUsable(signals.entities?.companies);
  if (company) return { subject: company, kind: "organisation", origin: "semantic_companies" };

  const lock = String(signals.primaryPerson ?? "").trim();
  if (isUsableSubject(lock)) {
    const beat = String(signals.beatText ?? "").toLowerCase();
    const parts = lock.toLowerCase().split(/\s+/).filter((p) => p.length >= 3);
    // Only when the beat is actually about them — a surname is enough, a shared first name is not.
    if (parts.some((p) => beat.includes(p))) {
      return { subject: lock, kind: "person", origin: "person_lock" };
    }
  }

  const named = firstUsable(signals.namesInBeat);
  if (named) return { subject: named, kind: "person", origin: "beat_names" };

  const place = firstUsable(signals.entities?.locations);
  if (place) return { subject: place, kind: "place", origin: "semantic_locations" };

  const event = firstUsable(signals.entities?.events);
  if (event) return { subject: event, kind: "event", origin: "semantic_events" };

  /**
   * RONDE 132 §4 — everything above asked the SENTENCE. Now ask the passage.
   *
   * Ordered after every beat-local signal, so a beat that names its own subject is never
   * overruled by its neighbours. Within the borrowed signals, nearer beats come before the whole
   * scene, and persons before places and events — the same precedence the beat-local rules use,
   * for the same reason: a picture of a person under narration about that person means more than
   * a picture of a country.
   *
   * A neighbouring beat is only evidence when this beat carries a pronoun or a demonstrative
   * pointing back at it. "That's the chilling story" and "his obsession" are continuations; a
   * sentence that introduces something new is not, and borrowing a subject for it would be the
   * "random word from the sentence" this module exists to avoid — one step removed.
   */
  if (beatContinuesPreviousThought(signals.beatText)) {
    const neighbour = firstUsable(signals.neighbourPersons);
    if (neighbour) {
      return { subject: neighbour, kind: "person", origin: "neighbour_beat_persons" };
    }
  }

  const scenePerson = firstUsable(signals.sceneEntities?.persons);
  if (scenePerson) return { subject: scenePerson, kind: "person", origin: "scene_persons" };

  const scenePlace = firstUsable(signals.sceneEntities?.locations);
  if (scenePlace) return { subject: scenePlace, kind: "place", origin: "scene_locations" };

  const sceneEvent = firstUsable(signals.sceneEntities?.events);
  if (sceneEvent) return { subject: sceneEvent, kind: "event", origin: "scene_events" };

  return null;
}

/**
 * Does this sentence point back at something already said?
 *
 * The test for whether a neighbour's subject is evidence about THIS beat. Pronouns and
 * demonstratives are the grammar of continuation — "his obsession", "that's the story", "these
 * blunders" — and a sentence without one is introducing rather than continuing.
 *
 * Deliberately mechanical, and deliberately not a stop-word list: this is a grammatical test, not
 * a content decision, and the module is not allowed to become a second content decider.
 */
export function beatContinuesPreviousThought(beatText: string): boolean {
  const t = String(beatText ?? "").toLowerCase();
  if (!t.trim()) return false;
  return /\b(he|him|his|she|her|hers|they|them|their|it|its|this|that|these|those)\b/.test(t);
}

/**
 * What a clip found this way is allowed to claim.
 *
 * Spelled out as a constant because it is the sentence that has to reach the report: the picture
 * shows the subject, and nothing was verified about the rest of the beat's sentence.
 */
export const SUBJECT_FALLBACK_CLAIM =
  "shows the beat's main subject, not necessarily the full event described";

/** The line the pipeline report carries for a beat filled this way. */
export function formatSubjectFallbackLine(params: {
  sceneIndex: number;
  beatIndex: number;
  beatText: string;
  subject: BeatSubject;
  basename: string;
  assetId?: number | null;
  provider?: string;
}): string {
  const asset = params.assetId != null ? `asset=${params.assetId} ` : "";
  const provider = params.provider ? `source=${params.provider} ` : "";
  return (
    `[SubjectFallback] scene=${params.sceneIndex} beat=${params.beatIndex} ` +
    `subject="${params.subject.subject}" kind=${params.subject.kind} ` +
    `origin=${params.subject.origin} ${provider}${asset}clip=${params.basename} ` +
    `claim="${SUBJECT_FALLBACK_CLAIM}" beat="${params.beatText.slice(0, 90)}"`
  );
}

/** The line for a beat where no subject could be named at all. */
export function formatNoSubjectLine(sceneIndex: number, beatIndex: number, beatText: string): string {
  return (
    `[SubjectFallback] scene=${sceneIndex} beat=${beatIndex} subject=none ` +
    `reason=no_reliable_subject_in_beat beat="${beatText.slice(0, 90)}"`
  );
}

/**
 * The line for a subject that WAS named but ended with no picture.
 *
 * ── RONDE 132 §2 (the second finding) ────────────────────────────────────────────────────────
 *
 * The render reported this five times, for "hitler", "germany" and "russia", on a WWII
 * documentary with a filled archive:
 *
 *     [SubjectFallback] subject="hitler" result=no_footage_found
 *                       reason=subject_search_returned_nothing
 *
 * `subject_search_returned_nothing` is one sentence covering two completely different failures:
 *
 *   · nothing came back at all — a routing or provider problem, and a real bug,
 *   · plenty came back and every candidate was refused by the gates — the pipeline working,
 *     on a one-word beat that gives the vision gate almost nothing to judge.
 *
 * The old wording asserted the first while the second is at least as likely, and nothing in the
 * line let a reader tell them apart. It now reports what actually happened. `candidates` and
 * `rejected` come from counters the beat already keeps, so nothing new is measured — it is simply
 * no longer thrown away at the one moment it would answer the question.
 */
export function formatSubjectFallbackEmptyLine(
  sceneIndex: number,
  beatIndex: number,
  subject: BeatSubject,
  outcome?: { rejected?: number }
): string {
  const rejected = outcome?.rejected ?? null;
  /**
   * Derived from the beat's own reject audit and nothing else.
   *
   * A rejection is proof that a candidate reached the gates, so `rejected > 0` settles it: the
   * search DID return something and the gates refused all of it. Zero rejections means nothing
   * ever got that far — which is the case worth investigating, and the one the old single reason
   * was silently asserting for both.
   *
   * No candidate COUNT is reported, because none is measured here. Printing an invented one would
   * be worse than the ambiguity this replaces.
   */
  const reason =
    rejected == null
      ? "subject_search_outcome_unknown"
      : rejected === 0
        ? "no_candidate_reached_the_gates"
        : "all_candidates_rejected";
  const counts = rejected == null ? "" : ` rejected=${rejected}`;
  return (
    `[SubjectFallback] scene=${sceneIndex} beat=${beatIndex} ` +
    `subject="${subject.subject}" kind=${subject.kind} origin=${subject.origin} ` +
    `result=no_footage_found reason=${reason}${counts}`
  );
}
