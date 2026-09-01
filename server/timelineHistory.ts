/**
 * RONDE 166 (§13) — Undo and Redo for timeline edits.
 *
 * ── Why snapshots and not a command log ──────────────────────────────────────────────────────
 *
 * §13 lists eight kinds of mutation that must be undoable: replace clip, transform, camera,
 * effects, transitions, text, graphics, audio. A command log needs one INVERSE per kind, and every
 * inverse is a separate place to get it wrong — the classic failure being an undo that restores the
 * clip but not the caption that moved with it, leaving a document that never existed.
 *
 * A `ProjectTimeline` is a plain serialisable document, so a document IS its own inverse. Undo
 * restores a whole earlier timeline, which means all eight mutation kinds are covered by
 * construction and a ninth added tomorrow is covered without touching this file.
 *
 * ── "Geen tweede timeline-state die losstaat van ProjectTimeline" ───────────────────────────
 *
 * The present is not a copy of the timeline or a projection of it: `present` IS the
 * `ProjectTimeline`, the same object the renderer, the editor and the persistence layer already
 * read. This adds two lists of previous documents beside it and nothing else — no parallel model,
 * no diff format, no second source of truth about what the edit currently is.
 *
 * ── The one thing that is NOT restored ──────────────────────────────────────────────────────
 *
 * `version` keeps counting forward. See `undo` for why: restoring an old version number alongside
 * old content would put two DIFFERENT documents into circulation under one version, and the
 * optimistic-concurrency check in `timeline.save` would then let one silently overwrite the other.
 * An undo is an edit like any other, and it gets the next version number like any other.
 */
import { bumpVersion, timelineDigest, type ProjectTimeline } from "./projectTimeline";

/**
 * How many previous documents to keep.
 *
 * A timeline is a few tens of kilobytes, so a deep stack is cheap and an unbounded one is not: an
 * editor left open all day would grow without limit. Fifty steps is far more than a person undoes
 * in practice, and the oldest is dropped rather than the newest refused.
 */
export const MAX_HISTORY = 50;

export type TimelineHistory = {
  past: ProjectTimeline[];
  present: ProjectTimeline;
  future: ProjectTimeline[];
};

export function newHistory(present: ProjectTimeline): TimelineHistory {
  return { past: [], present, future: [] };
}

export const canUndo = (h: TimelineHistory): boolean => h.past.length > 0;
export const canRedo = (h: TimelineHistory): boolean => h.future.length > 0;

/**
 * Record an edit.
 *
 * ── Why an identical document is not recorded ────────────────────────────────────────────────
 *
 * The editor saves on a schedule as well as on a change, so the same document arrives repeatedly.
 * Pushing each one would fill the stack with steps that undo nothing, and a person pressing undo
 * would watch nothing happen several times before something did. `timelineDigest` is the existing
 * content identity — it deliberately ignores `version` and `createdAt` — so two saves of the same
 * edit are recognised as the same edit.
 */
export function recordEdit(h: TimelineHistory, next: ProjectTimeline): TimelineHistory {
  if (timelineDigest(next) === timelineDigest(h.present)) return h;
  const past = [...h.past, h.present];
  return {
    past: past.length > MAX_HISTORY ? past.slice(past.length - MAX_HISTORY) : past,
    present: next,
    /**
     * A new edit ABANDONS the redo stack. Keeping it would let a person undo, edit, then redo into
     * a document built from a branch they had already left — the timeline would gain changes they
     * never made from a future that no longer exists.
     */
    future: [],
  };
}

/**
 * Step back one edit.
 *
 * The restored document keeps the OLD CONTENT and takes a NEW version number, which is the whole
 * subtlety of undo against a versioned store. Restoring version 3's content under version 3 would
 * mean two different documents in circulation as "version 3": the one that is stored and the one
 * that was just undone to. `timeline.save` compares versions to detect a concurrent edit, so it
 * would see no conflict and let one overwrite the other without a word.
 *
 * Counting forward instead makes an undo an ordinary edit: newer than what came before, detectable
 * by the concurrency check, and re-renderable by a job that names its version.
 */
export function undo(h: TimelineHistory): TimelineHistory {
  const previous = h.past[h.past.length - 1];
  if (!previous) return h;
  return {
    past: h.past.slice(0, -1),
    present: bumpVersion({ ...previous, version: h.present.version }),
    /** The document being left is what redo comes back to — with its own content, not its number. */
    future: [h.present, ...h.future],
  };
}

/** Step forward again, on the same terms: old content, next version. */
export function redo(h: TimelineHistory): TimelineHistory {
  const next = h.future[0];
  if (!next) return h;
  return {
    past: [...h.past, h.present],
    present: bumpVersion({ ...next, version: h.present.version }),
    future: h.future.slice(1),
  };
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
