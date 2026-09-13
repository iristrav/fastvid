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
  /**
   * `evidenceRequirement` FINALLY DECIDES SOMETHING.
   *
   * The field is produced by `ensureBeatVisualIntent`, printed by `formatVisualIntent`, and until
   * now read by nothing that orders candidates — so a beat whose planner said the picture MUST
   * contain named entities ranked its candidates exactly like a beat that asked for nothing.
   * "hard" is the closest thing this codebase has to §11's requiredElements, and it was inert.
   *
   * A candidate that matched NOTHING the beat named scores 0 above, which places it level with a
   * candidate the beat has no opinion about. On a `hard` beat that is wrong: the planner made a
   * statement, and a picture answering none of it is worse than neutral. The penalty is one step
   * below a forbidden hit, because "contains nothing we asked for" is a weaker complaint than
   * "contains something we ruled out".
   *
   * Only on `hard`, and only at zero. A beat with a soft or absent requirement is untouched, and a
   * candidate that matched anything at all keeps the score it earned — so this reorders the
   * bottom of the list and can never demote a candidate that is genuinely on target.
   */
  if (score === 0 && intent.evidenceRequirement === "hard") return -4;
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
/* ═══════════════════════ WHAT KIND OF PICTURE THIS BEAT NEEDS ═══════════════════════ */

/**
 * THE MEDIA FORM — and why it is not `mediaType`.
 *
 * `mediaType` (video / still) says how a file is ENCODED. It is a fact about storage, and the
 * pipeline has always had it. What the pipeline has never had is a statement of what KIND of
 * picture the beat needs: an archive reel, a portrait, a map, a chart. Those are different
 * questions with different best sources, and without the second one every beat is routed to the
 * same fourteen providers in source-code order — which is what render 577 did.
 *
 * The list is deliberately small and deliberately about SUBJECT MATTER, not about aesthetics.
 */
export type MediaForm =
  | "ARCHIVAL_FOOTAGE"
  | "REAL_FOOTAGE"
  | "PHOTO"
  | "MAP"
  | "DOCUMENT"
  | "NEWS"
  | "PERSON"
  | "LOCATION"
  | "OBJECT"
  | "PROCESS"
  | "B_ROLL"
  | "GRAPHIC"
  | "DATA_VISUALIZATION"
  | "INTERVIEW";

/**
 * What the beat needs, and what it will also take.
 *
 * Two lists rather than one label, because a beat naming a person IN a place in 1945 genuinely
 * has three good answers and picking one of them by fiat would throw away two. `preferred` is
 * what the routing should ask first; `acceptable` is what it may still use.
 *
 * `preferred` is EMPTY when the beat proved nothing. That is the honest answer for a beat whose
 * extractors typed nothing at all, and it is why this cannot quietly narrow such a beat to one
 * form: an empty `preferred` means "no opinion", and a router reading it must fall back to its
 * default order rather than invent a form.
 */
export type MediaFormNeed = {
  preferred: readonly MediaForm[];
  acceptable: readonly MediaForm[];
};

/**
 * INFERRED FROM WHAT THE BEAT ALREADY TYPED — no LLM call, no new API, no new extractor.
 *
 * Every rule below reads a field `buildBeatVisualIntent` already fills from the verified context.
 * Deterministic, so the same beat always produces the same need and a render is reproducible.
 *
 * The rules, in the order they contribute:
 *
 *   period      → ARCHIVAL_FOOTAGE. A dated beat wants material FROM that date, and that is the
 *                 single strongest routing signal there is: it separates an archive from a stock
 *                 library more sharply than any other field.
 *   people      → PERSON. Someone has to be shown, which is a different search from a place.
 *   location    → LOCATION.
 *   objects     → OBJECT.
 *   event       → NEWS when the beat is NOT dated to the past, ARCHIVAL_FOOTAGE when it is. The
 *                 same word ("the vote", "the launch") means a news clip this year and an archive
 *                 reel in 1945, and only the period field can tell them apart.
 *   action only → PROCESS. A beat that names a verb and no noun is describing something happening.
 *
 * `acceptable` always ends with B_ROLL: whatever the beat wants, general footage is still usable
 * rather than wrong. PHOTO is acceptable wherever a still can carry the subject — which is
 * everywhere except a beat that specifically needs motion, and this model does not claim to know
 * that. REAL_FOOTAGE is acceptable everywhere for the same reason.
 *
 * What this does NOT do: MAP, DOCUMENT, GRAPHIC, DATA_VISUALIZATION and INTERVIEW are declared in
 * `MediaForm` and never inferred here. Nothing in the current intent can prove a beat needs a map
 * or a chart — the extractors do not type quantities, and guessing from a word like "percent"
 * would be exactly the kind of inference this codebase keeps removing. They are in the type so a
 * later round that CAN prove them has a name to use, and naming them without inferring them is
 * the honest state.
 */
export function mediaFormsForIntent(
  intent:
    | {
        people?: readonly string[];
        event?: readonly string[];
        location?: readonly string[];
        period?: readonly string[];
        objects?: readonly string[];
        action?: readonly string[];
      }
    | null
    | undefined
): MediaFormNeed {
  const has = (list: readonly string[] | undefined): boolean => (list?.length ?? 0) > 0;
  if (!intent) return { preferred: [], acceptable: ["B_ROLL"] };

  const dated = has(intent.period);
  const preferred: MediaForm[] = [];
  const push = (form: MediaForm): void => {
    if (!preferred.includes(form)) preferred.push(form);
  };

  if (dated) push("ARCHIVAL_FOOTAGE");
  if (has(intent.people)) push("PERSON");
  if (has(intent.location)) push("LOCATION");
  if (has(intent.objects)) push("OBJECT");
  if (has(intent.event)) push(dated ? "ARCHIVAL_FOOTAGE" : "NEWS");
  if (preferred.length === 0 && has(intent.action)) push("PROCESS");

  /** Nothing typed: no opinion, and the router keeps its default order. */
  if (preferred.length === 0) return { preferred: [], acceptable: ["B_ROLL"] };

  const acceptable: MediaForm[] = [];
  for (const form of [...preferred, "REAL_FOOTAGE" as const, "PHOTO" as const, "B_ROLL" as const]) {
    if (!acceptable.includes(form)) acceptable.push(form);
  }
  return { preferred, acceptable };
}

/** One line, for the render's own log — a need nobody can read is a need nobody can audit. */
export function formatMediaFormNeed(need: MediaFormNeed): string {
  return `want=${need.preferred.join("|") || "NONE"} ok=${need.acceptable.join("|")}`;
}

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
  /** The need, on the same line as the terms it was derived from, so the two can be compared. */
  parts.push(formatMediaFormNeed(mediaFormsForIntent(intent)));
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

/**
 * RONDE 97 §1 — WHY THIS QUERY EXISTS, in the fields the brief names.
 *
 * The query audit already records what a query said and whether it was allowed. It could not say
 * what the beat was ASKING FOR when it was built, so a query that turned out to retrieve nothing
 * could not be traced back to the intent that produced it. This closes that: one line per query,
 * carrying the beat, the intent's content fields, the planned shot, and the provider that was
 * asked.
 *
 * Derived entirely from the intent record and the query string — nothing is re-extracted, so this
 * cannot disagree with the ranking about what the beat wanted.
 */
export type QueryProvenance = {
  sceneIndex: number;
  beatIndex: number;
  subject: string;
  event: string;
  place: string;
  period: string;
  action: string;
  shotIntent: string;
  query: string;
  provider: string;
};

export function queryProvenance(
  intent: BeatVisualIntent | null | undefined,
  query: string,
  provider: string
): QueryProvenance {
  return {
    sceneIndex: intent?.sceneIndex ?? -1,
    beatIndex: intent?.beatIndex ?? -1,
    subject: intent?.subject ?? "",
    event: intent?.event[0] ?? "",
    place: intent?.location[0] ?? "",
    period: intent?.period[0] ?? "",
    action: intent?.action[0] ?? "",
    shotIntent: intent?.preferredShot ?? "",
    query: (query ?? "").trim(),
    provider: (provider ?? "").trim() || "unknown",
  };
}

/** One line, and the empty fields are omitted for the same reason `formatVisualIntent` omits them. */
export function formatQueryProvenance(p: QueryProvenance): string {
  const parts = [`s${p.sceneIndex}b${p.beatIndex}`, `provider=${p.provider}`, `query="${p.query}"`];
  const add = (label: string, value: string) => {
    if (value) parts.push(`${label}=${value}`);
  };
  add("subject", p.subject);
  add("event", p.event);
  add("place", p.place);
  add("period", p.period);
  add("action", p.action);
  add("shotIntent", p.shotIntent);
  return `[QueryProvenance] ${parts.join(" ")}`;
}

/**
 * The two fields the planner supplies and `VerifiedQueryContext` does not, shaped for the query
 * builder. Kept here rather than in the builder so there is one definition of what the planner
 * contributes to a query, and the builder stays free of any dependency on this module.
 */
export function queryIntentHints(
  intent: BeatVisualIntent | null | undefined
): { subject?: string; preferredShot?: string } | undefined {
  if (!intent) return undefined;
  if (!intent.subject && !intent.preferredShot) return undefined;
  return {
    ...(intent.evidenceRequirement === "hard" && intent.subject ? { subject: intent.subject } : {}),
    ...(intent.preferredShot ? { preferredShot: intent.preferredShot } : {}),
  };
}
