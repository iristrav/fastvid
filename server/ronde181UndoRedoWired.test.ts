/**
 * RONDE 181 — Undo and Redo exist in the EDITOR, not only in a module nobody imported.
 *
 * ── The gap ──────────────────────────────────────────────────────────────────────────────────
 *
 * R166 §13 built `server/timelineHistory.ts`, tested it, and left it with zero callers — server or
 * client. A person editing a video could not undo anything.
 *
 * Wiring it ran straight into why it had stayed unwired: the server module imports
 * `projectTimeline`, which reaches node's `crypto`, and a browser bundle cannot follow that. The
 * mechanics therefore moved to `shared/timelineHistory.ts` with no imports at all, and the two
 * policies they need — what counts as the same edit, and what a restored document looks like — are
 * injected by each side.
 *
 * Two halves here. The mechanics are EXERCISED, generically, because that is where the rules live.
 * The editor's wiring is asserted structurally: it is a React component in a browser bundle, and
 * what matters about it is that every edit path goes through the stack and no second stack exists.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";

import {
  MAX_HISTORY,
  canRedo,
  canUndo,
  newHistory,
  recordEdit,
  redo,
  undo,
  type HistoryPolicy,
} from "../shared/timelineHistory";

const UI = fs.readFileSync("client/src/components/VideoEditor.tsx", "utf8");

/* ═══════════════════════ the mechanics ═══════════════════════ */

type Doc = { version: number; text: string };

const POLICY: HistoryPolicy<Doc> = {
  sameContent: (a, b) => a.text === b.text,
  restore: (previous, current) => ({ ...previous, version: current.version + 1 }),
};

const doc = (text: string, version = 1): Doc => ({ version, text });

describe("R181 — the shared undo mechanics", () => {
  it("has nothing to undo until something is edited", () => {
    const h = newHistory(doc("a"));
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it("gives back the previous document's content", () => {
    let h = newHistory(doc("a"));
    h = recordEdit(h, doc("b", 2), POLICY);
    h = undo(h, POLICY);
    expect(h.present.text).toBe("a");
  });

  /**
   * The whole subtlety of undo against a versioned store. Restoring version 1's content UNDER
   * version 1 would put two different documents into circulation as "version 1", and `timeline.save`
   * compares versions to detect a concurrent edit — so it would see no conflict and let one
   * silently overwrite the other.
   */
  it("restores old content under a NEW version, never the old number", () => {
    let h = newHistory(doc("a", 1));
    h = recordEdit(h, doc("b", 2), POLICY);
    h = undo(h, POLICY);
    expect(h.present.text).toBe("a");
    expect(h.present.version).toBe(3);
  });

  it("redo comes back to the document that was left", () => {
    let h = newHistory(doc("a"));
    h = recordEdit(h, doc("b", 2), POLICY);
    h = undo(h, POLICY);
    expect(canRedo(h)).toBe(true);
    h = redo(h, POLICY);
    expect(h.present.text).toBe("b");
  });

  /**
   * A new edit abandons the redo stack. Keeping it would let a person undo, edit, then redo into a
   * document built from a branch they had already left — the timeline would gain changes they never
   * made, from a future that no longer exists.
   */
  it("an edit after an undo abandons the redo stack", () => {
    let h = newHistory(doc("a"));
    h = recordEdit(h, doc("b", 2), POLICY);
    h = undo(h, POLICY);
    h = recordEdit(h, doc("c", 4), POLICY);
    expect(canRedo(h)).toBe(false);
  });

  /**
   * The editor saves on a schedule as well as on a change, so the same document arrives repeatedly.
   * Recording each one would fill the stack with steps that undo nothing.
   */
  it("does not record a document identical in content", () => {
    let h = newHistory(doc("a", 1));
    h = recordEdit(h, doc("a", 2), POLICY);
    expect(canUndo(h)).toBe(false);
  });

  it("keeps the stack bounded, dropping the oldest rather than refusing the newest", () => {
    let h = newHistory(doc("start"));
    for (let i = 0; i < MAX_HISTORY + 10; i++) h = recordEdit(h, doc(`e${i}`, i + 2), POLICY);
    expect(h.past).toHaveLength(MAX_HISTORY);
    expect(h.present.text).toBe(`e${MAX_HISTORY + 9}`);
  });

  it("undo and redo at the ends of the stack change nothing", () => {
    const h = newHistory(doc("a"));
    expect(undo(h, POLICY)).toBe(h);
    expect(redo(h, POLICY)).toBe(h);
  });
});

/* ═══════════════════════ the server still behaves exactly as R166 built it ═══════════════════════ */

describe("R181 — the server binding is unchanged", () => {
  it("keeps every export R166 defined", async () => {
    const mod = await import("./timelineHistory");
    for (const name of [
      "MAX_HISTORY", "newHistory", "canUndo", "canRedo",
      "recordEdit", "undo", "redo", "sameEdit", "formatHistory",
    ]) {
      expect(mod, name).toHaveProperty(name);
    }
  });

  /** Its policy is still the digest, which is what makes two saves of one edit one edit. */
  it("still uses the timeline digest as its content identity", () => {
    const src = fs.readFileSync("server/timelineHistory.ts", "utf8");
    expect(src).toContain("timelineDigest(a) === timelineDigest(b)");
    expect(src).toContain("bumpVersion(");
  });
});

/* ═══════════════════════ the editor ═══════════════════════ */

describe("R181 — the editor uses the shared stack and has the buttons", () => {
  it("imports the shared mechanics rather than writing a second stack", () => {
    expect(UI).toContain('from "@shared/timelineHistory"');
    /** No local past/future arrays — that is what a second stack looks like. */
    expect(UI).not.toMatch(/useState<[^>]*\bpast\b/);
  });

  /**
   * The draft IS `history.present`. Two pieces of state both claiming to be the current edit is
   * exactly how an undo stack drifts out of step with what is on screen.
   */
  it("the draft is the history's present, not a state of its own", () => {
    expect(UI).toContain("const draft = history?.present ?? null;");
    expect(UI, "a separate draft state is back").not.toContain("setDraft(");
  });

  /**
   * Every edit goes through one function. A `setHistory` written inline somewhere would be an edit
   * the stack never saw, and undo would skip it.
   */
  it("every edit path goes through applyEdit", () => {
    expect(UI).toContain("const applyEdit = (next: (t: Timeline) => Timeline)");
    const edits = [...UI.matchAll(/applyEdit\(/g)];
    expect(edits.length, "no edit uses the stack").toBeGreaterThanOrEqual(4);
  });

  /**
   * A load and a save are NOT edits. Keeping the stack across a save would let a person undo to a
   * document the server no longer has, then save it back over their own saved work.
   */
  it("a load and a save start a fresh stack rather than becoming undoable steps", () => {
    const news = [...UI.matchAll(/setHistory\(newHistory\(/g)];
    expect(news.length, "a load or a save no longer resets the stack").toBeGreaterThanOrEqual(2);
  });

  it("has an Undo and a Redo control, disabled rather than hidden when empty", () => {
    expect(UI).toContain('aria-label="Undo"');
    expect(UI).toContain('aria-label="Redo"');
    expect(UI).toContain("disabled={!history || !canUndo(history)}");
    expect(UI).toContain("disabled={!history || !canRedo(history)}");
  });

  /** Nobody reaches for a toolbar to undo. */
  it("binds the keyboard, and leaves text fields alone", () => {
    expect(UI).toContain('e.key.toLowerCase() !== "z"');
    expect(UI).toContain("e.shiftKey");
    /** ⌘Z in a caption box means "undo my typing"; stealing it makes the field unusable. */
    expect(UI).toContain('tag === "input" || tag === "textarea"');
    expect(UI).toContain("isContentEditable");
  });

  /**
   * The restore policy, in the component. The version must move FORWARD on an undo for the same
   * reason it does on the server — see the mechanics test above.
   */
  it("restores old content under the next version number", () => {
    expect(UI).toContain("version: current.version + 1");
  });
});
