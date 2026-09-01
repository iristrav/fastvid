/**
 * Undo and Redo, as pure mechanics — shared by the server and the editor UI.
 *
 * ── RONDE 181: why this moved here ───────────────────────────────────────────────────────────
 *
 * R166 built this in `server/timelineHistory.ts` and nothing ever called it. R181's job was to put
 * the buttons in the editor, and that ran straight into the reason it had stayed unwired: the
 * server module imports `projectTimeline`, which reaches node's `crypto` for `timelineDigest`. A
 * browser bundle cannot follow it.
 *
 * The alternative — a second undo implementation inside the React component — is the thing this
 * codebase forbids most consistently, and for a good reason here in particular: two stacks with
 * slightly different rules about when a step is recorded would disagree about what "one undo" is,
 * and the disagreement would only show up as a person pressing undo and getting the wrong document.
 *
 * So the MECHANICS live here with no imports at all, and the two POLICIES they need are injected:
 *
 *   · `sameContent` — when are two documents the same edit. The server answers with
 *     `timelineDigest`; the editor answers with the structural comparison it already uses to
 *     decide whether the draft is dirty. Both are "the content, ignoring the version".
 *   · `restore` — what a restored document looks like. Both sides answer "the old content under a
 *     NEW version number", which is the whole subtlety of undo against a versioned store; see
 *     `undo` below.
 *
 * ── Why snapshots and not a command log ──────────────────────────────────────────────────────
 *
 * §13 lists eight kinds of mutation that must be undoable: replace clip, transform, camera,
 * effects, transitions, text, graphics, audio. A command log needs one INVERSE per kind, and every
 * inverse is a separate place to get it wrong — the classic failure being an undo that restores the
 * clip but not the caption that moved with it, leaving a document that never existed.
 *
 * A timeline is a plain serialisable document, so a document IS its own inverse. Undo restores a
 * whole earlier document, which means all eight mutation kinds are covered by construction and a
 * ninth added tomorrow is covered without touching this file.
 *
 * ── "Geen tweede timeline-state die losstaat van ProjectTimeline" ───────────────────────────
 *
 * `present` IS the document — the same object the renderer, the editor and the persistence layer
 * already read. This adds two lists of previous documents beside it and nothing else: no parallel
 * model, no diff format, no second source of truth about what the edit currently is.
 */

/**
 * How many previous documents to keep.
 *
 * A timeline is a few tens of kilobytes, so a deep stack is cheap and an unbounded one is not: an
 * editor left open all day would grow without limit. Fifty steps is far more than a person undoes
 * in practice, and the oldest is dropped rather than the newest refused.
 */
export const MAX_HISTORY = 50;

export type History<T> = {
  past: T[];
  present: T;
  future: T[];
};

/** The two decisions this module does not make for itself. */
export type HistoryPolicy<T> = {
  /** Are these two documents the same EDIT — content only, version ignored. */
  sameContent: (a: T, b: T) => boolean;
  /** The document to put back: `previous`'s content, carrying `current`'s place in the sequence. */
  restore: (previous: T, current: T) => T;
};

export function newHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export const canUndo = <T>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T>(h: History<T>): boolean => h.future.length > 0;

/**
 * Record an edit.
 *
 * ── Why an identical document is not recorded ────────────────────────────────────────────────
 *
 * The editor saves on a schedule as well as on a change, so the same document arrives repeatedly.
 * Pushing each one would fill the stack with steps that undo nothing, and a person pressing undo
 * would watch nothing happen several times before something did. `sameContent` is the caller's
 * content identity — it ignores the version by construction — so two saves of the same edit are
 * recognised as the same edit.
 */
export function recordEdit<T>(h: History<T>, next: T, policy: HistoryPolicy<T>): History<T> {
  if (policy.sameContent(next, h.present)) return h;
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
export function undo<T>(h: History<T>, policy: HistoryPolicy<T>): History<T> {
  const previous = h.past[h.past.length - 1];
  if (previous === undefined) return h;
  return {
    past: h.past.slice(0, -1),
    present: policy.restore(previous, h.present),
    /** The document being left is what redo comes back to — with its own content, not its number. */
    future: [h.present, ...h.future],
  };
}

/** Step forward again, on the same terms: old content, next version. */
export function redo<T>(h: History<T>, policy: HistoryPolicy<T>): History<T> {
  const next = h.future[0];
  if (next === undefined) return h;
  return {
    past: [...h.past, h.present],
    present: policy.restore(next, h.present),
    future: h.future.slice(1),
  };
}
