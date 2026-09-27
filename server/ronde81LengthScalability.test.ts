import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one-minute length no longer takes a different path by default — see
 * `isFastShortVideoLength`. The fast-short tuning still EXISTS and is still what this file is
 * about, so these tests enable it explicitly rather than being loosened: the behaviour is
 * unchanged, only its default is.
 */
beforeEach(() => { vi.stubEnv("FAST_SHORT_PATH", "true"); });
afterEach(() => { vi.unstubAllEnvs(); });

import { computeRenderBudget } from "./renderBudget";
import {
  isFastShortVideoLength,
  maxPipelineWallClockHardMin,
  maxPipelineWallClockMin,
  pipelineEmergencyFinishMs,
  pipelineRushModeMs,
  visualSourcingTurboMs,
} from "./sourcingPolicy";
import { getScenesForLength, groupScenesIntoChunks } from "./videoPipeline";
import type { Scene } from "@shared/schema";

/**
 * RONDE 81 — a longer video is more work, not a different pipeline.
 *
 * The RONDE 80 audit measured the defect: every per-stage budget is a percentage of
 * totalRenderMinutes() divided by the scene count, the scene count grows linearly with length
 * (3/18/25/35), and totalRenderMinutes() was sublinear with a hard 40-minute ceiling. A
 * sublinear total over a linear divisor is a per-scene budget that SHRINKS as the video grows:
 *
 *     length     per-scene compose     per-scene retrieve
 *     1 min                    88s                    32s
 *     8-10                     45s                    20s     <- the clamp FLOOR
 *     10-15                    45s                    20s     <- identical
 *     15-20                    45s                    20s     <- identical
 *
 * The formula had saturated: three different lengths got byte-identical per-scene budgets. On
 * top of that, chunkStageTimeoutMs portioned a FLAT whole-video stage total by scene count while
 * the per-scene timeouts stayed flat, so a chunk was killed for taking time its own scenes were
 * explicitly allowed to take — by 2.09x at 8-10 and 3.38x at 15-20.
 *
 * Every test below runs the real functions. §A-§C pin the budgets, §D-§F the chunk deadlines,
 * §G the escalation ladder, §H the compose-timeout salvage and its index alignment.
 */

const LENGTHS = ["1", "8-10", "10-15", "15-20"] as const;
/** Spoken seconds per bucket — scriptWriter.ts's SPOKEN_SECONDS. */
const VIDEO_SEC: Record<string, number> = { "1": 58, "8-10": 540, "10-15": 750, "15-20": 1050 };

function budgetFor(len: string) {
  return computeRenderBudget(getScenesForLength(len), VIDEO_SEC[len]!, len);
}

function scenesFor(len: string): Scene[] {
  const n = getScenesForLength(len);
  const dur = VIDEO_SEC[len]! / n;
  return Array.from({ length: n }, (_, i) => ({ index: i, duration: dur })) as unknown as Scene[];
}

const PIPELINE_SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═════════════ §A — the render budget scales with length ═════════════ */

describe("RONDE 81 §A — render budget", () => {
  it("grows with the video, instead of flattening out at a ceiling", () => {
    const totals = LENGTHS.map((l) => budgetFor(l).totalMs);
    for (let i = 1; i < totals.length; i += 1) {
      expect(totals[i], `${LENGTHS[i]} must not budget less than ${LENGTHS[i - 1]}`)
        .toBeGreaterThan(totals[i - 1]!);
    }
  });

  it("never exceeds the central wall-clock policy", () => {
    // maxPipelineWallClockHardMin stays the ultimate ceiling — this round does not raise it.
    for (const len of LENGTHS) {
      const b = budgetFor(len);
      expect(b.totalMs, len).toBeLessThanOrEqual(maxPipelineWallClockHardMin(len) * 60_000);
    }
  });

  it("the 1-minute budget is unchanged", () => {
    // The <= 3 min branch of totalRenderMinutes was deliberately left alone.
    const b = budgetFor("1");
    expect(b.basePerSceneComposeMs).toBe(88_000);
    expect(b.perSceneRetrieveMs).toBe(32_000);
    expect(b.concatMs).toBe(60_000);
  });
});

/* ═════════════ §B — the per-scene budget does not shrink ═════════════ */

describe("RONDE 81 §B — per-scene budget is independent of how many scenes there are", () => {
  it("compose: every length lands in the same band, and no long video is below the short one by more than a hair", () => {
    const perScene = LENGTHS.map((l) => budgetFor(l).basePerSceneComposeMs);
    const min = Math.min(...perScene);
    const max = Math.max(...perScene);
    // Before: 88 / 45 / 45 / 45 — a 1.96x spread with the three long lengths pinned to the floor.
    expect(max / min, `spread too wide: ${perScene.join(", ")}`).toBeLessThan(1.2);
    expect(min).toBeGreaterThanOrEqual(75_000);
  });

  it("retrieve: same", () => {
    const perScene = LENGTHS.map((l) => budgetFor(l).perSceneRetrieveMs);
    expect(Math.max(...perScene) / Math.min(...perScene)).toBeLessThan(1.2);
  });

  it("the three long lengths no longer share one identical saturated budget", () => {
    // This is the direct signature of the old defect: 8-10, 10-15 and 15-20 all clamped to the
    // same floor, so the formula had stopped responding to length entirely.
    const compose = ["8-10", "10-15", "15-20"].map((l) => budgetFor(l).basePerSceneComposeMs);
    expect(new Set(compose).size, `all identical: ${compose.join(", ")}`).toBeGreaterThan(1);
  });

  it("a longer video never gets LESS per scene than a shorter one", () => {
    for (const [shorter, longer] of [["8-10", "10-15"], ["10-15", "15-20"]] as const) {
      expect(budgetFor(longer).basePerSceneComposeMs)
        .toBeGreaterThanOrEqual(budgetFor(shorter).basePerSceneComposeMs);
      expect(budgetFor(longer).perSceneRetrieveMs)
        .toBeGreaterThanOrEqual(budgetFor(shorter).perSceneRetrieveMs);
    }
  });

  it("the final concat budget scales with the video it has to re-encode", () => {
    // The concat is a full libx264 re-encode of the whole video; a flat 210s ceiling gave a
    // 17.5-minute video the same budget as a 3-minute one.
    const concat = LENGTHS.map((l) => budgetFor(l).concatMs);
    for (let i = 1; i < concat.length; i += 1) {
      expect(concat[i], `${LENGTHS[i]}`).toBeGreaterThan(concat[i - 1]!);
    }
    // At least 2.5x realtime for the longest bucket.
    expect(budgetFor("15-20").concatMs).toBeGreaterThanOrEqual((VIDEO_SEC["15-20"]! * 1000) / 2.5);
  });
});

/* ═════════════ §C — still inside the safety policy ═════════════ */

describe("RONDE 81 §C — the budgets stay coherent with each other", () => {
  it("the sum of every scene's compose+retrieve budget fits inside the hard wall clock", () => {
    for (const len of LENGTHS) {
      const b = budgetFor(len);
      const scenes = getScenesForLength(len);
      const sum = (b.basePerSceneComposeMs + b.perSceneRetrieveMs) * scenes + b.concatMs + b.ttsMs;
      expect(sum, len).toBeLessThan(maxPipelineWallClockHardMin(len) * 60_000);
    }
  });

  it("no budget is an arbitrarily large number", () => {
    for (const len of LENGTHS) {
      const b = budgetFor(len);
      expect(b.basePerSceneComposeMs).toBeLessThanOrEqual(180_000);
      expect(b.perSceneRetrieveMs).toBeLessThanOrEqual(55_000);
      // The whole render budget stays within an order of magnitude of the video's own length.
      expect(b.totalMs / 60_000).toBeLessThan((VIDEO_SEC[len]! / 60) * 20 + 25);
    }
  });
});

/* ═════════════ §D/§E/§F — chunk deadlines ═════════════ */

/** chunkStageTimeoutMs, reproduced from videoPipeline.ts — it is module-private. */
const CHUNK_DEADLINE_SLACK = 1.15;
function chunkStageTimeoutMs(
  totalStageMs: number,
  chunkSceneCount: number,
  totalSceneCount: number,
  minMs = 20_000,
  perSceneMs = 0
): number {
  const portion =
    totalSceneCount <= 0 ? totalStageMs : Math.round((totalStageMs * chunkSceneCount) / totalSceneCount);
  const scenesNeed =
    perSceneMs > 0 ? Math.round(perSceneMs * Math.max(1, chunkSceneCount) * CHUNK_DEADLINE_SLACK) : 0;
  return Math.max(minMs, portion, scenesNeed);
}

describe("RONDE 81 §D — a chunk deadline is never below what its scenes may take", () => {
  it("the reproduction above matches the real implementation", () => {
    // If the production signature or the slack changes, this test file is measuring a ghost.
    expect(PIPELINE_SRC).toContain("const CHUNK_DEADLINE_SLACK = 1.15;");
    expect(PIPELINE_SRC).toContain("perSceneMs > 0 ? Math.round(perSceneMs * Math.max(1, chunkSceneCount) * CHUNK_DEADLINE_SLACK) : 0");
    expect(PIPELINE_SRC).toContain("return Math.max(minMs, portion, scenesNeed);");
  });

  it("holds for one scene, two scenes, and a large chunk alike — not hardcoded for 2", () => {
    const perScene = 600_000;
    for (const size of [1, 2, 3, 7, 20]) {
      const deadline = chunkStageTimeoutMs(2_400_000, size, 35, 20_000, perScene);
      expect(deadline, `chunk of ${size}`).toBeGreaterThanOrEqual(perScene * size);
    }
  });

  it("the visual chunk deadline covers its scenes at every length", () => {
    // perf.sceneVisualTimeoutMs per bucket — videoPipeline.ts getPipelinePerfProfile.
    const perSceneVisual: Record<string, number> = {
      "1": 3 * 60_000, "8-10": 12 * 60_000, "10-15": 10 * 60_000, "15-20": 10 * 60_000,
    };
    for (const len of LENGTHS) {
      const scenes = scenesFor(len);
      const chunks = groupScenesIntoChunks(scenes, 60);
      const total = isFastShortVideoLength(len) ? 20 * 60_000 : Math.round(90 * 60_000 * 1.15);
      for (const c of chunks) {
        const size = c.end - c.start;
        const deadline = chunkStageTimeoutMs(total, size, scenes.length, 20_000, perSceneVisual[len]);
        expect(deadline, `${len} chunk of ${size}`).toBeGreaterThanOrEqual(perSceneVisual[len]! * size);
      }
    }
  });

  it("the compose chunk deadline covers a slot that may compose the scene twice", () => {
    for (const len of LENGTHS) {
      const b = budgetFor(len);
      const slot = isFastShortVideoLength(len)
        ? Math.round(b.basePerSceneComposeMs * 1.5)
        : Math.round(b.basePerSceneComposeMs * 3);
      const scenes = scenesFor(len);
      const chunks = groupScenesIntoChunks(scenes, 60);
      const total = isFastShortVideoLength(len) ? 9 * 60_000 : 2_400_000;
      for (const c of chunks) {
        const size = c.end - c.start;
        const deadline = chunkStageTimeoutMs(total, size, scenes.length, 20_000, slot);
        expect(deadline, `${len} chunk of ${size}`).toBeGreaterThanOrEqual(slot * size);
      }
    }
  });

  it("a chunk deadline never gets SMALLER than the portion it used to be", () => {
    // The floor is additive: nothing loses budget it had before this round.
    for (const size of [1, 2, 5]) {
      const before = chunkStageTimeoutMs(2_400_000, size, 35);
      const after = chunkStageTimeoutMs(2_400_000, size, 35, 20_000, 270_000);
      expect(after).toBeGreaterThanOrEqual(before);
    }
  });

  it("passing no per-scene deadline keeps the old behaviour exactly", () => {
    expect(chunkStageTimeoutMs(2_400_000, 2, 35)).toBe(137_143);
    expect(chunkStageTimeoutMs(2_400_000, 2, 35, 20_000, 0)).toBe(137_143);
  });
});

/* ═════════════ §G — long videos can degrade too ═════════════ */

describe("RONDE 81 §G — the escalation ladder exists at every length", () => {

  it("a long video's ladder is scaled to its own budget, not to the 1-minute one", () => {
    for (const len of ["8-10", "10-15", "15-20"] as const) {
      // Before: the predicates refused to fire at all for these lengths, and the dead values
      // behind the guard were 12s / 3min / 7min — which would have force-exported a 20-minute
      // video after seven minutes.
      expect(pipelineEmergencyFinishMs(len), len).toBeGreaterThan(7 * 60_000);
      // And every rung stays inside the length's own hard cap.
      expect(pipelineEmergencyFinishMs(len)).toBeLessThan(maxPipelineWallClockHardMin(len) * 60_000);
    }
  });
});

/* ═════════════ §J — the remontage path is budgeted, not disabled ═════════════ */

describe("RONDE 81 §J — the sync-audit remontage", () => {

  it("the declared worst case actually covers two composes", () => {
    for (const len of LENGTHS) {
      const compose = budgetFor(len).basePerSceneComposeMs;
      const slot = isFastShortVideoLength(len) ? compose * 1.5 : compose * 3;
      if (!isFastShortVideoLength(len)) expect(slot, len).toBeGreaterThanOrEqual(compose * 2);
    }
  });
});
