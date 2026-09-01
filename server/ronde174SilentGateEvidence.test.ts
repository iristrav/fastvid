/**
 * RONDE 174 — two silent gates, and no way to tell which kind of silent.
 *
 * ── What the render reported ─────────────────────────────────────────────────────────────────
 *
 *     silent gate(s): modern_mismatch (74×), documentary_beat_gate (20×)
 *                     — asked repeatedly, rejected nothing; verify the check can still fire
 *
 * Ninety-four questions, no answers, and an instruction to go and read code. The instruction has
 * been issued before and acted on before:
 *
 *   RONDE 26  modern_mismatch could not fire at all — it needed two frames to agree and the live
 *             path supplied one. 152 evaluations, zero rejections, and a WWII documentary shipped
 *             modern office footage.
 *   RONDE 29  built these counters so a veto that cannot fire can no longer hide behind a healthy
 *             log.
 *   RONDE 51  read `modern_mismatch=0/54` off render 530, collected ten similarity numbers BY HAND
 *             out of the log, and retuned the floor from 0.26 to 0.235. Its own comment: "the
 *             per-candidate log line makes the next render measure it."
 *
 * It did not. That log line prints only when the gate fires or would have fired under the old
 * rule, so a gate that comes nowhere near stays completely dark — and the next render read 0/74
 * with nothing whatsoever to compare against 0/54.
 *
 * ── The two silences are not the same thing ──────────────────────────────────────────────────
 *
 * `modern_mismatch` is a threshold gate. Silence means either the threshold is a hair too high or
 * the material genuinely is not modern, and `asked`/`fired` cannot distinguish them.
 *
 * `documentary_beat_gate` is a set of blocklists about pharmacies, retail, Columbus Ohio and a
 * Dutch/US region lock. On a WWII documentary not one of them can match. Its silence is the gate
 * being OUT OF SCOPE — reported as a suspected defect every render, forever, which is precisely
 * how a real alarm gets trained away.
 *
 * ── What this round changes, and what it does not ────────────────────────────────────────────
 *
 * Measurement only. No threshold moved, no gate weakened, no verdict altered anywhere. A gate can
 * now say how far short it came, and whether it had a rule to apply at all.
 */
import { describe, expect, it } from "vitest";

import {
  createGateFiringStats,
  describeSilentGate,
  findOutOfScopeGates,
  findSilentGates,
  recordGateVerdict,
  runWithGateFiringStats,
  summarizeGateFiring,
  SILENT_GATE_MIN_ASKED,
} from "./gateFiringStats";
import { decideModernContentMismatch, type ModernMismatchFrameEvidence } from "./localClipVision";
import { judgeDocumentaryBeatGate, clipPassesDocumentaryBeatGate } from "./vidrushQuality";

/* ═══════════════════════ the counter learns to say how close ═══════════════════════ */

describe("RONDE 174 — a silent gate can say how silent", () => {
  const askMany = (gate: string, n: number, shortfall: number) => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      for (let i = 0; i < n; i++) recordGateVerdict(gate, false, { shortfall });
    });
    return stats;
  };

  it("THE GAP: asked and fired alone cannot tell 0.002 short from 0.08 short", () => {
    // Both are "0/74". Only the shortfall separates "raise the threshold" from "leave it alone".
    const near = summarizeGateFiring(askMany("modern_mismatch", 74, 0.002))[0]!;
    const far = summarizeGateFiring(askMany("modern_mismatch", 74, 0.08))[0]!;
    expect(near.asked).toBe(far.asked);
    expect(near.fired).toBe(far.fired);
    expect(near.closestShortfall).toBe(0.002);
    expect(far.closestShortfall).toBe(0.08);
  });

  it("keeps the CLOSEST candidate, not the last or the average", () => {
    /**
     * The question is "did anything come near", so one near miss among seventy is the answer —
     * an average would bury it under the seventy that came nowhere.
     */
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      for (const s of [0.09, 0.11, 0.004, 0.2, 0.07]) {
        recordGateVerdict("modern_mismatch", false, { shortfall: s });
      }
    });
    expect(summarizeGateFiring(stats)[0]!.closestShortfall).toBe(0.004);
  });

  it("a gate with no numeric threshold reports no shortfall rather than a fake zero", () => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      recordGateVerdict("baked_text", false);
      recordGateVerdict("baked_text", true);
    });
    const row = summarizeGateFiring(stats)[0]!;
    expect(row.closestShortfall).toBeNull();
    expect(row.fired).toBe(1);
  });

  it("infinity never becomes the 'closest' figure", () => {
    // A candidate the gate had no evidence for at all is not a near miss.
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      recordGateVerdict("modern_mismatch", false, { shortfall: Number.POSITIVE_INFINITY });
    });
    expect(summarizeGateFiring(stats)[0]!.closestShortfall).toBeNull();
  });

  it("counting is unchanged for every caller that passes no evidence", () => {
    // RONDE 29's two-argument form still behaves exactly as it did.
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      recordGateVerdict("vision_gate", false);
      recordGateVerdict("vision_gate", true);
      recordGateVerdict("vision_gate", true);
    });
    const row = summarizeGateFiring(stats)[0]!;
    expect(row).toMatchObject({ gate: "vision_gate", asked: 3, fired: 2, notArmed: 0 });
  });

  it("outside a render it is still a no-op", () => {
    expect(() => recordGateVerdict("modern_mismatch", false, { shortfall: 0.01 })).not.toThrow();
  });
});

/* ═══════════════════════ out of scope is not broken ═══════════════════════ */

describe("RONDE 174 — a gate with no applicable rule is not a defect", () => {
  const outOfScope = (n: number) => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      for (let i = 0; i < n; i++) {
        recordGateVerdict("documentary_beat_gate", false, { armed: false });
      }
    });
    return stats;
  };

  it("THE FALSE ALARM: 20 asks with no rule to apply no longer reads as silent", () => {
    const stats = outOfScope(20);
    expect(findSilentGates(stats)).toEqual([]);
    // ...but it is not hidden either. It is reported as what it is.
    const scope = findOutOfScopeGates(stats);
    expect(scope).toHaveLength(1);
    expect(scope[0]).toMatchObject({ gate: "documentary_beat_gate", asked: 20, notArmed: 20 });
  });

  it("a gate that WAS armed and still never fired is still a finding", () => {
    /**
     * The protection this round must not remove. RONDE 26's bug looked exactly like this: armed
     * every time, asked constantly, incapable of saying no.
     */
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      for (let i = 0; i < SILENT_GATE_MIN_ASKED; i++) {
        recordGateVerdict("documentary_beat_gate", false, { armed: true });
      }
    });
    expect(findSilentGates(stats).map((r) => r.gate)).toEqual(["documentary_beat_gate"]);
    expect(findOutOfScopeGates(stats)).toEqual([]);
  });

  it("a mix still counts only the armed asks toward the threshold", () => {
    // 19 armed asks is below the minimum, whatever the unarmed ones bring the total to.
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      for (let i = 0; i < 19; i++) recordGateVerdict("documentary_beat_gate", false, { armed: true });
      for (let i = 0; i < 50; i++) recordGateVerdict("documentary_beat_gate", false, { armed: false });
    });
    expect(findSilentGates(stats)).toEqual([]);
    const stats2 = createGateFiringStats();
    runWithGateFiringStats(stats2, () => {
      for (let i = 0; i < 20; i++) recordGateVerdict("documentary_beat_gate", false, { armed: true });
      for (let i = 0; i < 50; i++) recordGateVerdict("documentary_beat_gate", false, { armed: false });
    });
    expect(findSilentGates(stats2).map((r) => r.gate)).toEqual(["documentary_beat_gate"]);
  });

  it("a gate that fires is never reported by either detector", () => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      for (let i = 0; i < 40; i++) recordGateVerdict("documentary_beat_gate", false, { armed: false });
      recordGateVerdict("documentary_beat_gate", true, { armed: true });
    });
    expect(findSilentGates(stats)).toEqual([]);
    expect(findOutOfScopeGates(stats)).toEqual([]);
  });

  it("the demoted gates are still excluded from both", () => {
    // RONDE 105: vision_gate and friends are silent by design; alarming on them trains the alarm
    // away just as surely as an out-of-scope false positive does.
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      for (let i = 0; i < 40; i++) recordGateVerdict("vision_gate", false, { armed: false });
    });
    expect(findSilentGates(stats)).toEqual([]);
    expect(findOutOfScopeGates(stats)).toEqual([]);
  });
});

/* ═══════════════════════ the line an operator actually reads ═══════════════════════ */

describe("RONDE 174 — the warning carries a measurement, not an instruction", () => {
  it("names the distance in the same unit the threshold is written in", () => {
    expect(
      describeSilentGate({
        gate: "modern_mismatch", asked: 74, fired: 0, closestShortfall: 0.0212, notArmed: 0,
      })
    ).toBe("modern_mismatch (74×, closest 0.021 short of firing)");
  });

  it("says so when a candidate cleared the threshold and the veto still did not fire", () => {
    /**
     * A real and different diagnosis: the probe qualified but the frame/probe quorum refused. That
     * is RONDE 26's exact bug shape, and it must not read the same as "nothing came close".
     */
    expect(
      describeSilentGate({
        gate: "modern_mismatch", asked: 74, fired: 0, closestShortfall: -0.01, notArmed: 0,
      })
    ).toContain("cleared its threshold but did not fire");
  });

  it("a gate with no threshold says only how often it was asked", () => {
    expect(
      describeSilentGate({ gate: "baked_text", asked: 31, fired: 0, closestShortfall: null, notArmed: 0 })
    ).toBe("baked_text (31×)");
  });

  it("out-of-scope asks are named in the line too", () => {
    expect(
      describeSilentGate({
        gate: "documentary_beat_gate", asked: 20, fired: 0, closestShortfall: null, notArmed: 12,
      })
    ).toBe("documentary_beat_gate (20×, 12× no applicable rule)");
  });
});

/* ═══════════════════════ the real gates, driven ═══════════════════════ */

describe("RONDE 174 — modern_mismatch measures its own distance", () => {
  const frame = (beatSim: number, negSims: number[]): ModernMismatchFrameEvidence => ({
    beatSim,
    negSims,
  });

  it("render 530's genuine archive material was far from firing", () => {
    /**
     * The numbers RONDE 51 read by hand, now produced by the gate itself. Bundesarchiv material:
     * the probe scores at or below the beat's own query, so it misses the margin by a clear
     * amount — evidence that the gate is right to stay quiet, not evidence that it is broken.
     */
    const v = decideModernContentMismatch([frame(0.2145, [0.2103])]);
    expect(v.mismatch).toBe(false);
    expect(v.shortfallToFire).toBeGreaterThan(0);
    expect(v.shortfallToFire).toBeCloseTo(0.0247, 3); // 0.235 floor − 0.2103
  });

  it("render 530's modern stock came much closer, which is the separation the gate lives on", () => {
    // pexels 0.2432 / 0.2129 — clears the 0.235 floor and beats the beat query by 0.03.
    // Three probes, because a single frame needs three to agree (see the quorum test below).
    const v = decideModernContentMismatch([frame(0.2129, [0.2432, 0.2401, 0.2390])]);
    expect(v.shortfallToFire).toBeLessThanOrEqual(0);
    expect(v.mismatch).toBe(true);
  });

  it("a shortfall of zero does NOT mean the gate fired — the quorum is a separate hurdle", () => {
    /**
     * Why `describeSilentGate` has a "cleared its threshold but did not fire" case, and why the
     * shortfall is a diagnosis rather than a verdict.
     *
     * The live path samples one frame, and on one frame THREE independent probes must each clear
     * both thresholds (MODERN_EVIDENCE_SINGLE_FRAME_MIN_PROBES). So a candidate can have a probe
     * comfortably over the line — shortfall ≤ 0 — and still be allowed, because only two agreed.
     * That is RONDE 26's exact bug shape (a quorum the live path cannot reach), which is why the
     * report must be able to say it out loud rather than showing a reassuring 0.000.
     */
    const twoAgree = decideModernContentMismatch([frame(0.2129, [0.2432, 0.2401, 0.10])]);
    expect(twoAgree.shortfallToFire).toBeLessThanOrEqual(0);
    expect(twoAgree.mismatch).toBe(false);

    const threeAgree = decideModernContentMismatch([frame(0.2129, [0.2432, 0.2401, 0.2390])]);
    expect(threeAgree.mismatch).toBe(true);
  });

  it("the shortfall is the constraint the probe missed by MORE", () => {
    /**
     * Both must be cleared, so the binding one is the larger deficit. A shortfall taken from the
     * floor alone would read 0 for a probe that clears the floor and loses to the beat query.
     */
    // Clears the floor (0.24 ≥ 0.235) but loses the margin: needs 0.30 + 0.015.
    const v = decideModernContentMismatch([frame(0.30, [0.24])]);
    expect(v.shortfallToFire).toBeCloseTo(0.075, 5);
    expect(v.mismatch).toBe(false);
  });

  it("no frames and no probes report infinity, never a misleading zero", () => {
    expect(decideModernContentMismatch([]).shortfallToFire).toBe(Number.POSITIVE_INFINITY);
    expect(decideModernContentMismatch([frame(0.2, [])]).shortfallToFire).toBe(
      Number.POSITIVE_INFINITY
    );
  });

  it("no threshold moved — the verdicts are exactly what they were", () => {
    /**
     * The whole risk of a measurement round is that it quietly becomes a tuning round. These are
     * the RONDE 51 calibration points, asserted as verdicts rather than as numbers.
     */
    // Genuine archive, all three from render 530: allowed.
    for (const [beat, neg] of [[0.2145, 0.2103], [0.1974, 0.2077], [0.1974, 0.1890]] as const) {
      expect(decideModernContentMismatch([frame(beat, [neg, neg, neg])]).mismatch, `${beat}/${neg}`)
        .toBe(false);
    }
    // Modern stock. Two of the three are rejected; the third is not, and that is the point below.
    for (const [beat, neg] of [[0.2129, 0.2432], [0.2230, 0.2389]] as const) {
      expect(decideModernContentMismatch([frame(beat, [neg, neg, neg])]).mismatch, `${beat}/${neg}`)
        .toBe(true);
    }
  });

  it("FINDING: one of RONDE 51's own modern-stock samples still slips through", () => {
    /**
     * Render 530's pexels candidate at 0.2284 / 0.2260. Of the three modern-stock samples the
     * recalibration was fitted to, the retuned gate catches two and allows this one.
     *
     * That was invisible from anywhere: the per-candidate line does not print for an allowed
     * candidate, and the counter only ever said 0/74. The new shortfall is what makes it readable
     * — and it also says WHICH threshold is doing the work, which turns out not to be the one the
     * recalibration moved:
     *
     *     floor   0.2350 − 0.2284 = 0.0066 short
     *     margin  0.2260 + 0.0150 − 0.2284 = 0.0126 short   ← binding
     *
     * So this candidate is held out by MODERN_EVIDENCE_MARGIN, not by MODERN_EVIDENCE_MIN_SIM.
     * RONDE 51 lowered the floor to 0.235 and left the margin at 0.015; on this sample the floor
     * was never the constraint.
     *
     * Deliberately NOT acted on. n = one sample from one render is exactly the evidence base that
     * produced this situation, and both thresholds sit close to the genuine-archive band the gate
     * must never touch. The point of this round is that the next render answers it with data.
     */
    const v = decideModernContentMismatch([frame(0.2260, [0.2284, 0.2284, 0.2284])]);
    expect(v.mismatch).toBe(false);
    // The binding constraint is the margin, at 0.0126 — larger than the 0.0066 floor deficit.
    expect(v.shortfallToFire).toBeCloseTo(0.0126, 4);
    expect(v.shortfallToFire).toBeGreaterThan(0.235 - 0.2284);
  });
});

describe("RONDE 174 — documentary_beat_gate says when it has nothing to say", () => {
  it("a WWII beat arms none of its rules", () => {
    /**
     * The render that prompted this round: "Hitler's fixation on massive super-weapons". No
     * pharmacy, no Columbus Ohio, no Dutch or US region lock — so the gate passes the candidate
     * because it has no rule, not because it judged one.
     */
    const verdict = judgeDocumentaryBeatGate(
      "/w/scene_0_b0_bundesarchiv.mp4",
      "Hitler 1943 archival footage",
      "Hitler's fixation on massive super-weapons halted Germany's military innovation.",
      "WWII blunders that changed history"
    );
    expect(verdict.passes).toBe(true);
    expect(verdict.armed).toBe(false);
  });

  it("the boolean verdict is byte-for-byte what it always was", () => {
    /**
     * `clipPassesDocumentaryBeatGate` now delegates. Every caller must see the same answer, so
     * this checks the two functions agree across a spread of inputs rather than trusting the
     * refactor.
     */
    const cases: Array<[string, string, string, string | undefined]> = [
      ["/w/a.mp4", "Hitler 1943", "Hitler in Berlin", "WWII"],
      ["/w/b.mp4", "pharmacy shelves", "A pharmacy in Ohio", "Dutch healthcare"],
      ["/w/c.mp4", "", "", undefined],
      ["/w/d.mp4", "columbus ohio street", "The war in Europe", "WWII"],
      ["/w/e.mp4", "amsterdam canal", "Dutch pharmacies today", "Nederlandse apotheken"],
    ];
    for (const [clip, query, beat, title] of cases) {
      expect(clipPassesDocumentaryBeatGate(clip, query, beat, title), clip).toBe(
        judgeDocumentaryBeatGate(clip, query, beat, title).passes
      );
    }
  });

  it("a rejection is always armed — the gate cannot refuse on a rule it does not have", () => {
    // The invariant that keeps `armed` honest: no rule, no rejection.
    const cases: Array<[string, string, string, string | undefined]> = [
      ["/w/a.mp4", "pharmacy drugstore shelves", "A pharmacy in Ohio", "Dutch healthcare"],
      ["/w/b.mp4", "columbus ohio downtown", "The war in Europe", "WWII"],
      ["/w/c.mp4", "Hitler 1943", "Hitler in Berlin", "WWII"],
    ];
    for (const [clip, query, beat, title] of cases) {
      const v = judgeDocumentaryBeatGate(clip, query, beat, title);
      if (!v.passes) expect(v.armed, clip).toBe(true);
    }
  });
});
