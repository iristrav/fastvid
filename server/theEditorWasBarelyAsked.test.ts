import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  neverReachedEditor,
  formatVisionSelection,
  visionSelectionViolations,
  declareVisionReviewPool,
  noteVisionReviewed,
  createVisionReviewPoolState,
} from "./visionAwareSelection";

/**
 * A CANDIDATE THE BEAT CHOSE TO ASK ABOUT AND NEVER ASKED.
 *
 * ── What render 579 measured ────────────────────────────────────────────────────────────────
 *
 *     [VisionSelection] TOTAL beats=18 reviewPool=23 reviewed=5 FIT=4 UNCLEAR=0
 *     [VisionSelection] s0b1 cap=8 reviewPool=1 reviewed=0 ... adopted=none
 *     [VisionSelection] s0b2 cap=8 reviewPool=1 reviewed=0 ... adopted=none
 *     ... thirteen of eighteen beats identical
 *
 * Eighteen of twenty-three declared candidates never reached the picture editor. Where it did look
 * it was decisive — four fits out of five — so the judgement was never the problem. It was barely
 * consulted.
 *
 * ── Why nobody could see it ─────────────────────────────────────────────────────────────────
 *
 * The gap was two numbers a reader had to subtract, and a subtraction has no name. `reviewPool=1
 * reviewed=0` reads as a quiet line. `neverReached=1` reads as a picture that was chosen, declared,
 * and dropped before the one gate that exists to judge it.
 *
 * Between `declareVisionReviewPool` and the first `noteVisionReviewed` in the adoption loop there
 * are THIRTY-ONE `continue` statements and exactly ONE call to `noteNotAsked`. Thirty of the
 * thirty-one ways out file nothing — the codebase's recurring shape again: a rule N exits must
 * follow, registered by one of them.
 *
 * ── Why the accounting is derived rather than annotated ─────────────────────────────────────
 *
 * Annotating thirty exits leaves exit thirty-two to be forgotten by whoever adds it, which is how
 * this shape keeps recurring. Derived from the two lists the pool already keeps, it cannot be
 * forgotten by a gate added later: a declared candidate with no answer IS the finding, however it
 * left. What it does not claim is WHICH gate — that is not in these lists, and inventing an
 * attribution would be worse than the silence it replaces.
 */

const KEY = (n: number) => `content:asset${n}`;

function poolWith(declared: string[], answered: string[]) {
  const state = createVisionReviewPoolState();
  declareVisionReviewPool(
    state,
    1,
    1,
    declared.map((contentKey, i) => ({ contentKey, cheapRank: i })),
    8
  );
  for (const contentKey of answered) {
    noteVisionReviewed(state, 1, 1, { contentKey, cheapRank: 0, evidence: "FIT" });
  }
  return state;
}

describe("the pool says how many of its own questions went unasked", () => {
  it("RENDER 579'S BEAT: ONE DECLARED, NONE ANSWERED", () => {
    const state = poolWith([KEY(1)], []);
    const pool = [...state.beats.values()][0]!;
    expect(neverReachedEditor(pool)).toEqual([KEY(1)]);
  });

  it("a fully answered pool reports nothing", () => {
    const state = poolWith([KEY(1), KEY(2)], [KEY(1), KEY(2)]);
    expect(neverReachedEditor([...state.beats.values()][0]!)).toEqual([]);
  });

  it("and a partly answered one reports exactly the remainder", () => {
    const state = poolWith([KEY(1), KEY(2), KEY(3)], [KEY(2)]);
    expect(neverReachedEditor([...state.beats.values()][0]!)).toEqual([KEY(1), KEY(3)]);
  });

  it("A BEAT THAT DECLARED NOTHING IS NOT ACCUSED OF ANYTHING", () => {
    /**
     * An empty pool means no candidate was ever chosen for this beat — a retrieval finding, not a
     * review finding. Counting it here would blame the editor for a beat nothing was offered to.
     */
    const state = poolWith([], []);
    expect(neverReachedEditor([...state.beats.values()][0]!)).toEqual([]);
  });

  it("an answer for a candidate that was never declared does not mask a real gap", () => {
    /**
     * The two lists are independent — a route can answer about a clip outside the declared cut.
     * Set subtraction runs one way on purpose: the gap is about what was PROMISED and not kept.
     */
    const state = poolWith([KEY(1)], [KEY(9)]);
    expect(neverReachedEditor([...state.beats.values()][0]!)).toEqual([KEY(1)]);
  });
});

describe("the render log names the number and the assets behind it", () => {
  it("THE PER-BEAT LINE CARRIES neverReached", () => {
    const lines = formatVisionSelection(poolWith([KEY(1), KEY(2)], [KEY(1)]));
    expect(lines.find((l) => l.includes("s1b1 cap="))).toContain("neverReached=1");
  });

  it("and the TOTAL carries it too", () => {
    const lines = formatVisionSelection(poolWith([KEY(1), KEY(2), KEY(3)], [KEY(1)]));
    const total = lines.find((l) => l.includes("TOTAL"))!;
    expect(total).toContain("reviewPool=3");
    expect(total).toContain("reviewed=1");
    expect(total).toContain("neverReached=2");
  });

  it("EACH ONE IS NAMED, because a count cannot be followed back to an asset", () => {
    /**
     * The same reason the `unusable` rows are printed individually. Without the identity there is
     * no way to ask what happened to any one of these pictures.
     */
    const lines = formatVisionSelection(poolWith([KEY(1), KEY(2)], []));
    const named = lines.filter((l) => l.includes("neverReached content:"));
    expect(named).toHaveLength(2);
    expect(named[0]).toContain("no verdict was ever filed");
  });

  it("the existing columns are untouched", () => {
    const line = formatVisionSelection(poolWith([KEY(1)], [KEY(1)])).find((l) =>
      l.includes("s1b1 cap=")
    )!;
    for (const col of ["reviewPool=", "reviewed=", "FIT=", "UNREVIEWED=", "UNCLEAR=", "MISMATCH=", "unusable=", "finalShortlisted=", "best=", "adopted="]) {
      expect(line, `${col} was dropped from the line`).toContain(col);
    }
  });
});

describe("a declared pool that asked nothing is a violation, not a note", () => {
  it("POOL_DECLARED_NOTHING_REVIEWED FIRES ON RENDER 579'S SHAPE", () => {
    const violations = visionSelectionViolations(poolWith([KEY(1)], []));
    const hit = violations.find((v) => v.includes("POOL_DECLARED_NOTHING_REVIEWED"));
    expect(hit, "thirteen beats of render 579 would still pass silently").toBeTruthy();
    expect(hit).toContain("declared=1 reviewed=0");
    expect(hit).toContain("s1b1");
  });

  it("and not when a single question was asked", () => {
    /**
     * Deliberately the complete-bypass case only. A beat that asked one of three is a budget
     * question and shows up as `neverReached=2` on its own line; calling that a broken invariant
     * too would make the violation list fire on most healthy renders and stop being read.
     */
    const violations = visionSelectionViolations(poolWith([KEY(1), KEY(2), KEY(3)], [KEY(1)]));
    expect(violations.find((v) => v.includes("POOL_DECLARED_NOTHING_REVIEWED"))).toBeUndefined();
  });

  it("nor on a beat that declared nothing", () => {
    const violations = visionSelectionViolations(poolWith([], []));
    expect(violations.find((v) => v.includes("POOL_DECLARED_NOTHING_REVIEWED"))).toBeUndefined();
  });

  it("THE EXISTING INVARIANTS STILL FIRE", () => {
    /**
     * The two budget invariants catch a pool PROMISING more than it can pay for. The new one
     * catches the opposite — a budget never spent — and adding it must not have displaced them.
     */
    const src = readFileSync(join(__dirname, "visionAwareSelection.ts"), "utf8");
    expect(src).toContain("REVIEW_POOL_OVER_BUDGET");
    expect(src).toContain("REVIEWED_OVER_BUDGET");
    expect(src).toContain("MISMATCH_ADOPTED_OVER_AVAILABLE");
  });
});

describe("the finding reaches the render log", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("BOTH REPORTERS ARE STILL CONSUMED, AND THE VIOLATIONS WARN", () => {
    /**
     * A measurement nothing prints is the defect this whole round is about. Asserted rather than
     * assumed: `formatVisionSelection` carries the counts and `visionSelectionViolations` carries
     * the bypass, and neither is worth anything unless a caller reads it back out.
     */
    const format = PIPE.indexOf("formatVisionSelection(visualDedup.visionReviewPool)");
    const violations = PIPE.indexOf("visionSelectionViolations(visualDedup.visionReviewPool)");
    expect(format).toBeGreaterThan(-1);
    expect(violations).toBeGreaterThan(-1);
    expect(PIPE.slice(violations, violations + 200)).toContain("console.warn");
  });

  it("no gate, cap or budget was moved to produce the number", () => {
    /**
     * This round measures; it changes no decision. Raising the look budget because the editor was
     * barely asked would be answering a question nobody has established yet — the count is what
     * says whether the cause is budget at all.
     */
    const src = readFileSync(join(__dirname, "visionAwareSelection.ts"), "utf8");
    expect(src).toContain("if (pool.declared.length > 0) return;");
    expect(src).toContain("pool.declared = buildVisionReviewPool(ranked, cap).map");
  });
});
