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
  type PrioritisedQuery,
  type QueryTokenType,
  type VerifiedQueryContext,
} from "./searchQueryContract";
import { mismatchFault, type MismatchFault, type MismatchKind } from "./visualMismatchFeedback";

/** What a correction is trying to add to the question. */
export type CorrectionStrategy =
  /** Add the period the narration states. */
  | "ADD_TIME"
  /** Put the person back at the front of the question. */
  | "ADD_PERSON"
  /** Add the place the narration states. */
  | "ADD_PLACE"
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
  MOST_SPECIFIC: [],
};

/** The correction each kind argues for, or null when the kind argues for no new question at all. */
export function correctionStrategyFor(kind: MismatchKind): CorrectionStrategy | null {
  switch (kind) {
    case "WRONG_PERIOD":
      return "ADD_TIME";
    case "WRONG_SUBJECT":
      return "ADD_PERSON";
    case "WRONG_PLACE":
      return "ADD_PLACE";
    case "UNRELATED":
      return "MOST_SPECIFIC";
    // A title card and a piece to camera are answers to a question that was asked correctly.
    case "TEXT_ON_SCREEN":
    case "TALKING_HEAD":
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
  | "NO_BETTER_QUERY";

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
  const used = new Set((params.alreadyUsed ?? []).map((q) => q.trim().toLowerCase()).filter(Boolean));

  return buildPrioritisedQueries(params.ctx)
    .filter((q) => carriesAnyType(q, required))
    .filter((q) => !used.has(q.query.trim().toLowerCase()))
    .sort((a, b) => b.level - a.level || a.priority - b.priority)
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
  ctx: VerifiedQueryContext;
  alreadyResearched: boolean;
  alreadyUsed?: readonly string[];
  /** How many corrected queries the caller is willing to run. Bounded by the caller's budget. */
  maxQueries?: number;
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

  const queries = selectCorrectedQueries({
    ctx: params.ctx,
    strategy,
    alreadyUsed: params.alreadyUsed,
  }).slice(0, Math.max(1, params.maxQueries ?? 2));

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

export function formatResearchOutcome(params: {
  beatLabel: string;
  newCandidates: number;
  gateFits: number;
  gateRejected: number;
}): string {
  return (
    `[MismatchResearch] beat=${params.beatLabel} newCandidates=${params.newCandidates} ` +
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
