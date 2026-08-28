/**
 * RONDE 143 — auditing RONDE 142's two fixes against the real production path.
 *
 * RONDE 142 was written from video 548's log and is correct about what it touches. Reading it
 * back against `videoPipeline.ts` rather than against its own tests turned up three places where
 * the fix stops short of the rule it states. None of them is a new feature; each is the RONDE 142
 * rule applied where RONDE 142 did not reach.
 *
 * ── GAP 1: the second route into extendLastClip ──────────────────────────────────────────────
 *
 * `extendLastClip` has TWO callers, not one:
 *
 *     per-beat rescue ladder                    guarded by RONDE 142
 *     ensureArchiveMontageVoiceCoverage round B  not guarded at all
 *
 * The second builds on the same `dedup.lastRealClip`, nothing in its loop changes that source,
 * and it runs up to three attempts of up to 6s each — ~18s of one picture, against a 5.00s limit.
 * Video 548 did not reach it (all 13 of its extends are `extend_sXbY` with real beat indices, no
 * `b900`+), which is why the log did not expose it; it is nonetheless the same defect, reachable
 * from three call sites in production.
 *
 * It also has to CHARGE the budget rather than only read it. A guard reading a total that nobody
 * writes to is not a budget: whatever this loop puts on screen is screen time the per-beat ladder
 * would otherwise be free to extend on top of afterwards.
 *
 * ── GAP 2: the funnel's registration was not deduped ─────────────────────────────────────────
 *
 * RONDE 142 keyed `beatClipPassesVisionGate`'s `recordMismatch` on (content, beat) so a candidate
 * seen by two layers counts once — and left the funnel's own registration un-keyed. The two can
 * see the same file for the same beat (a Wikimedia clip the funnel refused, returning through the
 * Wikimedia rescue); the second look reads `checkBeatRelevance`'s cached verdict, so it is still a
 * refusal, and it was counted twice. That inflates precisely the two numbers RONDE 142 exists to
 * make trustworthy: the refusal total and the per-provider accept rate.
 *
 * ── GAP 3: the research signal was gated on the count ────────────────────────────────────────
 *
 * `lastMismatchByBeat.set` sat inside the dedupe's `true` branch, tying "what did the gate say
 * about this beat" to "was this the first time we counted it". A clip already counted for a beat
 * still tells the research pass what is wrong with that beat. Suppressing the signal because the
 * COUNT was a duplicate reintroduces, in miniature, the exact failure RONDE 142 set out to end.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  createExtendHoldState,
  mayExtendAgain,
  recordExtension,
} from "./extendHoldBudget";
import { stillImageMaxSec } from "./stillImagePolicy";
import { createMismatchTally, recordMismatch } from "./visualMismatchFeedback";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** The coverage-backfill loop — round B of ensureArchiveMontageVoiceCoverage. */
const backfillLoop = (): string => {
  const idx = PIPE.indexOf("for (let attempt = 0; attempt < 3 && coverage < floor; attempt++)");
  expect(idx).toBeGreaterThan(-1);
  return PIPE.slice(idx, idx + 2600);
};

// ─── GAP 1 ───────────────────────────────────────────────────────────────────────────────────

describe("RONDE 143 GAP 1 — both routes into extendLastClip are budgeted", () => {
  it("A. the coverage backfill asks the budget before extending", () => {
    const block = backfillLoop();
    expect(block).toContain("mayExtendAgain({ state: dedup.extendHold, sourceClipPath: source, holdSec: need })");
    expect(block).toContain("if (!extendDecision.allowed)");
    // And it stops the whole run, not just this attempt: `need` does not shrink and the budget
    // does not grow, so attempt 2 and 3 would be refused identically.
    expect(block).toMatch(
      /console\.warn\(formatExtendRefusal\(scene\.index, 900 \+ attempt, extendDecision\)\);\s*\n\s*break;/
    );
  });

  it("B. the refusal comes BEFORE extendLastClip runs, not after", () => {
    const block = backfillLoop();
    const guard = block.indexOf("mayExtendAgain(");
    const call = block.indexOf("await extendLastClip(");
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(call);
  });

  it("C. the backfill CHARGES the budget, so the per-beat ladder cannot stack on top of it", () => {
    const block = backfillLoop();
    expect(block).toContain("recordExtension(dedup.extendHold, source, need);");
    // Charged at the adoption, which on this route is the push into `clips` — there is no
    // pushClip gate to pass first.
    const push = block.indexOf("clips.push(extended);");
    const charge = block.indexOf("recordExtension(");
    expect(push).toBeGreaterThan(-1);
    expect(charge).toBeGreaterThan(push);
  });

  it("D. behaviourally: three backfill attempts cannot lay ~18s of one picture", () => {
    const state = createExtendHoldState();
    const source = "/w/scene_1_b0_archive.mp4";
    let onScreen = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const need = 6;
      if (!mayExtendAgain({ state, sourceClipPath: source, holdSec: need }).allowed) break;
      recordExtension(state, source, need);
      onScreen += need;
    }
    // 6s already exceeds the 5s limit, so not even the first one runs — which is correct: this
    // route asks for a single hold longer than the whole allowance.
    expect(onScreen).toBe(0);
    expect(onScreen).toBeLessThanOrEqual(stillImageMaxSec() + 0.04);
  });

  it("E. a backfill that fits is still allowed — the budget refuses runs, not the route", () => {
    const state = createExtendHoldState();
    const source = "/w/scene_1_b0_archive.mp4";
    const first = mayExtendAgain({ state, sourceClipPath: source, holdSec: 2.5 });
    expect(first.allowed).toBe(true);
    recordExtension(state, source, 2.5);
    // A second short one still fits inside five seconds.
    expect(mayExtendAgain({ state, sourceClipPath: source, holdSec: 2.5 }).allowed).toBe(true);
    recordExtension(state, source, 2.5);
    // The third is the run this whole module exists to stop.
    expect(mayExtendAgain({ state, sourceClipPath: source, holdSec: 2.5 }).allowed).toBe(false);
  });

  it("F. the two routes share ONE budget — screen time from either counts against the other", () => {
    const state = createExtendHoldState();
    const source = "/w/scene_1_b0_archive.mp4";
    // The coverage backfill spends 4s of the allowance.
    expect(mayExtendAgain({ state, sourceClipPath: source, holdSec: 4 }).allowed).toBe(true);
    recordExtension(state, source, 4);
    // The per-beat ladder now finds only 1s left, not a fresh 5s.
    expect(mayExtendAgain({ state, sourceClipPath: source, holdSec: 3.5 }).allowed).toBe(false);
    expect(mayExtendAgain({ state, sourceClipPath: source, holdSec: 1 }).allowed).toBe(true);
  });

  it("G. every extendLastClip call site in the pipeline is behind the budget", () => {
    // Two call sites, and each one has a mayExtendAgain guard above it. If a third is ever added
    // this count changes and the test says so rather than letting it in unguarded.
    const calls = PIPE.match(/await extendLastClip\(/g) ?? [];
    expect(calls.length).toBe(2);
    const guards = PIPE.match(/mayExtendAgain\(/g) ?? [];
    expect(guards.length).toBe(2);
    const charges = PIPE.match(/recordExtension\(/g) ?? [];
    expect(charges.length).toBe(2);
  });
});

// ─── GAP 2 ───────────────────────────────────────────────────────────────────────────────────

describe("RONDE 143 GAP 2 — a refusal is counted once, whichever layer saw it", () => {
  it("H. the funnel registration carries the same (content, beat) key as the shared gate", () => {
    const idx = PIPE.indexOf("recordMismatch(dedup.mismatchTally, {\n              kind: mismatchKind,");
    expect(idx).toBeGreaterThan(-1);
    const block = PIPE.slice(idx, idx + 400);
    expect(block).toContain("dedupeKey: `${clipContentKey(winner.clipPath)}|s${scene.index}b${beat.index}`");
  });

  it("I. both registrations build the key the same way", () => {
    // The shared gate's key and the funnel's must agree, or deduping between them never fires.
    expect(PIPE).toContain("const refusalKey = `${clipContentKey(clipPath)}|s${scene.index}b${beat.index}`;");
    expect(PIPE).toContain("dedupeKey: `${clipContentKey(winner.clipPath)}|s${scene.index}b${beat.index}`");
  });

  it("J. behaviourally: the same clip refused twice for one beat counts once", () => {
    const tally = createMismatchTally();
    const key = "content-abc|s1b2";
    expect(recordMismatch(tally, { kind: "MODERN_FOOTAGE", source: "pexels", dedupeKey: key })).toBe(true);
    expect(recordMismatch(tally, { kind: "MODERN_FOOTAGE", source: "pexels", dedupeKey: key })).toBe(false);
    expect(tally.total).toBe(1);
    expect(tally.byKindAndSource.get("MODERN_FOOTAGE|pexels")).toBe(1);
  });

  it("K. the provider table cannot be inflated by a clip two layers both refused", () => {
    // This is the number video 548 got wrong in the other direction. A provider refused once must
    // read as one refusal however many layers looked at the same file.
    const tally = createMismatchTally();
    for (let i = 0; i < 4; i++) {
      recordMismatch(tally, { kind: "WRONG_PERIOD", source: "pexels", dedupeKey: "same|s0b0" });
    }
    expect(tally.byKindAndSource.get("WRONG_PERIOD|pexels")).toBe(1);
    // A different beat is a different refusal — the dedupe is per (content, beat), not per content.
    recordMismatch(tally, { kind: "WRONG_PERIOD", source: "pexels", dedupeKey: "same|s0b1" });
    expect(tally.byKindAndSource.get("WRONG_PERIOD|pexels")).toBe(2);
  });

  it("L. the reorder and lastMismatchKind stay unconditional — only counting is deduped", () => {
    // What the gate SAID is true however often it was asked; the funnel must go on acting on it.
    const idx = PIPE.indexOf("const mismatchKind = classifyMismatch(judgement);");
    expect(idx).toBeGreaterThan(-1);
    // Widened for the RONDE 143 comment inserted above the registration; the window still means
    // "inside the funnel's refusal branch" and every assertion below is unchanged.
    const block = PIPE.slice(idx, idx + 3600);
    expect(block).toContain("lastMismatchKind = mismatchKind;");
    expect(block).toContain("scored = reorderAfterMismatch(");
    // Neither is wrapped in a test of recordMismatch's return value.
    expect(block).not.toMatch(/if\s*\(\s*recordMismatch\(/);
  });
});

// ─── GAP 3 ───────────────────────────────────────────────────────────────────────────────────

describe("RONDE 143 GAP 3 — the research signal survives a duplicate count", () => {
  it("M. the shared gate records the beat's verdict outside the dedupe branch", () => {
    const idx = PIPE.indexOf("const refusalKey = `${clipContentKey(clipPath)}|s${scene.index}b${beat.index}`;");
    expect(idx).toBeGreaterThan(-1);
    const block = PIPE.slice(idx, idx + 1600);
    expect(block).toContain("dedup.lastMismatchByBeat.set(`s${scene.index}b${beat.index}`, kind);");
    // The registration is no longer the condition of an `if` — the set does not hang off it.
    expect(block).not.toMatch(/if\s*\(\s*\n?\s*recordMismatch\(dedup\.mismatchTally/);
  });

  it("N. the set comes after the count, and both run on every refusal", () => {
    const idx = PIPE.indexOf("const refusalKey = `${clipContentKey(clipPath)}|s${scene.index}b${beat.index}`;");
    const block = PIPE.slice(idx, idx + 1600);
    const count = block.indexOf("recordMismatch(dedup.mismatchTally");
    const set = block.indexOf("dedup.lastMismatchByBeat.set(");
    expect(count).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(count);
  });

  it("O. the research pass still reads it, and still runs without a winner", () => {
    // RONDE 142's two structural fixes, re-asserted here so a later edit to this area cannot
    // quietly undo them while these gaps are being closed.
    expect(PIPE).toContain("dedup.lastMismatchByBeat.get(researchKey)");
    expect(PIPE).toContain("const hasCandidateToJudge = winner !== null;");
    /**
     * NARROWED BY RONDE 153, deliberately.
     *
     * The condition carried a third clause, `!dedup.perf.fastStockMode`, which switched research
     * off entirely on the one-minute preset — in production, on the renders most likely to be
     * short of footage. Video 550 measured the cost: 8 search-preventable refusals, 11 minutes of
     * unused budget, and research attempts=0. The budget check inside decideResearch is the
     * better-informed gate and was being pre-empted by the cruder one.
     *
     * What this test exists for is unchanged and still asserted: the pass runs only when the beat
     * has NO winner, and only when a mismatch kind is known for it.
     */
    expect(PIPE).toContain("if (!winner && beatMismatchKind) {");
  });
});
