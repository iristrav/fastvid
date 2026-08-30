/**
 * RONDE 168 — video 555 put a NASA clip about equality under the Tehran Conference.
 *
 * ── What the render shipped ──────────────────────────────────────────────────────────────────
 *
 *     [BeatRelevance] s2b3 funnel:loc              does_not_fit
 *     [BeatRelevance] s2b3 funnel:internet_archive does_not_fit
 *     [RenderAsset]   provider=nasa scene=2 beat=3
 *                     file=..._nasa_Hidden_Figures_Way_NASA_s_Vision_of_Equality...
 *                     verdict=does_not_fit reprieved=false rendered=true
 *
 * `rendered=true` with `reprieved=false` on a refused clip. RONDE 167's new invariant caught it
 * independently — `[VisualFitAudit] INVARIANT_BROKEN beat=s2b3 severity=TOTALLY_UNRELATED is on
 * screen with no reprieve` — which is what turned a suspicion into a finding.
 *
 * ── Why RONDE 166's guard never fired ────────────────────────────────────────────────────────
 *
 * Not severity, and not the reprieve. Control flow.
 *
 * The funnel's judging loop is `for (look = 0; look < MAX_JUDGEMENTS_PER_BEAT && winner; look++)`.
 * Each pass judges the CURRENT winner and, on a refusal, picks the next-best. It `break`s the
 * moment one passes — so a winner produced by a break has been judged.
 *
 * When the CEILING ends the loop instead, the winner left in hand is whatever the last refusal
 * picked, and nothing has ever looked at it. It is not in `beatImageRejectedIds` either, because
 * it was never refused — so the reprieve check does not fire, no severity is consulted, and
 * `funnelClip = clipPath` hands it to the montage. The funnel is the one adopt route that does not
 * go through `pushClip`, so the compose barrier never sees it either.
 *
 * Two refusals bought an UNEXAMINED third candidate a free pass. The more of a beat's candidates
 * were refused, the likelier its picture was one nobody had judged — the exact inverse of the
 * intent stated in the comment four lines above the loop: "It runs on the candidate about to be
 * ADOPTED, not on all of them."
 *
 * It also explains the render's own numbers: `never_asked=38`, `unknown=57 clips`, and a quality
 * report that says in plain Dutch "die clips zijn ONGEZIEN aangenomen".
 *
 * ── The fix ──────────────────────────────────────────────────────────────────────────────────
 *
 * The look budget is spent on judging, not on shopping. With two looks a beat may try two
 * candidates properly; it may not try two and then take a third on trust. An unjudged winner is
 * put back, and the beat continues with what it actually knows — the candidates it DID judge,
 * under RONDE 166's severity rules.
 *
 * No gate call is added and no ceiling is raised. What changes is which candidate the beat ends on
 * when the ceiling binds: a judged one, or none.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { MAX_JUDGEMENTS_PER_BEAT } from "./beatImageRelevanceGate";
import { keepOnlyJudgedWinner, pickBestFunnelCandidate } from "./retrievalFunnel";
import {
  VisualSourceLedger,
  assertNoSelectedClipWithoutOutcome,
  recordAssetOutcome,
} from "./visualSourceLineage";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * The loop as videoPipeline runs it, reduced to the control flow under test.
 *
 * `verdicts` is what the gate would answer for each candidate in ranking order. The point of
 * modelling it rather than asserting on source text is that the bug IS the control flow: a test
 * that reads the file cannot tell whether the winner it ends on was judged.
 */
function runBeat(
  verdicts: Array<"fits" | "does_not_fit">,
  opts: { applyFix: boolean }
): { winner: number | null; judged: number[]; looks: number; putBackReason: string | null } {
  const scored = verdicts.map((_, i) => ({ id: `c${i}` }));
  const rejected = new Set<string>();
  const judged = new Set<string>();
  const pick = (): { id: string } | null =>
    scored.find((c) => !rejected.has(c.id)) ?? null;

  let winner = pick();
  let looks = 0;
  let putBackReason: string | null = null;
  for (let look = 0; look < MAX_JUDGEMENTS_PER_BEAT && winner; look++) {
    judged.add(winner.id);
    looks++;
    if (verdicts[scored.indexOf(winner)] !== "does_not_fit") break;
    rejected.add(winner.id);
    winner = pick();
  }
  if (opts.applyFix) {
    /**
     * The REAL rule, not a copy of it. An earlier draft of this test reimplemented the decision
     * here and two mutations to the production code sailed past it — a model of a rule cannot
     * test the rule. `keepOnlyJudgedWinner` is what the pipeline calls, so a mutation to it fails.
     */
    const wrapped = winner ? { candidate: { id: winner.id } } : null;
    const decision = keepOnlyJudgedWinner(
      wrapped,
      judged,
      scored.map((c) => ({ candidate: { id: c.id } })),
      rejected
    );
    winner = decision.winner ? scored.find((c) => c.id === decision.winner!.candidate.id) ?? null : null;
    if (decision.putBack) putBackReason = decision.reason;
  }
  const judgedIdx = [...judged].map((id) => scored.findIndex((c) => c.id === id));
  return {
    winner: winner ? scored.indexOf(winner) : null,
    judged: judgedIdx.sort((a, b) => a - b),
    looks,
    putBackReason,
  };
}

describe("RONDE 168 — the bug, reproduced as control flow", () => {
  it("the ceiling used to hand the beat a candidate nobody had judged", () => {
    /**
     * Render 555's s2b3: every candidate the loop could look at was refused, and the one after the
     * ceiling was adopted unseen.
     *
     * Built from MAX_JUDGEMENTS_PER_BEAT rather than from the literal 2 it was when this was
     * written. RONDE 175 raised the budget to 4; the bug being reproduced here is about the
     * candidate that sits just PAST the ceiling, whatever the ceiling happens to be.
     */
    const refusals = Array<"does_not_fit" | "fits">(MAX_JUDGEMENTS_PER_BEAT).fill("does_not_fit");
    const before = runBeat([...refusals, "fits"], { applyFix: false });
    expect(before.winner).toBe(MAX_JUDGEMENTS_PER_BEAT);
    expect(before.judged).toEqual(refusals.map((_, i) => i));
    expect(before.judged).not.toContain(before.winner);
  });

  it("and the more candidates were refused, the likelier that was", () => {
    // Every extra refusal moves the adopted candidate further past the last look.
    // Every count at or above the ceiling puts the adopted candidate past the last look.
    for (const n of [MAX_JUDGEMENTS_PER_BEAT, MAX_JUDGEMENTS_PER_BEAT + 1, MAX_JUDGEMENTS_PER_BEAT + 2]) {
      const verdicts = Array<"does_not_fit" | "fits">(n).fill("does_not_fit").concat("fits");
      const before = runBeat(verdicts, { applyFix: false });
      expect(before.winner, `${n} refusals`).toBe(MAX_JUDGEMENTS_PER_BEAT);
      expect(before.judged, `${n} refusals`).not.toContain(before.winner);
    }
  });
});

describe("RONDE 168 — after the fix, an adopted candidate has always been judged", () => {
  it("render 555's beat ends on a judged candidate, or on none", () => {
    const after = runBeat(["does_not_fit", "does_not_fit", "fits"], { applyFix: true });
    expect(after.winner).not.toBeNull();
    expect(after.judged).toContain(after.winner!);
  });

  it("the invariant holds for every shape of beat the funnel can produce", () => {
    /**
     * Exhaustive over up to four candidates and both verdicts. Whatever the loop ends on, the
     * beat must have looked at it — that is the whole rule, and it is cheaper to prove than to
     * argue about.
     */
    for (let n = 1; n <= 4; n++) {
      for (let mask = 0; mask < 1 << n; mask++) {
        const verdicts = Array.from({ length: n }, (_, i) =>
          mask & (1 << i) ? ("fits" as const) : ("does_not_fit" as const)
        );
        const after = runBeat(verdicts, { applyFix: true });
        if (after.winner !== null) {
          expect(after.judged, verdicts.join(",")).toContain(after.winner);
        }
      }
    }
  });

  it("a candidate that passes on the first look is still adopted immediately", () => {
    // The ordinary case must cost exactly one gate call, as it always did.
    const after = runBeat(["fits", "does_not_fit"], { applyFix: true });
    expect(after.winner).toBe(0);
    expect(after.looks).toBe(1);
  });

  it("RONDE 168's fix spends the budget differently, it does not spend more of it", () => {
    /**
     * SUPERSEDED IN ITS HEADLINE BY RONDE 175 — the budget DID later rise, for an unrelated reason
     * (the gate refused three quarters of what it saw and only ever saw two). What RONDE 168
     * claimed, and what still holds, is that ITS fix costs no extra looks: the loop never exceeds
     * whatever the ceiling is.
     */
    const long = Array<"does_not_fit" | "fits">(MAX_JUDGEMENTS_PER_BEAT + 2)
      .fill("does_not_fit")
      .concat("fits");
    for (const verdicts of [
      Array<"does_not_fit" | "fits">(MAX_JUDGEMENTS_PER_BEAT).fill("does_not_fit").concat("fits"),
      long,
    ]) {
      expect(runBeat(verdicts, { applyFix: true }).looks).toBeLessThanOrEqual(MAX_JUDGEMENTS_PER_BEAT);
    }
  });

  it("when everything judged was refused, the beat falls to the reprieve path", () => {
    /**
     * Not to a colour card. The candidates it looked at are still candidates, and RONDE 166's
     * severity rules decide whether one may be used — SOFT as a last resort, HARD never.
     */
    // Every candidate refused, sized to the ceiling so the loop genuinely exhausts it.
    const allRefused = Array<"does_not_fit" | "fits">(MAX_JUDGEMENTS_PER_BEAT + 1).fill("does_not_fit");
    const after = runBeat(allRefused, { applyFix: true });
    expect(after.winner).toBe(0);
    expect(after.judged).toContain(0);
  });

  it("the candidate that was put back is named never_judged by the rule itself", () => {
    // The reason lives with the decision, so a call site cannot file it under a different word.
    // The fit sits just past the ceiling, so the winner the loop leaves behind was never judged.
    const pastCeiling = Array<"does_not_fit" | "fits">(MAX_JUDGEMENTS_PER_BEAT)
      .fill("does_not_fit")
      .concat("fits");
    const after = runBeat(pastCeiling, { applyFix: true });
    expect(after.putBackReason).toBe("never_judged");
    // And a beat that ended on a judged candidate puts nothing back.
    expect(runBeat(["fits"], { applyFix: true }).putBackReason).toBeNull();
  });

  it("a beat with nothing to judge is unchanged", () => {
    expect(runBeat([], { applyFix: true })).toEqual({ winner: null, judged: [], looks: 0, putBackReason: null });
  });
});

describe("RONDE 168 — the unjudged candidate is accounted for, not just dropped", () => {
  it("never_judged is its own ending, distinct from not_chosen", () => {
    /**
     * "We looked and preferred another" and "we never looked" are opposite facts. Video 555
     * shipped a picture on the second while its audit read like the first.
     */
    const l = new VisualSourceLedger({ renderId: "r168" });
    const r = l.createLineage({ sceneIndex: 2, beatIndex: 3, localPath: "/w/nasa.mp4", provider: "nasa" });
    l.recordEvent(r.lineageId, "SELECTED", { status: "OK" });
    recordAssetOutcome(l, "/w/nasa.mp4", "never_judged", "s2b3");
    l.markFinalVideo([]);
    expect(l.allEvents().at(-1)?.reason).toBe("never_judged:s2b3");
    expect(assertNoSelectedClipWithoutOutcome(l).ok).toBe(true);
  });

  it("the pipeline hands the decision to the shared rule and acts on both halves", () => {
    /**
     * Kept as a source check on purpose and deliberately thin: the RULE is tested above by
     * calling it, and this only asserts the call site consumes both halves of its answer —
     * the winner it returns AND the candidate it put back. Dropping either was the original bug.
     */
    const idx = PIPE.indexOf("const judgedOnly = keepOnlyJudgedWinner(");
    expect(idx).toBeGreaterThan(0);
    const block = PIPE.slice(idx, idx + 1200);
    expect(block).toContain("if (judgedOnly.putBack)");
    expect(block).toContain("judgedOnly.reason");
    expect(block).toContain("recordAssetOutcome(");
    expect(block).toContain("winner = judgedOnly.winner;");
  });

  it("the loop records every candidate it looks at", () => {
    // An empty set would make the guard fire on every beat; a never-filled one, on none.
    const idx = PIPE.indexOf("const judgedCandidateIds = new Set<string>();");
    expect(idx).toBeGreaterThan(0);
    expect(PIPE).toContain("judgedCandidateIds.add(winner.candidate.id);");
  });
});

describe("RONDE 168 — nothing else moved", () => {
  it("pickBestFunnelCandidate still excludes refused candidates", () => {
    // The fix reads beatImageRejectedIds; it must keep meaning what RONDE 61 made it mean.
    const scored = [
      { candidate: { id: "a" }, clipPath: "/w/a.mp4", visionResult: { pass: true, worstScore10: 9 } },
      { candidate: { id: "b" }, clipPath: "/w/b.mp4", visionResult: { pass: true, worstScore10: 8 } },
    ] as never[];
    expect(pickBestFunnelCandidate(scored, new Set(), new Set(["a"]))?.candidate.id).toBe("b");
    expect(pickBestFunnelCandidate(scored, new Set(), new Set(["a", "b"]))).toBeNull();
  });

  it("RONDE 166's severity rules still decide the reprieve", () => {
    expect(PIPE).toContain("if (reprieveBeatClip(dedup.beatRelevance, gateReprieveWinner.clipPath");
  });

  it("RONDE 167's invariant and audits are untouched", () => {
    expect(PIPE).toContain("assertNoSelectedClipWithoutOutcome(ledger)");
    expect(PIPE).toContain("cache.lineage.setContentKeyResolver(clipContentKey);");
  });
});
