/** Visual Matching Engine V2 — Ranked Query Generation (Phase 3, Visual Intelligence Engine).
 *
 * Expands one VisualIntent's entities (subject, secondary subjects, action, location, objects,
 * brands, companies, people, countries, events) into many candidate search strings instead of
 * the original primaryKeyword/secondaryKeyword pair, and ranks them by specificity. Purely
 * deterministic — no LLM call, since every entity it combines was already extracted by
 * visualIntentExtractor.ts (one call per scene, already cached); templating them into more
 * query variants costs nothing extra.
 *
 * Optionally folds in editorialSequencePlanner.ts's ShotDescription for this beat, when the
 * legacy pipeline's storyboard has already planned one — its searchQuery/alternatives are
 * shot-type-aware (already live in production) and worth reusing rather than re-deriving shot
 * phrasing here.
 *
 * Output size naturally varies with how many distinct entities a beat actually has — a sparse
 * beat (e.g. only a subject and an action) won't be padded with 30 near-duplicate queries just
 * to hit a floor; a rich beat (several named entities) will comfortably reach 20-30.
 */
import type { RankedQuery, RankedQuerySource, VisualIntent } from "./types";
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
 * Generates a ranked list of search queries for one beat, highest-priority first. Callers that
 * only want the top few can slice the result; every entry already carries its own score/source
 * for explainability (e.g. "why did we search for this").
 */
export function generateRankedSearchQueries(
  intent: VisualIntent,
  shot?: ShotDescription | null
): RankedQuery[] {
  const out: RankedQuery[] = [];
  const seen = new Set<string>();
  let rank = 1;
  const next = (query: string, score: number, source: RankedQuerySource) => {
    if (pushUnique(seen, out, query, rank, score, source)) rank += 1;
  };

  const subject = clean(intent.visualSubject);
  const primaryPerson = intent.people[0] ? clean(intent.people[0]) : subject;

  // ─── Rank 1 tier: shot-plan-aware queries, already shot-type-aware and pre-built for
  // retrieval by the live editorialSequencePlanner.ts — highest confidence, reuse verbatim. ──
  if (shot?.searchQuery) next(shot.searchQuery, 1, "shot_plan");
  for (const alt of shot?.alternatives ?? []) next(alt, 0.95, "shot_plan");

  // ─── Rank 2 tier: named person + format noun (the exact "Elon Musk keynote" / "Elon Musk
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

  // ─── Rank 3 tier: company/brand + event/action — strong when a named organization is
  // involved even without a specific person (e.g. a product launch beat). ─────────────────
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

  // ─── Rank 4 tier: subject + action / location / object — the general-purpose combinations
  // that work regardless of whether named entities were found. ───────────────────────────
  if (subject && intent.visualAction) next(`${subject} ${intent.visualAction}`, 0.6, "subject_action");
  if (subject && intent.visualLocation) next(`${subject} ${intent.visualLocation}`, 0.55, "subject_location");
  for (const obj of intent.objects) {
    if (subject) next(`${subject} ${obj}`, 0.5, "subject_object");
    next(obj, 0.3, "subject_object");
  }
  for (const secondary of intent.secondaryVisualSubjects) {
    if (subject) next(`${subject} ${secondary}`, 0.45, "subject_action");
  }

  // ─── Rank 5 tier: era/country context — useful for disambiguating footage of the right
  // period/place when the subject alone is ambiguous. ────────────────────────────────────
  for (const country of intent.countries) {
    if (subject) next(`${subject} ${country}`, 0.4, "era_country");
    if (intent.visualTime) next(`${country} ${intent.visualTime}`, 0.35, "era_country");
  }

  // ─── Rank 6 tier: the original primary/secondary keywords — kept as the lowest-priority
  // fallback for full backwards compatibility with callers that only used these two before. ──
  next(intent.primaryKeyword, 0.5, "primary_keyword");
  next(intent.secondaryKeyword, 0.4, "secondary_keyword");
  if (subject) next(subject, 0.3, "primary_keyword");

  return out.slice(0, 30).map((q, i) => ({ ...q, rank: i + 1 }));
}
