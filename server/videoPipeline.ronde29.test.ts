import { readFileSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TARGET_MOVING_SHARE,
  MIN_MIX_SAMPLE,
  movingShareDeficit,
  resolveTargetMovingShare,
  summarizeMovingShare,
} from "./visualMixPolicy";

import type { PoolCandidate } from "./scenePool";
import {
  createGateFiringStats,
  findSilentGates,
  formatGateFiringSummary,
  getActiveGateFiringStats,
  recordGateVerdict,
  runWithGateFiringStats,
  SILENT_GATE_MIN_ASKED,
  summarizeGateFiring,
} from "./gateFiringStats";

describe("RONDE 29b — the moving-footage target the ranking leans on", () => {
  afterEach(() => {
    delete process.env.TARGET_MOVING_SHARE;
    delete process.env.MOVING_FOOTAGE_BONUS;
  });

  it("reports no deficit before there is enough of a sample to judge", () => {
    // One still out of one clip is a 100% shortfall on paper and means nothing in practice.
    expect(movingShareDeficit(0, 1, 0.45)).toBe(0);
    expect(movingShareDeficit(0, MIN_MIX_SAMPLE - 1, 0.45)).toBe(0);
  });

  it("reports no deficit once the target is met or beaten", () => {
    expect(movingShareDeficit(5, 10, 0.45)).toBe(0);
    expect(movingShareDeficit(9, 10, 0.45)).toBe(0);
  });

  it("scales from 0 to 1 as the render drifts toward all stills", () => {
    expect(movingShareDeficit(0, 10, 0.5)).toBe(1);
    expect(movingShareDeficit(2, 10, 0.5)).toBeCloseTo(0.6, 5);
    expect(movingShareDeficit(4, 10, 0.5)).toBeCloseTo(0.2, 5);
  });

  it("reads the target from env and refuses nonsense values", () => {
    expect(resolveTargetMovingShare()).toBe(DEFAULT_TARGET_MOVING_SHARE);
    process.env.TARGET_MOVING_SHARE = "0.7";
    expect(resolveTargetMovingShare()).toBe(0.7);
    process.env.TARGET_MOVING_SHARE = "not a number";
    expect(resolveTargetMovingShare()).toBe(DEFAULT_TARGET_MOVING_SHARE);
    process.env.TARGET_MOVING_SHARE = "4";
    expect(resolveTargetMovingShare()).toBe(DEFAULT_TARGET_MOVING_SHARE);
  });

  it("summarises the mix for the quality report", () => {
    expect(summarizeMovingShare(7, 11)).toBe("7/18 moving (39%), 11 still");
    expect(summarizeMovingShare(0, 0)).toBe("no clips adopted");
  });

  it("documents that the slot planner is deliberately left unwired", () => {
    // If a later audit finds planVisualMixForBeats with no callers again, the reason it has
    // none must be findable in the file itself rather than only in a chat log.
    const src = readFileSync(path.join(__dirname, "visualMixPolicy.ts"), "utf8");
    expect(src).toContain("NOT WIRED, on purpose");
    expect(src).toContain("planVisualMixForBeats");
  });
});

describe("RONDE 29c — per-gate ask/fire counters", () => {
  it("is inert outside a render instead of throwing or leaking", () => {
    // Gate helpers are shared with archive ingestion and exercised directly by unit tests;
    // neither has a collector, and neither should have to know that.
    expect(() => recordGateVerdict("baked_text", true)).not.toThrow();
    expect(getActiveGateFiringStats()).toBeNull();
  });

  it("counts every ask and only the rejections as fires", () => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      recordGateVerdict("vision_gate", false);
      recordGateVerdict("vision_gate", true);
      recordGateVerdict("vision_gate", false);
    });
    expect(summarizeGateFiring(stats)).toEqual([
      // RONDE 174 added closestShortfall/notArmed to the row. Null and 0 are what a gate that
      // reports no evidence must produce — a shortfall of 0 would read as "it came within
      // nothing of firing", which is a different and much more alarming statement.
      { gate: "vision_gate", asked: 3, fired: 1, closestShortfall: null, notArmed: 0 },
    ]);
  });

  it("orders the summary by how busy each gate was", () => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      recordGateVerdict("still_cap", true);
      for (let i = 0; i < 5; i++) recordGateVerdict("baked_text", false);
    });
    expect(summarizeGateFiring(stats).map((r) => r.gate)).toEqual(["baked_text", "still_cap"]);
  });

  it("flags a gate that was asked repeatedly and never once said no", () => {
    // This is the modern-mismatch bug's exact signature.
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      for (let i = 0; i < SILENT_GATE_MIN_ASKED; i++) recordGateVerdict("modern_mismatch", false);
    });
    expect(findSilentGates(stats)).toEqual([
      { gate: "modern_mismatch", asked: SILENT_GATE_MIN_ASKED, fired: 0, closestShortfall: null, notArmed: 0 },
    ]);
  });

  it("stays quiet about a gate that fired at least once", () => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      for (let i = 0; i < 40; i++) recordGateVerdict("modern_mismatch", i === 17);
    });
    expect(findSilentGates(stats)).toEqual([]);
  });

  it("stays quiet about a gate that was barely asked — silence on 3 candidates is not evidence", () => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      for (let i = 0; i < 3; i++) recordGateVerdict("entity_evidence", false);
    });
    expect(findSilentGates(stats)).toEqual([]);
  });

  it("formats the per-gate line as fired/asked", () => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      recordGateVerdict("baked_text", true);
      recordGateVerdict("baked_text", false);
      recordGateVerdict("still_cap", false);
    });
    expect(formatGateFiringSummary(stats)).toBe("baked_text=1/2 still_cap=0/1");
    expect(formatGateFiringSummary(createGateFiringStats())).toBe("no gates recorded");
  });

  it("keeps two concurrent renders' counters apart", async () => {
    // A bare module-level counter would merge these — the same class of bug that moved
    // elevenLabsQuotaExhausted onto RenderCtx.
    const a = createGateFiringStats();
    const b = createGateFiringStats();
    await Promise.all([
      runWithGateFiringStats(a, async () => {
        recordGateVerdict("vision_gate", true);
        await new Promise((r) => setTimeout(r, 5));
        recordGateVerdict("vision_gate", true);
      }),
      runWithGateFiringStats(b, async () => {
        await new Promise((r) => setTimeout(r, 1));
        recordGateVerdict("baked_text", false);
      }),
    ]);
    expect(summarizeGateFiring(a)).toEqual([
      { gate: "vision_gate", asked: 2, fired: 2, closestShortfall: null, notArmed: 0 },
    ]);
    expect(summarizeGateFiring(b)).toEqual([
      { gate: "baked_text", asked: 1, fired: 0, closestShortfall: null, notArmed: 0 },
    ]);
  });

  it("instruments the gate that motivated this whole mechanism", () => {
    const src = readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
    expect(src).toContain('recordGateVerdict("modern_mismatch"');
    // After the not-armed / no-probes early returns, so "asked" means it genuinely judged.
    const idxNotArmed = src.indexOf("if (!topicNeedsHistoricalFootage(beatText, videoTitle)) return notArmed;");
    const idxRecord = src.indexOf('recordGateVerdict("modern_mismatch"');
    expect(idxNotArmed).toBeGreaterThan(-1);
    expect(idxRecord).toBeGreaterThan(idxNotArmed);
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────

function poolVideo(): PoolCandidate {
  return {
    id: "pexels:1",
    source: "pexels",
    title: "archival looking clip",
    thumbnailUrl: null,
    mediaType: "video",
  } as PoolCandidate;
}

function poolImage(): PoolCandidate {
  return {
    id: "wikimedia:1",
    source: "wikimedia",
    title: "a photograph",
    thumbnailUrl: null,
    mediaType: "image",
  } as PoolCandidate;
}
