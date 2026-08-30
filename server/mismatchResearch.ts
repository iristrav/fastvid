/**
 * RONDE 132 — when the refusal blames the question, ask a different question.
 *
 * ── What RONDE 131 left on the table ─────────────────────────────────────────────────────────
 *
 * RONDE 131 taught the pipeline to READ its own refusals. `visualMismatchFeedback` classifies
 * what the picture editor said and decides whether the fault lies with the QUESTION (we asked
 * something that returns present-day streets) or with the MATERIAL (a title card, a piece to
 * camera). What it then does with that is reorder the candidates already downloaded.
 *
 * Reordering is the right move while there is still something in the pile. It is no move at all
 * once the pile is exhausted — and video 546's beats exhausted it twenty-one times. A beat that
 * has been told "this is present-day footage under 1945 narration", and has nothing left to try,
 * should go and ask about 1945.
 *
 * ── What this decides, and what it refuses to decide ─────────────────────────────────────────
 *
 * This module answers one question: given the mismatch, is there a BETTER QUESTION this beat
 * already proves it can ask, and which one is it.
 *
 * The corrected query is never composed here. It is SELECTED from the list
 * `buildPrioritisedQueries` already minted for this beat, which is the only place in this codebase
 * a query may come from. That is not a style preference — it is what keeps every guarantee the
 * contract rounds built:
 *
 *   · RONDE 90/91  every term traces to the beat's own words, with offsets.
 *   · RONDE 125    Unicode survives, because the term is the token, not a reconstruction of it.
 *                  "Hermann Göring" is carried, never rebuilt from ASCII pieces.
 *   · RONDE 93     no term is introduced by an LLM, a title inference, or a reject reason.
 *
 * Concretely: a beat whose refusal says "wrong period" gets the query the contract already built
 * that CARRIES A YEAR — "Hermann Göring Berlin 1945" rather than "Hermann Göring Berlin". The
 * brief's worked example ("Berlin archival footage" → "Berlin April 1945 archival footage") is
 * that same move, made by picking the contract's time-bearing variant instead of by gluing the
 * reason string onto the end of the old query.
 *
 * When the beat proves no such query, the answer is NO_BETTER_QUERY and nothing is searched. A
 * beat that never mentions a year cannot be made to ask about one, and inventing the year is
 * exactly the failure RONDE 90 exists to prevent.
 *
 * ── What it never does ───────────────────────────────────────────────────────────────────────
 *
 * · It never researches a MATERIAL fault. A title card does not mean the question was wrong.
 * · It never researches twice. One extra pass per beat, enforced by the caller's own set.
 * · It never calls a model. The words come from the gate's existing answer.
 * · It never sends a query anywhere. It returns a decision; the caller runs the existing search.
 */

import {
  buildPrioritisedQueries,
  provenToken,
  type PrioritisedQuery,
  type QueryToken,
  type QueryTokenType,
  type VerifiedQueryContext,
} from "./searchQueryContract";
import { mismatchFault, type MismatchFault, type MismatchKind } from "./visualMismatchFeedback";

/**
 * What one research pass costs, when the caller has a budget but no better estimate.
 *
 * A pass is one run of the existing provider cascade over a handful of queries — the same work an
 * ordinary beat does, which the render already budgets for. Deliberately generous: skipping a
 * research pass costs one beat a better picture, while overrunning the render's deadline costs
 * the whole export.
 */
export const RESEARCH_ESTIMATED_COST_MS = 45_000;

/**
 * RONDE 171 — how much more a render must be able to afford once it is past its own pacing.
 *
 * `forceExportMode` used to be a veto: it replaced the remaining budget with 0, so every research
 * pass after it turned on was refused however much render was left. Video 555 turned it on nine
 * minutes into a twenty-two minute budget and finished with nearly seven minutes unspent, having
 * run the recovery path zero times against seventeen search-preventable refusals.
 *
 * A margin says the same thing without the lie. A render in force-export is already behind, so a
 * pass has to fit twice over before it is started — and when it genuinely does not fit,
 * `decideResearch`'s own check refuses it as BUDGET_EXCEEDED, which is the honest reason.
 */
export const FORCE_EXPORT_RESEARCH_MARGIN = 2;

/** What a correction is trying to add to the question. */
export type CorrectionStrategy =
  /** Add the period the narration states. */
  | "ADD_TIME"
  /** Put the person back at the front of the question. */
  | "ADD_PERSON"
  /** Add the place the narration states. */
  | "ADD_PLACE"
  /**
   * RONDE 135 — name the occasion the beat states.
   *
   * "The right people, the wrong occasion" is not fixed by adding the person: the person is
   * already in the frame. It is fixed by naming the event, when the beat or its scene proves one.
   */
  | "ADD_EVENT"
  /**
   * RONDE 134 — ask for the archive rather than for the upload.
   *
   * A title card and a piece to camera are not answers to the wrong question; they are the wrong
   * KIND of answer to the right one. RONDE 132 therefore did nothing about them, and a beat whose
   * every candidate was a leader or a presenter fell through with the question unchanged.
   *
   * There is one move available that does not invent a word: the contract already mints an
   * archival-phrased variant of the beat's strongest combination — "Hermann Göring Berlin archival
   * footage" — using TECHNICAL_ARCHIVAL_TERM, the single technical term it permits. Asking that
   * instead is a different question about the same subject, and it is the question a documentary
   * researcher would ask after being handed a talk-show clip.
   */
  | "ADD_ARCHIVAL_INTENT"
  /** Ask the most specific question this beat supports, whatever it is. */
  | "MOST_SPECIFIC";

/**
 * Which token types a strategy demands the corrected query carry.
 *
 * MOST_SPECIFIC demands none: it is the fallback for a refusal that named no dimension, and its
 * discipline comes from the level ordering rather than from a required type.
 */
const STRATEGY_REQUIRES: Record<CorrectionStrategy, ReadonlyArray<QueryTokenType>> = {
  ADD_TIME: ["year", "time"],
  ADD_PERSON: ["person"],
  ADD_PLACE: ["place", "country"],
  ADD_EVENT: ["event"],
  ADD_ARCHIVAL_INTENT: ["technical"],
  MOST_SPECIFIC: [],
};

/**
 * RONDE 134 §14 — what each correction reaches for FIRST.
 *
 * A strategy says which dimension the refusal was missing; this says how to choose between the
 * several contract queries that supply it. The order is the brief's, expressed as token types so
 * it ranks the queries the contract already built rather than composing new ones: a period
 * correction prefers the query that carries the year AND the person over the one that carries the
 * year alone, because "Hermann Göring Berlin 1945" is a better question than "Berlin 1945".
 *
 * Types earlier in the list are worth more. Nothing here can add a term.
 */
const STRATEGY_PRIORITY: Record<CorrectionStrategy, ReadonlyArray<QueryTokenType>> = {
  ADD_TIME: ["year", "time", "person", "place", "country", "event"],
  ADD_PERSON: ["person", "event", "place", "country", "year", "time"],
  ADD_PLACE: ["place", "country", "person", "year", "time", "event"],
  ADD_EVENT: ["event", "person", "place", "country", "year", "time"],
  ADD_ARCHIVAL_INTENT: ["technical", "person", "event", "place", "country", "year"],
  MOST_SPECIFIC: ["event", "person", "place", "country", "year", "time"],
};

/** The correction each kind argues for, or null when the kind argues for no new question at all. */
export function correctionStrategyFor(kind: MismatchKind): CorrectionStrategy | null {
  switch (kind) {
    case "WRONG_PERIOD":
    // RONDE 135: present-day footage is a period fault and takes the period correction.
    case "MODERN_FOOTAGE":
      return "ADD_TIME";
    case "WRONG_SUBJECT":
      return "ADD_PERSON";
    case "WRONG_PLACE":
      return "ADD_PLACE";
    case "WRONG_EVENT":
      return "ADD_EVENT";
    case "UNRELATED":
      return "MOST_SPECIFIC";
    /**
     * RONDE 134 changes these two from "do nothing".
     *
     * RONDE 132's reasoning was that a MATERIAL fault does not indict the question, and that is
     * still true — which is why the correction here does not change the SUBJECT of the question.
     * It changes what is being asked FOR: archive footage rather than whatever the catalogue
     * happened to return. The blame stays MATERIAL in every report; only the response changes.
     */
    case "TEXT_ON_SCREEN":
    case "TITLE_CARD":
    case "TALKING_HEAD":
      return "ADD_ARCHIVAL_INTENT";
    /**
     * RONDE 135 — a black frame or a blurred one says nothing about the question OR the
     * catalogue's phrasing. There is no correction to make; the beat needs different material,
     * which the exhausted-pool path it arrived on has already been looking for.
     */
    case "LOW_INFORMATION":
      return null;
    /**
     * A refusal whose words say nothing is still never acted on.
     *
     * RONDE 160 tried reversing this — mapping UNCLEAR to MOST_SPECIFIC, on the argument that the
     * alternative outcome is a placeholder card and that MOST_SPECIFIC invents no dimension. It was
     * backed out, for two reasons that are worth writing down so the next round does not retry it.
     *
     * First, four rounds (132, 134, 135, 153) each independently asserted this null as a guard, and
     * the reasoning holds: research passes are budgeted, and giving one to a beat whose refusal
     * nobody could read spends it against beats that have a diagnosed fault and a correction that
     * follows from it.
     *
     * Second, and decisively: the real defect is that the refusal was unreadable, not that nothing
     * was done about it. RONDE 159 fixed the largest instance of that properly — the gate writes
     * "does not relate", the classifier read "not related" — by reading production prose and adding
     * the form it actually uses. That is the structural fix, and it is repeatable: the log window
     * was widened in the same round so the next render shows whole verdicts instead of preambles.
     * Acting on an unreadable refusal would have removed the symptom that leads to the evidence.
     */
    case "UNCLEAR":
      return null;
  }
}

export type ResearchSkipReason =
  /** The fault is with the material, not the question. */
  | "MATERIAL"
  /** The gate's words did not say what was wrong. */
  | "UNCLEAR"
  /** This beat has already had its one extra pass. */
  | "ALREADY_RESEARCHED"
  /** The beat proves nothing more specific than what was already asked. */
  | "NO_BETTER_QUERY"
  /**
   * RONDE 134 §20 — there is not enough render left to spend on another search.
   *
   * Distinct from NO_BETTER_QUERY on purpose: one says the beat had nothing better to ask, the
   * other says it did and the render could not afford to. They lead to different work.
   */
  | "BUDGET_EXCEEDED";

export type ResearchDecision =
  | {
      action: "RESEARCH";
      kind: MismatchKind;
      blame: MismatchFault;
      strategy: CorrectionStrategy;
      /** The query to search with. Always one the contract minted for this beat. */
      correctedQuery: string;
      /** Every contract query that satisfies the strategy, strongest first — the caller may take more than one. */
      correctedQueries: string[];
    }
  | {
      action: "NONE";
      kind: MismatchKind;
      blame: MismatchFault;
      reason: ResearchSkipReason;
    };

/** Does this contract query carry at least one of the required token types? */
function carriesAnyType(query: PrioritisedQuery, types: ReadonlyArray<QueryTokenType>): boolean {
  if (types.length === 0) return true;
  return query.tokens.some((t) => types.includes(t.type));
}

/**
 * RONDE 134 §14 — how well this query serves the strategy.
 *
 * Sums the weight of the priority types it carries, earlier types weighing more. A pure ranking
 * function over queries that already exist: it can reorder them and nothing else.
 */
function priorityScore(query: PrioritisedQuery, order: ReadonlyArray<QueryTokenType>): number {
  const present = new Set(query.tokens.map((t) => t.type));
  let score = 0;
  for (let i = 0; i < order.length; i++) {
    if (present.has(order[i]!)) score += order.length - i;
  }
  return score;
}

// ─── The research context: everything the pipeline already knows about this beat ─────────────

/**
 * RONDE 134 §2/§3 — the scene knows things the beat does not say twice.
 *
 * A documentary states its period once and then relies on it: "In April 1945 Hermann Göring left
 * Berlin for the south. He had commanded the Luftwaffe since 1935. The decision was his alone."
 * The third sentence is a beat with no year, no place and no event — and RONDE 133 measured what
 * that costs: a period correction fired on 2 of 10 realistic beats, because years and places are
 * read from the beat's own words only. Persons already read the scene; nothing else did.
 *
 * This merges the scene's typed tokens in behind the beat's. Three properties make it safe:
 *
 *  · No new extractor. The scene context comes from the SAME `buildVerifiedQueryContextForBeat`
 *    the beat's does, called on the scene's text — so a scene year is found exactly the way a beat
 *    year is, by code that RONDE 125 already guards.
 *  · No new evidence. `beatSearchProvenance` already builds the ambient context with
 *    `evidence = beat text + scene text`, and `validateSearchQuery` proves a content word against
 *    that evidence string. A scene-derived year was ALREADY admissible to the SearchGate; the only
 *    thing missing was a builder willing to put it in a query.
 *  · The beat still leads. Beat tokens keep their position; scene tokens are appended, so every
 *    query the beat could form on its own is unchanged and ranked first.
 *
 * ACTIONS are deliberately not merged. A verb from another sentence is that sentence's verb —
 * "left" belongs to the beat that says it, and carrying it across would assert something the beat
 * does not.
 */
export function buildResearchContext(params: {
  beat: VerifiedQueryContext;
  scene?: VerifiedQueryContext | null;
}): VerifiedQueryContext {
  const { beat, scene } = params;
  if (!scene) return beat;

  const merged: VerifiedQueryContext = {
    persons: [...beat.persons],
    places: [...beat.places],
    countries: [...beat.countries],
    events: [...beat.events],
    // The beat's own verb, and only the beat's.
    actions: [...beat.actions],
    objects: [...beat.objects],
    time: [...beat.time],
    years: [...beat.years],
    evidence: beat.evidence,
  };

  /**
   * A scene token is re-minted as `scene_text` rather than copied.
   *
   * The source label is a claim about where a term came from, and RONDE 90 made that claim
   * checkable. Copying a token that says `beat_text` into a context whose beat never said it
   * would be a false claim with correct-looking offsets — the one failure mode the evidence
   * system exists to prevent.
   */
  const adopt = (
    target: QueryToken[],
    from: readonly QueryToken[],
    sceneEvidence: string
  ): void => {
    for (const token of from) {
      if (!token.verified || !token.term.trim()) continue;
      if (target.some((t) => t.term.toLowerCase() === token.term.toLowerCase())) continue;
      target.push(provenToken(token.term, token.type, "scene_text", sceneEvidence));
    }
  };

  const sceneEvidence = scene.evidence ?? "";
  adopt(merged.persons, scene.persons, sceneEvidence);
  adopt(merged.places, scene.places, sceneEvidence);
  adopt(merged.countries, scene.countries, sceneEvidence);
  adopt(merged.events, scene.events, sceneEvidence);
  adopt(merged.objects, scene.objects, sceneEvidence);
  adopt(merged.time, scene.time, sceneEvidence);
  adopt(merged.years, scene.years, sceneEvidence);
  return merged;
}

/**
 * RONDE 134 §19 — is this actually a better question, or the same one again?
 *
 * Deliberately not a length rule. "Hermann Göring Berlin" and "Berlin Hermann Göring" differ in no
 * character count that matters and ask the same thing; "Hermann Göring Berlin 1945" is longer AND
 * asks something narrower, and it is the second property that makes it worth a provider call.
 *
 * So: compare the SET of content words, ignoring order, case and the production vocabulary that
 * carries no subject. A candidate that adds nothing the original did not already contain is the
 * original.
 */
export function queryImprovesOn(original: string, candidate: string): boolean {
  const words = (s: string): Set<string> =>
    new Set(
      (s ?? "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}'’-]+/u)
        .filter(Boolean)
    );
  const a = words(original);
  const b = words(candidate);
  if (b.size === 0) return false;
  for (const w of b) {
    if (!a.has(w)) return true;
  }
  return false;
}

/**
 * Pick the corrected question.
 *
 * The candidates are ranked by SPECIFICITY first and by the contract's own priority second.
 * `level` is RONDE 103's reading of how narrow a question is — 4 is an event with its context, 1
 * is a bare entity — so preferring a higher level is preferring the narrower question, which is
 * the entire point of correcting after a mismatch. Within a level the contract's order stands,
 * because that order is what every round since RONDE 73 built.
 */
export function selectCorrectedQueries(params: {
  ctx: VerifiedQueryContext;
  strategy: CorrectionStrategy;
  /** Queries this beat has already been searched with. A repeat is not a correction. */
  alreadyUsed?: readonly string[];
}): string[] {
  const required = STRATEGY_REQUIRES[params.strategy];
  const order = STRATEGY_PRIORITY[params.strategy];
  const used = (params.alreadyUsed ?? []).map((q) => (q ?? "").trim()).filter(Boolean);
  const usedExact = new Set(used.map((q) => q.toLowerCase()));

  return buildPrioritisedQueries(params.ctx)
    .filter((q) => carriesAnyType(q, required))
    .filter((q) => !usedExact.has(q.query.trim().toLowerCase()))
    /**
     * RONDE 134 §19 — a candidate that says nothing the old questions did not already say is the
     * old question with the words shuffled. Checked against EVERY query already tried, not only
     * the last one: a beat that has asked "Hermann Göring Berlin" and "Berlin 1945" is not helped
     * by being handed either of them back under a different sort order.
     */
    .filter((q) => used.length === 0 || used.some((u) => queryImprovesOn(u, q.query)))
    .sort(
      (a, b) =>
        priorityScore(b, order) - priorityScore(a, order) ||
        b.level - a.level ||
        a.priority - b.priority
    )
    .map((q) => q.query);
}

/**
 * Should this beat go and look again?
 *
 * `alreadyResearched` is passed in rather than tracked here: the one-pass limit belongs to the
 * render's own per-beat state, and a module-level set would silently merge two concurrent renders
 * — the bug class that moved the gate state into RenderCtx in RONDE 58.
 */
export function decideResearch(params: {
  kind: MismatchKind;
  /**
   * The beat's proven context. Pass the merged one from `buildResearchContext` when a scene
   * context is available — RONDE 134 §2/§3.
   */
  ctx: VerifiedQueryContext;
  alreadyResearched: boolean;
  alreadyUsed?: readonly string[];
  /** How many corrected queries the caller is willing to run. Bounded by the caller's budget. */
  maxQueries?: number;
  /**
   * RONDE 134 §20 — milliseconds of render left, when the caller tracks one.
   *
   * Omitted means the caller does not track a budget and the question is skipped rather than
   * guessed at — the same contract `shouldRetryAfterFailure` uses in ./providerFailureClass.
   */
  remainingBudgetMs?: number;
  /** What one research pass is expected to cost. Defaults to a conservative single-beat search. */
  estimatedCostMs?: number;
}): ResearchDecision {
  const { kind } = params;
  const blame = mismatchFault(kind);

  if (params.alreadyResearched) {
    return { action: "NONE", kind, blame, reason: "ALREADY_RESEARCHED" };
  }

  const strategy = correctionStrategyFor(kind);
  if (!strategy) {
    return { action: "NONE", kind, blame, reason: blame === "MATERIAL" ? "MATERIAL" : "UNCLEAR" };
  }

  /**
   * Checked before the queries are built, because a render with no time left does not benefit
   * from knowing what it would have asked.
   */
  const remaining = params.remainingBudgetMs;
  if (typeof remaining === "number" && Number.isFinite(remaining)) {
    if (remaining < (params.estimatedCostMs ?? RESEARCH_ESTIMATED_COST_MS)) {
      return { action: "NONE", kind, blame, reason: "BUDGET_EXCEEDED" };
    }
  }

  const ranked = selectCorrectedQueries({
    ctx: params.ctx,
    strategy,
    alreadyUsed: params.alreadyUsed,
  });
  /**
   * RONDE 134 §6 — narrow first, then ONE deliberate step wider. Then stop.
   *
   * The ranking above puts the most specific correction first, which is right: "Hermann Göring
   * Berlin 1945" is the question the refusal argued for. But a very specific question is also the
   * one an archive is most likely to answer with nothing, and taking the next-best by the same
   * ranking gives a second query that is just as narrow — "Hermann Göring Berlin April 1945" —
   * which fails in the same way for the same reason.
   *
   * RONDE 132 and 133 got this progression by accident, out of the contract's own priority order,
   * and adding the priority ranking took it away. It is deliberate now: the second query is the
   * BROADEST remaining one that still carries the dimension the refusal named. Two questions, one
   * narrow and one wide, and no third.
   */
  const cap = Math.max(1, params.maxQueries ?? 2);
  const queries = ranked.slice(0, 1);
  if (cap > 1 && ranked.length > 1) {
    const contentWords = (q: string): number => q.split(/\s+/).filter(Boolean).length;
    const broadest = ranked
      .slice(1)
      .reduce((a, b) => (contentWords(b) < contentWords(a) ? b : a));
    if (broadest && contentWords(broadest) < contentWords(queries[0]!)) queries.push(broadest);
  }

  if (queries.length === 0) {
    return { action: "NONE", kind, blame, reason: "NO_BETTER_QUERY" };
  }

  return {
    action: "RESEARCH",
    kind,
    blame,
    strategy,
    correctedQuery: queries[0]!,
    correctedQueries: queries,
  };
}

// ─── Counters, so a render can say whether this actually helped ──────────────────────────────

export type ResearchTally = {
  /** Beats where a research pass was decided on and run. */
  attempts: number;
  /** Research passes that produced at least one new candidate. */
  produced: number;
  /** Research passes whose candidate the beat-image gate then accepted. */
  accepted: number;
  /** Research passes whose candidates the gate refused again. */
  rejected: number;
  /** Refusals where research was NOT started, by reason. */
  skipped: Map<ResearchSkipReason, number>;
  /** Which strategy was used, counted. */
  byStrategy: Map<CorrectionStrategy, number>;
};

export function createResearchTally(): ResearchTally {
  return {
    attempts: 0,
    produced: 0,
    accepted: 0,
    rejected: 0,
    skipped: new Map(),
    byStrategy: new Map(),
  };
}

export function recordResearchSkip(tally: ResearchTally, reason: ResearchSkipReason): void {
  tally.skipped.set(reason, (tally.skipped.get(reason) ?? 0) + 1);
}

export function recordResearchAttempt(tally: ResearchTally, strategy: CorrectionStrategy): void {
  tally.attempts++;
  tally.byStrategy.set(strategy, (tally.byStrategy.get(strategy) ?? 0) + 1);
}

export function recordResearchOutcome(
  tally: ResearchTally,
  outcome: { produced: boolean; accepted: boolean }
): void {
  if (outcome.produced) tally.produced++;
  if (outcome.accepted) tally.accepted++;
  else if (outcome.produced) tally.rejected++;
}

// ─── The log lines the brief specifies ───────────────────────────────────────────────────────

export function formatResearchDecision(beatLabel: string, decision: ResearchDecision): string {
  if (decision.action === "NONE") {
    return (
      `[MismatchResearch] beat=${beatLabel} mismatch=${decision.kind} ` +
      `blame=${decision.blame} action=NONE reason=${decision.reason}`
    );
  }
  return (
    `[MismatchResearch] beat=${beatLabel} mismatch=${decision.kind} ` +
    `blame=${decision.blame} action=RESEARCH strategy=${decision.strategy}`
  );
}

/**
 * RONDE 134 §21 — what the research pass actually had to work with.
 *
 * Printed alongside the decision so a production log answers "why did it correct THAT" without
 * anyone re-deriving the extraction. Sources are shown because a scene-derived year and a
 * beat-derived one are different claims, and the difference is the whole of RONDE 134's §3.
 */
export function formatResearchContext(beatLabel: string, ctx: VerifiedQueryContext): string {
  const show = (list: readonly QueryToken[]): string => {
    const kept = list.filter((t) => t.verified).slice(0, 4);
    if (kept.length === 0) return "[]";
    return `[${kept.map((t) => `${t.term}${t.source === "scene_text" ? "*" : ""}`).join(", ")}]`;
  };
  return (
    `[MismatchResearch] beat=${beatLabel} context ` +
    `persons=${show(ctx.persons)} places=${show([...ctx.places, ...ctx.countries])} ` +
    `years=${show(ctx.years)} time=${show(ctx.time)} events=${show(ctx.events)} ` +
    `(* = proven by the scene, not the beat)`
  );
}

export function formatResearchQuery(
  beatLabel: string,
  originalQuery: string,
  correctedQuery: string
): string {
  return (
    `[MismatchResearch] beat=${beatLabel} originalQuery="${originalQuery.slice(0, 80)}" ` +
    `correctedQuery="${correctedQuery.slice(0, 80)}"`
  );
}

export function formatResearchProvider(beatLabel: string, provider: string, results: number): string {
  return `[MismatchResearch] beat=${beatLabel} provider=${provider} results=${results}`;
}

/**
 * RONDE 160 — one line per recovery, in the order a person reads it:
 *
 *     reason → strategy → query → results → eligible → adopted
 *
 * What this replaces printed `newCandidates=0|1`, which is a boolean wearing a number's clothes.
 * It could not tell the two failures apart, and they need opposite fixes:
 *
 *     results=0                       the corrected question found nothing — the catalogue is
 *                                     short, or the question is still wrong
 *     results=12 eligible=0           twelve came back and none survived validation
 *     results=12 eligible=9 adopted=0 nine were judged and the gate refused every one
 *
 * `results` is counted from the lineage ledger's own records — assets that entered the render
 * during this pass — rather than from a return value, so a pass that found footage and lost it
 * later still reports what it found.
 */
export function formatResearchOutcome(params: {
  beatLabel: string;
  /** The refusal that triggered this pass. */
  kind?: MismatchKind;
  strategy?: CorrectionStrategy;
  query?: string;
  /** Assets that entered the ledger during the pass. */
  results: number;
  /** Of those, the ones the beat-image gate actually judged. */
  eligible: number;
  /** Whether the beat came away with a picture. */
  adopted: number;
  gateFits: number;
  gateRejected: number;
}): string {
  const head = `[MismatchResearch] beat=${params.beatLabel}`;
  const reason = params.kind ? ` reason=${params.kind}` : "";
  const strategy = params.strategy ? ` strategy=${params.strategy}` : "";
  const query = params.query ? ` query="${params.query.slice(0, 120)}"` : "";
  // A negative count means the caller had no ledger to count from. Printed as unmeasured, never
  // as zero — "found nothing" is a finding and "nobody counted" is not.
  const results = params.results < 0 ? "NOT_MEASURED" : String(params.results);
  return (
    `${head}${reason}${strategy}${query} ` +
    `results=${results} eligible=${params.eligible} adopted=${params.adopted} ` +
    `gateFits=${params.gateFits} gateRejected=${params.gateRejected}`
  );
}

/** The render-end block. Empty when no refusal ever reached this module. */
export function formatResearchSummary(tally: ResearchTally): string {
  const skippedTotal = [...tally.skipped.values()].reduce((a, b) => a + b, 0);
  if (tally.attempts === 0 && skippedTotal === 0) return "";
  const strategies = [...tally.byStrategy.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n}x ${s}`)
    .join(" | ");
  const skips = [...tally.skipped.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${n}x ${r}`)
    .join(" | ");
  const lines = [
    `[MismatchResearch] attempts=${tally.attempts} produced=${tally.produced} ` +
      `accepted=${tally.accepted} rejected=${tally.rejected} skipped=${skippedTotal}`,
  ];
  if (strategies) lines.push(`  strategies   ${strategies}`);
  if (skips) lines.push(`  not started  ${skips}`);
  return lines.join("\n");
}
