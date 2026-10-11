import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  JUDGE_BASE_SCALE,
  JUDGE_BUDGET_MAX_CEILING_MS,
  JUDGE_BUDGET_MIN_CEILING_MS,
  JUDGE_CEILING_MS_PER_VIDEO_SEC,
  JUDGE_MS_PER_LOOK,
  createJudgeBudget,
  judgeBudgetCeilingMs,
} from "./judgeBudget";

/**
 * VIDEO 644 — the picture editor's own budget was the one time limit that provably cut pictures:
 *
 *     [JudgeBudget] started base=55000ms ceiling=188018ms perLook=5000ms sentencesWithoutPicture=9
 *     [JudgeBudget] granted=55000ms used=55003ms left=0ms … queued=11 judged=9 FIT=2 MISMATCH=7
 *                   stop=JUDGE_BUDGET_EXHAUSTED notReviewed=[s0b0,s0b1,s1b0,s1b1,s1b3,s2b0,s2b1,s2b2]
 *
 * Eleven looks granted 55 s (11 × 5 s = the base), nine judged, eight sentences never got their last
 * look while 133 s of ceiling went unused. Half again on the per-look grant and on the base; the
 * ceiling, the per-sentence and per-render look counts and the force-export bound do not move.
 */
const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
const BASE_644_MS = 10_000 + 45_000;

describe("VIDEO 644 — the picture editor's budget, half again on what 644 actually used", () => {
  it("per look: 7.5 s, half again on the 5 s that 644 measured as too little", () => {
    expect(JUDGE_MS_PER_LOOK).toBe(7_500);
  });

  it("base: scaled once, by 1.5, from the two constants it is built from — which do not move", () => {
    expect(JUDGE_BASE_SCALE).toBe(1.5);
    const vp = read("videoPipeline.ts");
    expect(vp).toContain("const judgeBaseMs = Math.round((FINAL_REVIEW_WINDOW_MS + FINAL_LOOK_TURN_MS) * JUDGE_BASE_SCALE);");
    expect(vp).toContain("export const ARCHIVE_JUDGE_MIN_MS = 10_000;");
    expect(vp).toContain("export const JUDGED_BEAT_TURN_MS = 45_000;");
    expect(Math.round(BASE_644_MS * JUDGE_BASE_SCALE)).toBe(82_500);
  });

  it("644 replayed: eleven looks are granted 82.5 s instead of 55 s, still under the same ceiling", () => {
    let t = 0;
    const base = Math.round(BASE_644_MS * JUDGE_BASE_SCALE);
    const ceiling = judgeBudgetCeilingMs(62.67, Number.POSITIVE_INFINITY, base);
    expect(ceiling).toBe(Math.round(62.67 * JUDGE_CEILING_MS_PER_VIDEO_SEC));
    const b = createJudgeBudget({ baseMs: base, ceilingMs: ceiling, now: () => t });
    b.grant(11);
    expect(b.grantedMs()).toBe(82_500);
    expect(b.grantedMs()).toBeLessThan(ceiling);
    t = 55_003;
    expect(b.leftMs()).toBeGreaterThan(27_000);
  });

  it("645 replayed: five looks granted; s2b0's FIT arrived 79 s in — inside 82.5 s, outside the 55 s that cut it", () => {
    /**
     * 645: [JudgeBudget] started base=55000ms … perLook=5000ms; granted=55000ms used=62090ms stop=JUDGE_BUDGET_EXHAUSTED
     * notReviewed=[s1b1,s2b0]; 15:29:22 start → 15:30:41 "s2b0 adopt fits … Elon Musk … Cybertruck" (+79 s) →
     * APPROVED_NOT_PLACED "approved after scene closed". s1b1's last verdict came at +65 s.
     */
    let t = 0;
    const base = Math.round(BASE_644_MS * JUDGE_BASE_SCALE);
    const ceiling = judgeBudgetCeilingMs(52.46, Number.POSITIVE_INFINITY, base);
    const b = createJudgeBudget({ baseMs: base, ceilingMs: ceiling, now: () => t });
    b.grant(5);
    expect(b.grantedMs()).toBe(82_500);
    t = 65_000;
    expect(b.leftMs()).toBeGreaterThan(0);
    t = 79_000;
    expect(b.leftMs()).toBeGreaterThan(0);
    /** the 55 s base of 645 would have ended the wait before either verdict */
    let t2 = 0;
    const old = createJudgeBudget({ baseMs: BASE_644_MS, ceilingMs: ceiling, now: () => t2 });
    old.grant(5);
    expect(old.grantedMs()).toBe(55_000);
    t2 = 65_000;
    expect(old.leftMs()).toBeLessThan(0);
    t2 = 79_000;
    expect(old.leftMs()).toBeLessThan(0);
  });

  it("the ceiling still binds: by length between 3 and 10 minutes, and never past the force-export moment", () => {
    const base = Math.round(BASE_644_MS * JUDGE_BASE_SCALE);
    expect(judgeBudgetCeilingMs(30, Number.POSITIVE_INFINITY, base)).toBe(JUDGE_BUDGET_MIN_CEILING_MS);
    expect(judgeBudgetCeilingMs(3_600, Number.POSITIVE_INFINITY, base)).toBe(JUDGE_BUDGET_MAX_CEILING_MS);
    expect(judgeBudgetCeilingMs(600, 90_000, base)).toBe(90_000);
    /** Below the base the base is kept: what the stage had before this budget existed is never taken away. */
    expect(judgeBudgetCeilingMs(600, 10_000, base)).toBe(base);
    const b = createJudgeBudget({ baseMs: base, ceilingMs: judgeBudgetCeilingMs(62.67, Number.POSITIVE_INFINITY, base), now: () => 0 });
    b.grant(1_000);
    expect(b.grantedMs()).toBe(Math.round(62.67 * JUDGE_CEILING_MS_PER_VIDEO_SEC));
    expect(Number.isFinite(b.grantedMs())).toBe(true);
  });

  it("the look counts are untouched: four per sentence, one hundred and twenty per render", () => {
    const gate = read("beatImageRelevanceGate.ts");
    expect(gate).toContain('export const MAX_JUDGEMENTS_PER_BEAT = envInt("MAX_BEAT_IMAGE_JUDGEMENTS_PER_BEAT", 4, 1, 12);');
    expect(gate).toContain('return envInt("MAX_BEAT_IMAGE_JUDGEMENTS", 120, 0, 500);');
  });
});
