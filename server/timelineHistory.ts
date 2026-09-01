/**
 * RONDE 166 (§13) — Undo and Redo for timeline edits, bound to the ProjectTimeline.
 *
 * ── RONDE 181: what moved, and what did not ──────────────────────────────────────────────────
 *
 * The mechanics — the past/present/future stacks, the cap, the rule that a new edit abandons the
 * redo stack — are now in `shared/timelineHistory.ts`, because the editor UI needs exactly the same
 * ones and could not import this file: it reaches `projectTimeline`, which reaches node's `crypto`.
 *
 * Writing a second stack inside the React component was the alternative and it is the wrong one:
 * two stacks with slightly different rules about when a step is recorded would disagree about what
 * "one undo" is, and the disagreement would surface as a person pressing undo and getting the wrong
 * document back.
 *
 * What stays here is the POLICY for a `ProjectTimeline`, and it is unchanged: `timelineDigest` is
 * the content identity, and a restored document keeps the old content under a NEW version number.
 * Every export below keeps its signature, so no caller of this module sees a difference.
 */
import { bumpVersion, timelineDigest, type ProjectTimeline } from "./projectTimeline";
import {
  MAX_HISTORY,
  canRedo as canRedoCore,
  canUndo as canUndoCore,
  newHistory as newHistoryCore,
  recordEdit as recordEditCore,
  redo as redoCore,
  undo as undoCore,
  type History,
  type HistoryPolicy,
} from "../shared/timelineHistory";

export { MAX_HISTORY };

export type TimelineHistory = History<ProjectTimeline>;

/**
 * The two decisions the shared mechanics leave to the document's owner.
 *
 * `sameContent` is `timelineDigest`, which deliberately excludes `version` and `createdAt` — so two
 * saves of one edit are one edit. `restore` is the old content under the next version number; see
 * the note on `undo` in the shared module for why restoring the old NUMBER would let two different
 * documents circulate as one version and slip past the concurrency check in `timeline.save`.
 */
const POLICY: HistoryPolicy<ProjectTimeline> = {
  sameContent: (a, b) => timelineDigest(a) === timelineDigest(b),
  restore: (previous, current) => bumpVersion({ ...previous, version: current.version }),
};

export function newHistory(present: ProjectTimeline): TimelineHistory {
  return newHistoryCore(present);
}

export const canUndo = (h: TimelineHistory): boolean => canUndoCore(h);
export const canRedo = (h: TimelineHistory): boolean => canRedoCore(h);

export function recordEdit(h: TimelineHistory, next: ProjectTimeline): TimelineHistory {
  return recordEditCore(h, next, POLICY);
}

export function undo(h: TimelineHistory): TimelineHistory {
  return undoCore(h, POLICY);
}

export function redo(h: TimelineHistory): TimelineHistory {
  return redoCore(h, POLICY);
}

/**
 * Does this history describe the same edit as that one?
 *
 * Compares CONTENT, not version numbers — the question a test asks after an undo is "did I get my
 * old edit back", and the version is deliberately not part of that answer.
 */
export function sameEdit(a: ProjectTimeline, b: ProjectTimeline): boolean {
  return timelineDigest(a) === timelineDigest(b);
}

/** One line for the editor log. Counts and digests only — never the document. */
export function formatHistory(h: TimelineHistory): string {
  return (
    `[Editor] history undo=${h.past.length} redo=${h.future.length} ` +
    `version=${h.present.version} digest=${timelineDigest(h.present)}`
  );
}
