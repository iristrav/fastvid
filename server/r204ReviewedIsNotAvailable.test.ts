/**
 * RONDE 204 — THE INVARIANT THAT ACCUSED THE RENDER OF A FAULT IT DID NOT COMMIT.
 *
 * ── The finding ─────────────────────────────────────────────────────────────────────────────
 *
 * `visionSelectionViolations` reports:
 *
 *     FIT_NOT_PREFERRED — a candidate the editor called a fit was passed over
 *
 * and it decided that from the review pool alone, which holds one fact per candidate: what the
 * picture editor answered. It does not hold, and could not hold, the other fact the sentence needs
 * — whether the beat could actually have used that candidate.
 *
 * Three exits in the adoption loop file a verdict on the pool and then leave the candidate behind
 * for a reason that has nothing to do with the picture:
 *
 *     recordAssetOutcome(… "invalid_file" …);      the file will not decode
 *     recordAssetOutcome(… "transform_failed" …);  a clip that MUST be transformed could not be
 *     recordAssetOutcome(… "transform_failed" …);  the same, at the loop's last exit
 *
 * Each of those runs AFTER `noteReviewedCandidate`. So a beat whose best picture was approved and
 * whose file then failed to open would adopt the runner-up and be reported as having ignored its
 * own picture editor. The violation named the wrong fault — a disobeyed verdict — and hid the real
 * one, a broken download, behind it.
 *
 * ── Why a mark and not a removal ────────────────────────────────────────────────────────────
 *
 * The question was asked and paid for. Deleting the row would make the beat look as though it had
 * spent fewer judgements than it did, which is the "metrics aanpassen om failures kleiner te laten
 * lijken" the brief forbids. The row stays, carries its reason, and `formatVisionSelection` prints
 * it — so the cost moves from invisible to named, and only the SELECTION stops counting it.
 *
 * ── What is deliberately NOT recorded here ──────────────────────────────────────────────────
 *
 * A refusal. "The editor said no" is a verdict, it lives in `evidence` as MISMATCH, and MISMATCH
 * already keeps a candidate out of every selection. Writing it into `unusable` as well would give
 * one fact two spellings that could later disagree — this codebase's most repeated fault, which
 * this round is closing, not adding to.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  bestByVisionEvidence,
  createVisionReviewPoolState,
  formatVisionSelection,
  isAvailableCandidate,
  noteVisionAdopted,
  noteVisionReviewed,
  noteVisionUnusable,
  visionAwareFinalShortlist,
  visionSelectionViolations,
  type ReviewedCandidate,
  type VisionEvidence,
} from "./visionAwareSelection";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const reviewed = (
  contentKey: string,
  cheapRank: number,
  evidence: VisionEvidence,
  unusable?: string
): ReviewedCandidate => ({ contentKey, cheapRank, evidence, ...(unusable ? { unusable } : {}) });

/** A pool with three candidates reviewed, in cheap-rank order. */
const poolOf = (...rows: ReviewedCandidate[]) => {
  const state = createVisionReviewPoolState();
  for (const r of rows) noteVisionReviewed(state, 0, 0, r);
  return state;
};

/* ═══════════ 1. an unusable candidate is not a candidate ═══════════ */

describe("R204 §1 — the best available, not the best answered", () => {
  it("A FIT WHOSE FILE WILL NOT OPEN IS NOT THE BEAT'S BEST", () => {
    const best = bestByVisionEvidence([
      reviewed("archive:broken", 0, "FIT", "invalid_file"),
      reviewed("pexels:ok", 3, "UNCLEAR"),
    ]);
    expect(best?.contentKey, "an unopenable file was named as the beat's choice").toBe("pexels:ok");
  });

  it("a usable FIT still wins, and rank still orders within the tier", () => {
    const best = bestByVisionEvidence([
      reviewed("a:1", 5, "FIT"),
      reviewed("a:2", 2, "FIT"),
      reviewed("a:3", 0, "UNREVIEWED"),
    ]);
    expect(best?.contentKey).toBe("a:2");
  });

  it("every candidate unusable is the same answer as every candidate refused: none", () => {
    expect(
      bestByVisionEvidence([
        reviewed("a:1", 0, "FIT", "transform_failed"),
        reviewed("a:2", 1, "UNCLEAR", "invalid_file"),
      ])
    ).toBeNull();
  });

  it("THE ORDERING ITSELF IS UNTOUCHED — only the filter changed", () => {
    /**
     * `visionAwareFinalShortlist` keeps every reviewed candidate, unusable ones included, because
     * it is the ledger of what happened and not the list of what may be chosen. A round that
     * quietly dropped rows here would take the evidence away from the reader as well.
     */
    const order = visionAwareFinalShortlist([
      reviewed("a:3", 0, "MISMATCH"),
      reviewed("a:1", 9, "FIT", "invalid_file"),
      reviewed("a:2", 4, "UNCLEAR"),
    ]).map((c) => c.contentKey);
    expect(order).toEqual(["a:1", "a:2", "a:3"]);
  });

  it("a MISMATCH is unavailable on its verdict alone — no mark needed, none written", () => {
    expect(isAvailableCandidate(reviewed("a:1", 0, "MISMATCH"))).toBe(false);
    expect(isAvailableCandidate(reviewed("a:2", 0, "FIT"))).toBe(true);
    expect(isAvailableCandidate(reviewed("a:3", 0, "UNREVIEWED"))).toBe(true);
  });
});

/* ═══════════ 2. the violation says what really happened ═══════════ */

describe("R204 §2 — FIT_NOT_PREFERRED only when a fit was there to prefer", () => {
  it("THE FALSE ACCUSATION IS GONE: a broken FIT does not make the runner-up a violation", () => {
    const state = poolOf(
      reviewed("archive:broken", 0, "FIT"),
      reviewed("pexels:ok", 1, "UNREVIEWED")
    );
    noteVisionUnusable(state, 0, 0, "archive:broken", "invalid_file");
    noteVisionAdopted(state, 0, 0, "pexels:ok");
    expect(
      visionSelectionViolations(state),
      "the render is still accused of ignoring its own picture editor"
    ).toEqual([]);
  });

  it("AND THE REAL ONE SURVIVES: a usable FIT passed over is still reported", () => {
    const state = poolOf(
      reviewed("archive:good", 0, "FIT"),
      reviewed("pexels:meh", 1, "UNCLEAR")
    );
    noteVisionAdopted(state, 0, 0, "pexels:meh");
    const out = visionSelectionViolations(state);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("FIT_NOT_PREFERRED");
    expect(out[0]).toContain("adopted=UNCLEAR");
  });

  it("one broken FIT does not excuse passing over a second, working one", () => {
    const state = poolOf(
      reviewed("a:broken", 0, "FIT"),
      reviewed("a:good", 1, "FIT"),
      reviewed("a:weak", 2, "UNREVIEWED")
    );
    noteVisionUnusable(state, 0, 0, "a:broken", "transform_failed");
    noteVisionAdopted(state, 0, 0, "a:weak");
    expect(visionSelectionViolations(state).join("|")).toContain("FIT_NOT_PREFERRED");
  });

  it("a beat that adopted the FIT reports nothing, marked pool or not", () => {
    const state = poolOf(
      reviewed("a:good", 1, "FIT"),
      reviewed("a:broken", 0, "FIT")
    );
    noteVisionUnusable(state, 0, 0, "a:broken", "invalid_file");
    noteVisionAdopted(state, 0, 0, "a:good");
    expect(visionSelectionViolations(state)).toEqual([]);
  });

  it("MISMATCH_ADOPTED_OVER_AVAILABLE is not raised against an unusable alternative", () => {
    /**
     * The reprieve exists for "every alternative failed too". A FIT that will not decode IS an
     * alternative that failed, so a beat left with the refused picture did not overrule anything.
     */
    const state = poolOf(
      reviewed("a:refused", 1, "MISMATCH"),
      reviewed("a:broken", 0, "FIT")
    );
    noteVisionUnusable(state, 0, 0, "a:broken", "invalid_file");
    noteVisionAdopted(state, 0, 0, "a:refused");
    expect(visionSelectionViolations(state).join("|")).not.toContain(
      "MISMATCH_ADOPTED_OVER_AVAILABLE"
    );
  });

  it("but a refused picture used while a working one waited is still a violation", () => {
    const state = poolOf(
      reviewed("a:refused", 1, "MISMATCH"),
      reviewed("a:good", 0, "FIT")
    );
    noteVisionAdopted(state, 0, 0, "a:refused");
    expect(visionSelectionViolations(state).join("|")).toContain(
      "MISMATCH_ADOPTED_OVER_AVAILABLE"
    );
  });
});

/* ═══════════ 3. the writer ═══════════ */

describe("R204 §3 — what the mark may and may not do", () => {
  it("marks the row that was reviewed, and invents no row for one that was not", () => {
    const state = poolOf(reviewed("a:1", 0, "FIT"));
    noteVisionUnusable(state, 0, 0, "a:never_reviewed", "invalid_file");
    const pool = state.beats.get("0:0")!;
    expect(pool.reviewed).toHaveLength(1);
    expect(pool.reviewed[0]!.contentKey).toBe("a:1");
  });

  it("THE VERDICT IS NEVER OVERWRITTEN — the editor's answer survives the file's failure", () => {
    const state = poolOf(reviewed("a:1", 0, "FIT"));
    noteVisionUnusable(state, 0, 0, "a:1", "invalid_file");
    expect(state.beats.get("0:0")!.reviewed[0]!.evidence).toBe("FIT");
  });

  it("the first reason wins — the failure that stopped it is the one that explains it", () => {
    const state = poolOf(reviewed("a:1", 0, "FIT"));
    noteVisionUnusable(state, 0, 0, "a:1", "invalid_file");
    noteVisionUnusable(state, 0, 0, "a:1", "transform_failed");
    expect(state.beats.get("0:0")!.reviewed[0]!.unusable).toBe("invalid_file");
  });

  it("only this beat's row is touched", () => {
    const state = createVisionReviewPoolState();
    noteVisionReviewed(state, 0, 0, reviewed("a:1", 0, "FIT"));
    noteVisionReviewed(state, 1, 0, reviewed("a:1", 0, "FIT"));
    noteVisionUnusable(state, 0, 0, "a:1", "invalid_file");
    expect(state.beats.get("1:0")!.reviewed[0]!.unusable).toBeUndefined();
  });

  it("a render with no pool at all is not an error", () => {
    expect(() => noteVisionUnusable(undefined, 0, 0, "a:1", "invalid_file")).not.toThrow();
  });
});

/* ═══════════ 4. the render says what it lost ═══════════ */

describe("R204 §4 — the cost is printed, not swallowed", () => {
  it("the per-beat line counts the unusable ones and drops them from the shortlist", () => {
    const state = poolOf(
      reviewed("a:broken", 0, "FIT"),
      reviewed("a:ok", 1, "UNREVIEWED")
    );
    noteVisionUnusable(state, 0, 0, "a:broken", "invalid_file");
    const lines = formatVisionSelection(state);
    const head = lines[0]!;
    expect(head).toContain("reviewed=2");
    expect(head, "the editor's answer was rewritten instead of kept").toContain("FIT=1");
    expect(head).toContain("unusable=1");
    expect(head).toContain("finalShortlisted=1");
    expect(head).toContain("best=UNREVIEWED@rank1");
  });

  it("EVERY UNUSABLE CANDIDATE IS NAMED WITH ITS REASON", () => {
    const state = poolOf(reviewed("archive:9182", 0, "FIT"));
    noteVisionUnusable(state, 0, 0, "archive:9182", "transform_failed");
    const named = formatVisionSelection(state).find(
      (l) => l.includes(" unusable ") && l.includes("archive:9182")
    );
    expect(named, "a candidate was dropped from the selection in silence").toBeTruthy();
    expect(named).toContain("FIT@rank0");
    expect(named).toContain("transform_failed");
  });

  it("the total carries it too", () => {
    const state = poolOf(reviewed("a:1", 0, "FIT"), reviewed("a:2", 1, "FIT"));
    noteVisionUnusable(state, 0, 0, "a:1", "invalid_file");
    noteVisionUnusable(state, 0, 0, "a:2", "transform_failed");
    expect(formatVisionSelection(state).at(-1)!).toContain("unusable=2");
  });

  it("a healthy beat prints unusable=0 rather than nothing", () => {
    const state = poolOf(reviewed("a:1", 0, "FIT"));
    expect(formatVisionSelection(state)[0]!).toContain("unusable=0");
    expect(formatVisionSelection(state).filter((l) => l.includes(" unusable "))).toEqual([]);
  });
});

/* ═══════════ 5. the three exits that made this necessary ═══════════ */

describe("R204 §5 — every exit that reviews and then discards says so", () => {
  it("each recordAssetOutcome for a broken file is followed by the pool mark", () => {
    /**
     * Anchored on `recordAssetOutcome`, which is the existing statement of the same fact on the
     * lineage ledger. The two are written together on purpose: one fact, filed for the two readers
     * that need it, rather than a second fact that could drift from the first.
     */
    for (const reason of ["invalid_file", "transform_failed"]) {
      for (const m of PIPE.matchAll(new RegExp(`recordAssetOutcome\\([^)]*"${reason}"[^)]*\\);`, "g"))) {
        const after = PIPE.slice(m.index! + m[0].length, m.index! + m[0].length + 300);
        expect(
          after,
          `a ${reason} exit still leaves the review pool believing the candidate was available`
        ).toContain("noteVisionUnusable(");
      }
    }
  });

  it("the mark is written where the verdict was written — on the render's own pool", () => {
    for (const m of PIPE.matchAll(/noteVisionUnusable\(/g)) {
      const line = PIPE.slice(m.index!, PIPE.indexOf("\n", m.index!));
      expect(line).toContain("dedup.visionReviewPool");
    }
  });

  it("A REFUSAL IS NOT MARKED UNUSABLE — that fact already lives in the verdict", () => {
    expect(PIPE).not.toContain('noteVisionUnusable(dedup.visionReviewPool, sceneIndex, beatIndex, contentKey, "hard_mismatch")');
    for (const m of PIPE.matchAll(/noteVisionUnusable\([^)]*\)/g)) {
      expect(m[0]).toMatch(/"(invalid_file|transform_failed)"/);
    }
  });
});
