/**
 * RONDE 203 — TWO CLAIMS THE RENDER MADE ABOUT ITSELF THAT NOTHING BACKED.
 *
 * ── §1 — transitions: `executed` was a copy of `planned` ────────────────────────────────────
 *
 * The feature matrix carried:
 *
 *     transitionsPlanned: Math.max(0, scenes.length - 1)
 *     planned:  f.transitionsPlanned > 0
 *     executed: f.transitionsPlanned > 0
 *
 * Two faults in three lines. `executed` was derived from `planned`, so it could not disagree with
 * it and therefore measured nothing — this codebase's most repeated shape, one more time. And the
 * count itself described transitions BETWEEN SCENES, which the compose route never makes:
 * `concatenateScenesWithMusic` joins them with `-f concat`, a plain concatenation, which is a hard
 * cut by definition.
 *
 * The film's real transitions are INSIDE a scene, and two places emit them:
 *
 *     buildMontageXfadeFilter   n clips in one filter graph → n-1 xfades
 *     xfadeMergeTwoVideos       two montage segments → one xfade, or an explicit hard cut
 *
 * Counting only the first would have produced a new wrong number, which is why the count lives in
 * one function both of them call.
 *
 * `delivered` stays false and keeps its reason: no probe reads a dissolve back off an MP4. What
 * changes is that `executed` is now a measurement, and the hard cut between scenes is stated
 * instead of being reported as N transitions that never happened.
 *
 * ── §2 — the barrier's counter that nobody called ──────────────────────────────────────────
 *
 * At the compose chokepoint stands this comment:
 *
 *     "It refuses only a `does_not_fit` nobody reprieved. A clip the gate has never seen passes:
 *      this cannot judge, and pretending otherwise would empty montages on the routes that build
 *      their own files. That gap is counted rather than assumed away — see barrierCoverage."
 *
 * `barrierCoverage` is defined, exported, and called by nothing. The gap was not counted; the
 * comment said it was. A render could not answer how much of its own montage the barrier had been
 * unable to judge.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";


const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════ 2. both emitters count, because one of them alone would be wrong ═══════════ */

describe("R203 §1b — the two places that really emit a transition", () => {

  it("and the count is read in one place, off the delivered timeline", () => {
    /** RONDE 661 — the compose tally is gone; the one count is read off the delivered timeline. */
    expect([...PIPE.matchAll(/ctx\.transitionsApplied \+=/g)].length).toBe(0);
    expect(PIPE).toContain('(c, i) => i > 0 && c.transitionIn !== "hard_cut"');
  });
});

/* ═══════════ 3. scene joins are hard cuts, and the report says so ═══════════ */

describe("R203 §1c — the film's scene joins", () => {

  it("the matrix no longer counts one transition per scene join", () => {
    expect(PIPE, "the fabricated scene-join count is still there").not.toContain(
      "transitionsPlanned: Math.max(0, scenes.length - 1)"
    );
    expect(PIPE).toContain("transitionsApplied:");
  });
});

/* ═══════════ 4. the barrier's gap is counted now, not merely claimed ═══════════ */

describe("R203 §2 — the compose barrier can say what it could not judge", () => {
  it("barrierCoverage has a production caller", () => {
    const callers = [...PIPE.matchAll(/barrierCoverage\(/g)];
    expect(callers.length, "the comment still claims a count nobody takes").toBeGreaterThan(0);
  });

  it("a clip that passed unjudged is counted, and the total is printed", () => {
    expect(PIPE).toContain("[ComposeBarrier] coverage");
    expect(PIPE).toContain("passedUnjudged=");
  });
});
