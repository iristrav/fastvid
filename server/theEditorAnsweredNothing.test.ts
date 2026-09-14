/**
 * "THE EDITOR ANSWERED UNKNOWN" — THE EDITOR ANSWERED NOTHING.
 *
 * ── What render 581 printed, fifty times, about one beat ────────────────────────────────────
 *
 *     [BeatRelevance] s2b1: refusing to push scene_2_slot1_guaranteed.mp4 —
 *     backfill needs an approval; the editor answered unknown on s2b1
 *
 * ── What that render's own summary said the editor did ──────────────────────────────────────
 *
 *     beat image gate — attempts=194 answered=194 (fits=17 does_not_fit=177)
 *                       failed=0 never_asked=433
 *
 * 194 asked, 194 answered, zero failures. The picture editor does not hedge — it says fits or
 * does_not_fit. Every `unknown` in this system comes from one of three places and not one of them
 * is doubt: the gate is switched off, there is no narration to judge against, or the per-beat look
 * budget is spent. All three mean NOBODY LOOKED.
 *
 * ── Why the budget was spent, which is the part that actually broke ─────────────────────────
 *
 * The per-beat look budget was charged by subtracting a RENDER-WIDE counter across an await:
 *
 *     before = state.judgementAttempts        // one object for the whole render
 *     await judgeBeatImage(…)                 // other beats are judging concurrently
 *     judged = state.judgementAttempts - before
 *
 * Beats run under `pLimit(beatConcurrency)` over `Promise.all`, so every judgement any other beat
 * made during that await was billed to this one. The ceiling is 5. Render 581's s2b1 was charged
 * 22 while evaluating 2 clips; s0b4 was credited 5 looks on 2 offers, because its neighbours' spend
 * landed inside its window. Which beat starved depended on scheduling.
 *
 *     113 candidates offered across the render, 34 looked at, never_asked=433
 *     s1b2: offered=14 evaluated=1      s1b1: offered=13 evaluated=2
 *
 * These tests pin the three answers: a look costs what it cost, a refusal says whether anybody
 * looked, and the render can count the difference.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const RELEVANCE = readFileSync(join(__dirname, "beatVisualRelevance.ts"), "utf8");
const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * Comment lines dropped. The documentation above the fix QUOTES the broken arithmetic so a reader
 * can see what changed, and a scan that cannot tell code from prose fails on the explanation of
 * its own fix — which it did, on the first run of this file.
 */
const RELEVANCE_CODE = RELEVANCE.split("\n")
  .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
  .join("\n");

const spendBlock = () => {
  const at = RELEVANCE.indexOf("const lookedAtAModel =");
  expect(at, "the per-call spend calculation is gone").toBeGreaterThan(0);
  return RELEVANCE.slice(at, RELEVANCE.indexOf("params.onSpend?.(spent);", at));
};

/* ═════════════ 1. a beat is charged for its own look ═════════════ */

describe("1. the bill is for this look, not for every look taken while it ran", () => {
  /**
   * THE REGRESSION THAT MATTERS. A delta over a render-wide counter is wrong the moment two beats
   * run at once, and it cannot be made right by choosing a bigger ceiling.
   */
  it("no render-wide counter is read across the judgement await", () => {
    const block = spendBlock();
    expect(block).not.toContain("state.judgementAttempts");
    expect(block).not.toContain("state.judgementsFailed");
    expect(block).not.toContain("state.judgementsSkipped");
  });

  it("the snapshot that made the subtraction possible is gone", () => {
    // `before = { attempts: state.judgementAttempts, … }` taken ahead of the await.
    expect(RELEVANCE_CODE).not.toMatch(/const before = \{\s*attempts: state\.judgementAttempts/);
    /** And no live code reads that counter here at all — only the note explaining why. */
    expect(RELEVANCE_CODE).not.toContain("state.judgementAttempts");
  });

  /** One `judgeBeatImage` call makes at most one model call, so a look is worth exactly one. */
  it("a look that reached a model costs exactly one", () => {
    const block = spendBlock();
    expect(block).toContain("judged: lookedAtAModel ? 1 : 0");
  });

  /**
   * A cached verdict is a real verdict that cost nothing. Charging it would let a beat run out of
   * budget on answers it already had — the opposite of what the ceiling is for.
   */
  it("a cached answer is not charged", () => {
    expect(RELEVANCE).toContain("judgement.evaluated === true && judgement.cached !== true");
  });

  /** A decline is not a look. It is counted as skipped, which is what it is. */
  it("a decline is counted as skipped, never as a look", () => {
    const block = spendBlock();
    expect(block).toContain("skipped: judgement.evaluated === false ? 1 : 0");
  });

  /** Asked and got nothing back is a failure — distinct from both a look and a decline. */
  it("an asked-but-unusable answer is counted as failed", () => {
    expect(spendBlock()).toContain('failed: lookedAtAModel && judgement.verdict === "unknown" ? 1 : 0');
  });

  /** The ceiling only ever sees looks this beat actually took. */
  it("only a real look moves the per-beat ceiling", () => {
    expect(RELEVANCE).toContain("if (spent.judged > 0) ledger.spendByBeat.set(slot, spentOnBeat + spent.judged);");
  });
});

/* ═════════════ 2. a refusal says whether anybody looked ═════════════ */

describe("2. never asked and answered no are not the same refusal", () => {
  const approvalBlock = () => {
    const at = RELEVANCE.indexOf('if (d.verdict !== "fits") {');
    expect(at).toBeGreaterThan(0);
    return RELEVANCE.slice(at, at + 2600);
  };

  it("a clip nobody looked at is refused in those words", () => {
    expect(approvalBlock()).toContain("nobody looked at this clip");
  });

  it("the two are told apart by `evaluated`, the field that has always known", () => {
    expect(approvalBlock()).toContain("d.evaluated === false");
  });

  /** A real verdict still reads as one — this changes what is SAID, never who gets in. */
  it("a judged refusal still names the verdict the editor gave", () => {
    expect(approvalBlock()).toContain("the editor answered ${d.verdict} on");
  });

  /**
   * THE THING THAT MUST NOT CHANGE. A picture nobody vouched for still does not fill a hole; the
   * standing rule is that UNKNOWN is not APPROVED and never_asked is not verified. Both branches
   * refuse.
   */
  it("both cases are still refusals — nothing is let through", () => {
    const block = approvalBlock();
    const allows = block.slice(0, block.indexOf("};", block.indexOf("return {")));
    expect(allows).toContain("allow: false");
    expect(allows).not.toContain("allow: true");
  });
});

/* ═════════════ 3. the render can count the difference ═════════════ */

describe("3. the render says how many refusals were nobody's fault but its own", () => {
  it("the never-looked-at refusals are counted separately", () => {
    expect(PIPE).toContain("backfillRefusedNeverLookedAt: number;");
    expect(PIPE).toContain("backfillRefusedNeverLookedAt: 0,");
    expect(PIPE).toContain('barrier.reason.includes("nobody looked at this clip")');
  });

  /** A subset, not a replacement: the total still counts every refusal this rule caused. */
  it("it is a subset of the total, counted alongside it", () => {
    const at = PIPE.indexOf("dedup.backfillRefusedWithoutApproval += 1;");
    expect(at).toBeGreaterThan(0);
    expect(PIPE.slice(at, at + 600)).toContain("dedup.backfillRefusedNeverLookedAt += 1;");
  });

  it("the render report prints both numbers", () => {
    const at = PIPE.indexOf("[BackfillApproval] refused=");
    expect(at).toBeGreaterThan(0);
    const line = PIPE.slice(at, at + 700);
    expect(line).toContain("neverLookedAt=${visualDedup.backfillRefusedNeverLookedAt}");
    expect(line).toContain("not an editorial refusal");
  });
});
