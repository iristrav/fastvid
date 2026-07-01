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

/** One piece of feedback for one beat selection. Links to the beat trace by
 *  (pipelineRunId, beatId). candidateId identifies which candidate the reviewer assessed —
 *  usually the selected one, but may point to a rejected candidate for comparison. */
export type SelectionFeedback = {
  id: number;
  pipelineRunId: string;
  beatId: string;
  candidateId: string;
  feedbackType: FeedbackType;
  /** Optional free-text annotation. Required when feedbackType === "other". */
  comment: string | null;
  /** User identifier of the reviewer — email, userId, or system label ("auto"). */
  createdBy: string;
  createdAt: string;  // ISO
};

export type InsertSelectionFeedback = Omit<SelectionFeedback, "id" | "createdAt">;

// ─── Event log ──────────────────────────────────────────────────────────────────

/** Every change to a SelectionFeedback row is recorded here for audit purposes.
 *  Keeps SelectionFeedback itself as the current state; this table is the full history. */
export type FeedbackEventType = "created" | "updated" | "deleted";

export type SelectionFeedbackEvent = {
  id: number;
  feedbackId: number;
  eventType: FeedbackEventType;
  /** Full SelectionFeedback snapshot at the time of the event, serialized as JSON. */
  snapshot: string;
  changedBy: string;
  changedAt: string;
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
