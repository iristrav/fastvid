/** Visual Matching Engine V2 — SelectionFeedback types.
 *
 *  Feedback is a third, independent data source — it never modifies beat_selection_traces
 *  or pipeline_run_traces. Traces remain immutable; feedback is linked to them by reference.
 *
 *  Data flow:
 *    beat_selection_traces ──┐
 *    pipeline_run_traces  ───┼──▶ VideoQualityReport
 *    selection_feedback   ───┘
 *
 *  Later:
 *    selection_feedback → EvaluationDataset → OfflineExperiments → WeightOptimizer
 *                                                                       → new RankingConfig */

// ─── Feedback types ─────────────────────────────────────────────────────────────

/** All possible human feedback verdicts for a single beat selection. */
export type FeedbackType =
  | "correct"             // selection was right
  | "wrong"               // selection was clearly wrong
  | "acceptable"          // not ideal but usable
  | "preferred_candidate" // a different candidate would have been better
  | "duplicate"           // selected clip appears elsewhere in the video
  | "bad_crop"            // clip is technically correct but framing is poor
  | "wrong_time_period"   // clip does not match the historical era
  | "wrong_location"      // clip shows wrong location
  | "wrong_subject"       // clip shows wrong person / entity
  | "low_quality"         // clip has visual quality issues (blur, artifacts)
  | "not_relevant"        // clip is unrelated to the beat content
  | "other";              // free-text only, see comment field

/** Version metadata captured at feedback submission time.
 *  Allows later analysis to answer "was this feedback given before or after
 *  ranking-config v5?" without joining back to the pipeline trace. */
export type FeedbackVersionContext = {
  /** e.g. "visual-matching-v2" */
  pipelineVersion: string | null;
  /** e.g. "v2" */
  engineVersion: string | null;
  /** e.g. "gpt-4o-mini" */
  visionModel: string | null;
  /** e.g. "voyage-3" */
  embeddingModel: string | null;
  /** e.g. "1" — RANKING_VERSION constant */
  rankingConfigVersion: string | null;
};

/** One piece of feedback for one beat selection. Links to the beat trace by
 *  (pipelineRunId, beatId). candidateId identifies which candidate the reviewer assessed —
 *  usually the selected one, but may point to a rejected candidate for comparison. */
export type SelectionFeedback = FeedbackVersionContext & {
  id: number;
  pipelineRunId: string;
  beatId: string;
  candidateId: string;
  feedbackType: FeedbackType;
  /** Optional free-text annotation. Required when feedbackType === "other". */
  comment: string | null;
  /** User identifier of the reviewer — email, userId, or system label ("auto"). */
  createdBy: string;
  createdAt: string;   // ISO
  updatedAt: string;   // ISO — tracks the latest edit; equals createdAt for new rows
};

/** All fields except id, createdAt, updatedAt. Version fields are optional —
 *  the store fills in current constants when omitted. */
export type InsertSelectionFeedback = Omit<SelectionFeedback, "id" | "createdAt" | "updatedAt"> &
  Partial<FeedbackVersionContext>;

// ─── Event log ──────────────────────────────────────────────────────────────────

/** Every change to a SelectionFeedback row is appended here — never updated or deleted.
 *  Keeps SelectionFeedback as the current state; this table is the complete history.
 *  "restored" covers soft-delete undo. */
export type FeedbackEventType = "created" | "updated" | "deleted" | "restored";

export type SelectionFeedbackEvent = {
  id: number;
  feedbackId: number;
  eventType: FeedbackEventType;
  /** Full SelectionFeedback snapshot at the time of the event, serialized as JSON. */
  snapshot: string;
  /** Identity of the person or system that triggered this event. */
  actor: string;
  changedAt: string;  // ISO
};

// ─── Store interface ────────────────────────────────────────────────────────────

export interface SelectionFeedbackStore {
  /** Records new feedback for a beat selection. Returns the stored row including id. */
  submit(feedback: InsertSelectionFeedback): Promise<SelectionFeedback>;
  /** Retrieves all feedback for a given pipeline run. */
  listByRun(pipelineRunId: string): Promise<SelectionFeedback[]>;
  /** Retrieves all feedback for a given beat across all runs. */
  listByBeat(beatId: string): Promise<SelectionFeedback[]>;
}
