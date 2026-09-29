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
