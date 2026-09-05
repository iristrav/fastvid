/**
 * RONDE 96 — WHAT THIS BEAT IS LOOKING FOR, IN ONE RECORD, ONCE.
 *
 * ── The gap, and why it is not "no extractor" ───────────────────────────────────────────────
 *
 * FastVid already extracts everything §1 asks for. It extracts it in three places, for three
 * different consumers, and joins them nowhere:
 *
 *   · `buildVerifiedQueryContextForBeat` types the beat into persons, places, countries, events,
 *     actions, objects, time and years — eight of the ten fields — and hands them to the query
 *     validator, which uses them to REFUSE unproven words and then forgets them.
 *   · `documentaryPlanningEngine` builds a `RetrievalContract` per beat carrying `preferredShot`,
 *     `fallbackShot`, `visualGoal`, `mustContain` and `forbiddenContent` — the other two fields
 *     and more — and hands it to the asset director.
 *   · `editorialIntentEngine.decomposeQueryBeat` names the beat's narrative purpose and hands it
 *     to the archive metadata scorer.
 *
 * So three subsystems each hold a third of the answer to "what is this beat looking for", none of
 * them can see the other two, and nothing in the render can print that answer. Building a FOURTH
 * extractor would be the exact mistake the brief forbids and this codebase's most repeated one.
 * This module extracts nothing. It JOINS what the three already produced, caches the join for the
 * beat, and lets the ranking and the log read one record instead of three partial ones.
 *
 * ── Why it is cached per beat rather than recomputed ────────────────────────────────────────
 *
 * Query generation, candidate ranking and the vision gate all want the same answer at different
 * moments in the beat's life. Recomputing it would be three chances for the three to disagree
 * about what the beat is looking for — and a ranking that scores against a different intent than
 * the query searched for is worse than no ranking. One record, built on first ask, read by all.
 */
import type { RetrievalContract } from "./documentaryPlanningEngine";
import type { VerifiedQueryContext } from "./searchQueryContract";
import { foldSearchText } from "./searchTextNormalize";

/** The ten fields §1 names, plus the provenance needed to explain any one of them later. */
export type BeatVisualIntent = {
  sceneIndex: number;
  beatIndex: number;
  /** The single strongest content anchor — what a person would say this beat is ABOUT. */
  subject: string;
  action: string[];
  event: string[];
  location: string[];
  period: string[];
  people: string[];
  objects: string[];
  /**
   * How hard the evidence requirement is for this beat.
   *
   * `hard` — the planner named entities the picture MUST contain (`mustContain`).
   * `soft` — the beat has a subject but nothing is mandatory.
   * `none` — nothing typed and nothing planned; the beat cannot state what it wants, and a
   *          retrieval route should treat that as a reason for caution rather than freedom.
   */
  evidenceRequirement: "hard" | "soft" | "none";
  preferredShot: string;
  /** What KIND of picture this beat falls back to when its own subject cannot be found. */
  fallbackClass: string;
  /** From `decomposeQueryBeat` — "opening/establishing", "historical context", and so on. */
  narrativePurpose: string;
  /** Terms the planner forbids. Carried so ranking can penalise rather than only the director. */
  forbidden: string[];
  /** Every content term above, folded once, so a scorer never has to fold in a loop. */
  foldedTerms: readonly string[];
};

export type BeatVisualIntentState = {
  byBeat: Map<string, BeatVisualIntent>;
};

export function createBeatVisualIntentState(): BeatVisualIntentState {
  return { byBeat: new Map() };
}

const key = (sceneIndex: number, beatIndex: number): string => `${sceneIndex}:${beatIndex}`;

const terms = (tokens: { term: string; verified?: boolean }[] | undefined): string[] =>
  (tokens ?? [])
    .filter((t) => t.verified !== false)
    .map((t) => (t.term ?? "").trim())
    .filter(Boolean);

/**
 * THE JOIN. Nothing here decides anything the three sources had not already decided.
 *
 * `subject` deserves its own note. It is the beat's strongest content anchor and the order below
 * is an order of authority, not of convenience: an event names what happened, a person names who
 * it happened to, a place names where — and a beat about the Battle of Berlin is about the battle
 * even when it also names Berlin. `mustContain` outranks all of them, because that is the planner
 * stating a hard requirement rather than an extractor reporting a word.
 */
export function buildBeatVisualIntent(input: {
  sceneIndex: number;
  beatIndex: number;
  ctx?: VerifiedQueryContext | null;
  contract?: RetrievalContract | null;
  narrativePurpose?: string;
}): BeatVisualIntent {
  const { sceneIndex, beatIndex, ctx, contract } = input;

  const people = terms(ctx?.persons);
  const event = terms(ctx?.events);
  const location = [...terms(ctx?.places), ...terms(ctx?.countries)];
  const period = [...terms(ctx?.time), ...terms(ctx?.years)];
  const action = terms(ctx?.actions);
  const objects = terms(ctx?.objects);
  const mustContain = (contract?.mustContain ?? []).map((t) => t.trim()).filter(Boolean);

  const subject =
    mustContain[0] ?? event[0] ?? people[0] ?? location[0] ?? objects[0] ?? action[0] ?? "";

  const content = [...new Set([...mustContain, ...event, ...people, ...location, ...period, ...action, ...objects])];

  return {
    sceneIndex,
    beatIndex,
    subject,
    action,
    event,
    location,
    period,
    people,
    objects,
    evidenceRequirement: mustContain.length > 0 ? "hard" : subject ? "soft" : "none",
    preferredShot: contract?.preferredShot ?? "",
    fallbackClass: contract?.fallbackShot ?? "",
    narrativePurpose: (input.narrativePurpose ?? contract?.visualGoal ?? "").toString(),
    forbidden: (contract?.forbiddenContent ?? []).map((t) => t.trim()).filter(Boolean),
    foldedTerms: content.map((t) => foldSearchText(t)).filter(Boolean),
  };
}

/** Build once, read many. The second caller for a beat gets the record the first one made. */
export function ensureBeatVisualIntent(
  state: BeatVisualIntentState | undefined,
  input: Parameters<typeof buildBeatVisualIntent>[0]
): BeatVisualIntent {
  const intent = buildBeatVisualIntent(input);
  if (!state) return intent;
  const k = key(input.sceneIndex, input.beatIndex);
  const existing = state.byBeat.get(k);
  if (existing) return existing;
  state.byBeat.set(k, intent);
  return intent;
}

export function beatVisualIntent(
  state: BeatVisualIntentState | undefined,
  sceneIndex: number,
  beatIndex: number
): BeatVisualIntent | null {
  return state?.byBeat.get(key(sceneIndex, beatIndex)) ?? null;
}

/**
 * HOW WELL DOES THIS CANDIDATE ANSWER THE BEAT?
 *
 * A deliberately small, deterministic score over text the provider supplied — a title, a
 * description, tags. It exists to ORDER candidates, never to admit or refuse one: eligibility,
 * the shortlist bound and the vision verdict all keep their own jobs, and a scorer that could
 * also reject would be a second selection engine.
 *
 * Weighted by how specific the match is. A period match is worth more than a loose action match
 * because "1945" narrows an archive and "moving" does not, and the forbidden terms subtract
 * because the planner naming something forbidden is a stronger statement than an extractor
 * naming something present.
 */
export function intentMatchScore(
  intent: BeatVisualIntent | null | undefined,
  candidateText: string | undefined
): number {
  if (!intent || !candidateText) return 0;
  const hay = foldSearchText(candidateText);
  if (!hay) return 0;
  const hit = (list: string[], weight: number): number => {
    let n = 0;
    for (const t of list) {
      const folded = foldSearchText(t);
      if (folded && hay.includes(folded)) n += weight;
    }
    return n;
  };
  let score = 0;
  if (intent.subject && hay.includes(foldSearchText(intent.subject))) score += 6;
  score += hit(intent.event, 4);
  score += hit(intent.people, 3);
  score += hit(intent.location, 3);
  score += hit(intent.period, 3);
  score += hit(intent.objects, 2);
  score += hit(intent.action, 1);
  score -= hit(intent.forbidden, 5);
  return score;
}

/**
 * The beat's own statement of what it is looking for, in one line.
 *
 * Printed once per beat, on the record's first build, so a later reader can explain WHY a picture
 * was searched for without re-deriving anything. Empty fields are omitted rather than printed as
 * `=[]`: a beat that could not state its period is more visible when the field is missing than
 * when it is present and empty.
 */
export function formatVisualIntent(intent: BeatVisualIntent): string {
  const parts: string[] = [
    `s${intent.sceneIndex}b${intent.beatIndex}`,
    `subject=${intent.subject || "NONE"}`,
    `evidence=${intent.evidenceRequirement}`,
  ];
  const add = (label: string, list: string[]) => {
    if (list.length > 0) parts.push(`${label}=${list.slice(0, 4).join("|")}`);
  };
  add("people", intent.people);
  add("event", intent.event);
  add("place", intent.location);
  add("period", intent.period);
  add("action", intent.action);
  add("object", intent.objects);
  if (intent.preferredShot) parts.push(`shot=${intent.preferredShot}`);
  if (intent.fallbackClass) parts.push(`fallbackShot=${intent.fallbackClass}`);
  if (intent.narrativePurpose) parts.push(`purpose=${intent.narrativePurpose}`);
  add("forbidden", intent.forbidden);
  return `[VisualIntent] ${parts.join(" ")}`;
}

/**
 * The beats that could not say what they were looking for.
 *
 * `evidenceRequirement: "none"` means neither the extractors nor the planner produced a single
 * content term for this beat — so every query it builds is guessing, and every candidate it ranks
 * is ranked against nothing. Reported as a named finding rather than left for someone to notice
 * in a wall of per-beat lines.
 */
export function intentlessBeats(state: BeatVisualIntentState | undefined): BeatVisualIntent[] {
  if (!state) return [];
  return [...state.byBeat.values()]
    .filter((i) => i.evidenceRequirement === "none")
    .sort((a, b) => a.sceneIndex - b.sceneIndex || a.beatIndex - b.beatIndex);
}

export function formatIntentSummary(state: BeatVisualIntentState | undefined): string[] {
  if (!state || state.byBeat.size === 0) return [];
  const all = [...state.byBeat.values()];
  const hard = all.filter((i) => i.evidenceRequirement === "hard").length;
  const soft = all.filter((i) => i.evidenceRequirement === "soft").length;
  const none = all.filter((i) => i.evidenceRequirement === "none").length;
  const withShot = all.filter((i) => i.preferredShot).length;
  const lines = [
    `[VisualIntent] TOTAL beats=${all.length} hard=${hard} soft=${soft} none=${none} withPreferredShot=${withShot}`,
  ];
  for (const i of intentlessBeats(state)) {
    lines.push(
      `[VisualIntentGap] s${i.sceneIndex}b${i.beatIndex} no subject, no entity and no planner ` +
        `contract — every query for this beat is unanchored`
    );
  }
  return lines;
}
