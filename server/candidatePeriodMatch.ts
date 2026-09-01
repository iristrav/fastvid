/**
 * RONDE 175 §2 — the ranker learns what period and place a beat is about.
 *
 * ── What the ranking used to weigh ───────────────────────────────────────────────────────────
 *
 *     rankingScore = keyword score + embedding similarity + source tier + moving bonus
 *
 * Nothing about WHEN or WHERE. A 1945 photograph and a 1926 photograph were interchangeable to the
 * ranker on a beat about 1926, and a generic shot of Germany could outrank Munich material on a
 * beat that names Munich. That matters more than it looks, because only the first few candidates
 * are ever judged (MAX_JUDGEMENTS_PER_BEAT): a better ordering means the gate's looks land on
 * better pictures without a single extra search.
 *
 * ── The rule this module exists to get right ─────────────────────────────────────────────────
 *
 * ABSENCE IS NEUTRAL. Never a penalty.
 *
 * That is the whole design, and it comes from a mistake this codebase has made before. Real
 * archive titles are catalogue numbers:
 *
 *     "Bundesarchiv Bild 183-S33882"          no year, no place, no name
 *     "Winter in Munich 1926 - HD stock loop"  every field, richly worded
 *
 * If a missing year cost a candidate points, the exact material this pipeline exists to find would
 * sink and stock footage would rise — which is RONDE 54's finding ("white-lives-matter-montana-
 * sticker" reaching the CLIP tie-break against a signed photograph of Hitler) reproduced through a
 * new mechanism. So a candidate that says nothing about its period is treated exactly as it was
 * before this module existed.
 *
 * Only two things move the score:
 *   · AGREEMENT   the candidate's own text names the beat's year, decade or place  → small bonus
 *   · CONTRADICTION  it names a DIFFERENT year, far enough away to be a real conflict → penalty
 *
 * ── And it is a nudge, never a veto ──────────────────────────────────────────────────────────
 *
 * Sized inside a single source-tier step, like the moving-footage bonus. It changes which
 * candidates the gate looks at first; the winner is still decided by the beat image gate on the
 * actual picture.
 */

/** What the beat is established to be about. Every field optional — supply what is known. */
export type BeatTemporalContext = {
  /** Years the beat's own text proves, e.g. ["1926"]. */
  years?: string[];
  /** Places the beat's own text proves, e.g. ["Munich"]. */
  places?: string[];
  /** Persons or events the beat names, e.g. ["Hermann Göring"]. */
  subjects?: string[];
};

export type PeriodMatchVerdict = "agrees" | "contradicts" | "unknown";

export type CandidateMatch = {
  period: PeriodMatchVerdict;
  place: PeriodMatchVerdict;
  subject: PeriodMatchVerdict;
  /** The signed ranking adjustment. 0 when nothing could be established either way. */
  bonus: number;
};

/**
 * How far apart two years must be before they are a contradiction rather than a near miss.
 *
 * Archive material is routinely dated to the year it was catalogued rather than shot, and a beat
 * about "the early thirties" is legitimately served by a 1934 photograph. Twelve years is wide
 * enough that only a real conflict — a war shot under a beat about the previous decade — trips it.
 */
const CONTRADICTION_YEAR_DISTANCE = 12;

/** Agreement is worth about half a source-tier step; a contradiction costs a full one. */
const PERIOD_AGREE_BONUS = 0.07;
const PERIOD_CONTRADICT_PENALTY = -0.15;
const PLACE_AGREE_BONUS = 0.06;
const SUBJECT_AGREE_BONUS = 0.08;

/** Every 4-digit year in a piece of text, as numbers. Ignores anything outside plausible range. */
export function yearsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of String(text ?? "").matchAll(/\b(1[0-9]{3}|20[0-9]{2})\b/g)) {
    const n = Number(m[1]);
    if (n >= 1000 && n <= 2100) out.push(n);
  }
  return out;
}

function normalise(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Does the candidate's own text name this place / person? Whole-word, so "man" ≠ "germany". */
function mentions(hay: string, needle: string): boolean {
  const n = normalise(needle);
  if (n.length < 3) return false;
  return new RegExp(`(^| )${n.replace(/ /g, " ")}( |$)`).test(hay);
}

/**
 * Score one candidate against what the beat is about.
 *
 * `candidateText` is everything the candidate says about itself — title, description, tags —
 * concatenated by the caller. Nothing is fetched here and nothing is inferred: a field the
 * candidate does not mention produces "unknown", which contributes exactly zero.
 */
export function matchCandidateToBeat(
  candidateText: string,
  ctx: BeatTemporalContext | undefined
): CandidateMatch {
  const none: CandidateMatch = {
    period: "unknown", place: "unknown", subject: "unknown", bonus: 0,
  };
  if (!ctx) return none;

  const hay = normalise(candidateText);
  if (!hay) return none;

  // ── Period
  const beatYears = (ctx.years ?? []).flatMap((y) => yearsIn(y));
  const candidateYears = yearsIn(candidateText);
  let period: PeriodMatchVerdict = "unknown";
  if (beatYears.length > 0 && candidateYears.length > 0) {
    const nearest = Math.min(
      ...candidateYears.map((cy) => Math.min(...beatYears.map((by) => Math.abs(cy - by))))
    );
    // A candidate carrying SEVERAL years (a compilation, a catalogue range) is judged on its
    // closest one: a reel spanning 1939-1945 is not in conflict with a beat about 1943.
    period = nearest <= CONTRADICTION_YEAR_DISTANCE ? "agrees" : "contradicts";
  }

  // ── Place and subject: agreement or nothing. A candidate that does not name the place is not
  // making a claim about a different one, so there is no contradiction to detect.
  const place = (ctx.places ?? []).some((p) => mentions(hay, p)) ? "agrees" : "unknown";
  const subject = (ctx.subjects ?? []).some((s) => mentions(hay, s)) ? "agrees" : "unknown";

  let bonus = 0;
  if (period === "agrees") bonus += PERIOD_AGREE_BONUS;
  else if (period === "contradicts") bonus += PERIOD_CONTRADICT_PENALTY;
  if (place === "agrees") bonus += PLACE_AGREE_BONUS;
  if (subject === "agrees") bonus += SUBJECT_AGREE_BONUS;

  return { period, place, subject, bonus };
}

/** `period=agrees place=unknown subject=agrees bonus=+0.15` — for the funnel's own log line. */
export function formatCandidateMatch(m: CandidateMatch): string {
  const sign = m.bonus >= 0 ? "+" : "";
  return (
    `period=${m.period} place=${m.place} subject=${m.subject} ` +
    `bonus=${sign}${m.bonus.toFixed(2)}`
  );
}
