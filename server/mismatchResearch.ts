

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
