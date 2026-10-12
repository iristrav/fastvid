/**
 * VIDEO 647 — FORCE-EXPORT SKIPS POLISH; IT DOES NOT END THE SEARCH FOR PICTURES.
 *
 * Before this round the force-export moment (`pipelineEmergencyFinishMs`, 60 % of the target wall
 * clock) capped three things that are not polish: the visual deadline, the picture editor's ceiling
 * and the rescue of the scenes that found nothing. A 3-minute film stopped looking at 18 min while
 * its picture stage was allowed 24 and its hard fail sat at 39; a 1-minute film whose deadline had
 * passed gave its empty scenes 60 s. The picture stage is now read against one technical clock —
 * the hard wall clock minus the render reserve (`pictureStageWallClockCeilingMs`, 30 min for a 1-
 * or 3-minute film) — and the reserve above it, up to the hard watchdog, is kept for compose, gate
 * and upload.
 *
 * Each scenario below is the case the user named: the normal picture deadline has already passed,
 * force-export has already fired, and the hard watchdog still has time.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  EMPTY_SCENE_RESCUE_MIN_MS,
  JUDGED_BEAT_TURN_MS,
  emptySceneRescueWindowMs,
  judgeableVisualDeadlineMs,
  withSceneFetchTimeout,
} from "./videoPipeline";
import { JUDGE_BASE_SCALE, judgeBudgetCeilingMs, createJudgeBudget } from "./judgeBudget";
import {
  YOUTUBE_FIRST_BEAT_WORST_MS,
  YOUTUBE_FIRST_TURN_MS,
  maxPipelineWallClockHardMin,
  maxPipelineWallClockMin,
  pictureStageWallClockCeilingMs,
  pipelineEmergencyFinishMs,
  pipelineProgressStallThresholdMs,
  visualStageWallClockMin,
  youtubeDownloadTimeoutMs,
} from "./sourcingPolicy";
import { stripComments } from "./sourceScan.test.support";

const PIPE = stripComments(fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8"));
const MIN = 60_000;

/**
 * A render as the clocks see it: the script and the voice took `ttsMin`, the picture stage then
 * used its whole cap, and the deadline passed `overrunSec` ago. Everything is measured from the
 * render's start, as the pipeline measures its target and hard clocks.
 */
function lateRender(len: string, opts: { ttsMin?: number; overrunSec?: number; videoSec: number; pictureStageMs?: number }) {
  const ttsMin = opts.ttsMin ?? 3;
  const overrunMs = (opts.overrunSec ?? 30) * 1000;
  /** the worst case unless told otherwise: the picture stage used its whole cap AND force-export has fired */
  const pictureStageMs = (opts.pictureStageMs ?? Math.max(visualStageWallClockMin(len) * MIN, pipelineEmergencyFinishMs(len))) + overrunMs;
  const elapsedMs = ttsMin * MIN + pictureStageMs;
  return {
    len,
    videoSec: opts.videoSec,
    elapsedMs,
    deadlineLeftMs: -overrunMs,
    ceilingLeftMs: pictureStageWallClockCeilingMs(len) - elapsedMs,
    hardLeftMs: maxPipelineWallClockHardMin(len) * MIN - elapsedMs,
    /** force-export counts from the picture stage's own start (`dedup.pipelineStartedMs` is reset there). */
    forceExportFired: pictureStageMs > pipelineEmergencyFinishMs(len),
  };
}

/** A 646-shaped film at this length: a scene per 20 s, four sentences each, chunks of six scenes. */
function sentenceFloorDeadlineMs(len: string, videoSec: number): number {
  const scenes = Math.max(1, Math.round(videoSec / 20));
  const chunks: number[][] = [];
  for (let i = 0; i < scenes; i += 6) chunks.push(Array(Math.min(6, scenes - i)).fill(4));
  const cap = Math.min(visualStageWallClockMin(len) * MIN, pictureStageWallClockCeilingMs(len));
  return judgeableVisualDeadlineMs(videoSec * 2.85 * 1000, chunks, cap);
}

const SCENARIOS = [
  { len: "1", videoSec: 60, label: "1-minute film" },
  { len: "3", videoSec: 180, label: "3-minute film" },
  { len: "5", videoSec: 300, label: "5-minute film" },
] as const;

describe("1. force-export has fired, the deadline has passed, the hard watchdog has time — pictures are still searched", () => {
  it.each(SCENARIOS)("$label, worst case — the whole picture cap used, force-export fired: the empty scenes still get a real rescue, not 60 s", ({ len, videoSec }) => {
    const r = lateRender(len, { videoSec });
    expect(r.forceExportFired, "the scenario is the one named: force-export already fired").toBe(true);
    expect(r.hardLeftMs, "and the hard watchdog still has time").toBeGreaterThan(9 * MIN);
    expect(r.ceilingLeftMs, "the picture ceiling still has time").toBeGreaterThan(EMPTY_SCENE_RESCUE_MIN_MS);

    /** two empty scenes, four and three sentences, three scenes at a time */
    const w = emptySceneRescueWindowMs({ deadlineLeftMs: r.deadlineLeftMs, sentencesPerEmptyScene: [4, 3], sceneParallelism: 3, ceilingLeftMs: r.ceilingLeftMs });
    expect(w).toBeGreaterThan(EMPTY_SCENE_RESCUE_MIN_MS);
    /** at least one full YouTube turn (search + download window), even after the whole cap was spent */
    expect(w).toBeGreaterThanOrEqual(YOUTUBE_FIRST_TURN_MS);
    expect(w).toBe(Math.min(4 * YOUTUBE_FIRST_BEAT_WORST_MS, r.ceilingLeftMs));
    /** and never past the picture ceiling, which itself sits under the hard watchdog */
    expect(w).toBeLessThanOrEqual(r.ceilingLeftMs);
    expect(r.ceilingLeftMs).toBeLessThan(r.hardLeftMs);
  });

  it.each(SCENARIOS)("$label, the usual case — the deadline was the per-sentence floor and has passed: every empty sentence gets its YouTube worst case", ({ len, videoSec }) => {
    const r = lateRender(len, { videoSec, pictureStageMs: sentenceFloorDeadlineMs(len, videoSec) });
    expect(r.hardLeftMs).toBeGreaterThan(9 * MIN);
    const w = emptySceneRescueWindowMs({ deadlineLeftMs: r.deadlineLeftMs, sentencesPerEmptyScene: [4, 3], sceneParallelism: 3, ceilingLeftMs: r.ceilingLeftMs });
    expect(w).toBeGreaterThanOrEqual(YOUTUBE_FIRST_BEAT_WORST_MS);
    expect(w).toBeGreaterThanOrEqual(youtubeDownloadTimeoutMs());
    expect(w).toBe(Math.min(4 * YOUTUBE_FIRST_BEAT_WORST_MS, r.ceilingLeftMs));
    expect(w).toBeGreaterThan(EMPTY_SCENE_RESCUE_MIN_MS * 2);
  });

  it.each(SCENARIOS)("$label: the picture editor still gets a budget for its last looks", ({ len, videoSec }) => {
    const r = lateRender(len, { videoSec });
    const base = Math.round((10_000 + JUDGED_BEAT_TURN_MS) * JUDGE_BASE_SCALE);
    const ceiling = judgeBudgetCeilingMs(videoSec, r.ceilingLeftMs, base);
    expect(ceiling).toBeGreaterThanOrEqual(base);
    expect(ceiling).toBeLessThanOrEqual(Math.max(base, r.ceilingLeftMs));
    let t = 0;
    const b = createJudgeBudget({ baseMs: base, ceilingMs: ceiling, now: () => t });
    b.grant(3);
    expect(b.leftMs()).toBeGreaterThan(0);
  });

  it.each(SCENARIOS)("$label: the picture deadline itself is capped by the ceiling, not by force-export", ({ len }) => {
    const visualMs = visualStageWallClockMin(len) * MIN;
    const ceilingMs = pictureStageWallClockCeilingMs(len);
    const emergencyMs = pipelineEmergencyFinishMs(len);
    /** fresh render: the whole ceiling is still ahead; the cap is the picture stage's own wall clock */
    const cap = Math.min(visualMs, Math.max(JUDGED_BEAT_TURN_MS, ceilingMs));
    expect(cap).toBe(visualMs);
    expect(cap).toBeGreaterThanOrEqual(emergencyMs > visualMs ? visualMs : emergencyMs);
    /** a long film's floor of judged turns is read against that cap */
    expect(judgeableVisualDeadlineMs(0, Array.from({ length: 40 }, () => [8, 6]), cap)).toBe(cap);
  });
});

describe("2. the clocks, in order: force-export ≤ picture ceiling < hard watchdog", () => {
  it.each(["1", "3", "5", "8-10", "10-15", "30", "60"])("length %s", (len) => {
    const visualMs = visualStageWallClockMin(len) * MIN;
    const ceilingMs = pictureStageWallClockCeilingMs(len);
    const hardMs = maxPipelineWallClockHardMin(len) * MIN;
    expect(ceilingMs).toBe(hardMs - Math.max(9 * MIN, Math.round(hardMs * 0.2)));
    expect(ceilingMs).toBeGreaterThanOrEqual(maxPipelineWallClockMin(len) * MIN);
    expect(pipelineEmergencyFinishMs(len)).toBeLessThanOrEqual(ceilingMs);
    expect(ceilingMs).toBeGreaterThanOrEqual(visualMs);
    expect(hardMs).toBeGreaterThan(ceilingMs);
    /** the grace kept for compose, gate and upload */
    expect(hardMs - ceilingMs).toBeGreaterThanOrEqual(9 * MIN);
    expect(Number.isFinite(pipelineProgressStallThresholdMs(len, "generating_visuals"))).toBe(true);
  });
});

describe("3. force-export is a landing flag: it is read once, to skip polish", () => {
  it("the flag is set in one place and read in one place — the polish log — nowhere in sourcing", () => {
    expect(PIPE.match(/forceExportMode/g)).toHaveLength(4);
    expect(PIPE).toContain("if (visualDedup.forceExportMode) {");
    expect(PIPE).toContain("Force-export — skipping polish");
  });

  it("the force-export clock no longer caps the deadline, the picture editor or the rescue", () => {
    expect(PIPE.match(/pipelineEmergencyFinishMs\(/g)).toHaveLength(2);
    expect(PIPE).toContain("const pictureStageCeilingAtMs = pipelineWallStartMs + pictureStageWallClockCeilingMs(videoLength);");
    expect(PIPE).toContain("Math.min(visualStageTimeoutMs(videoLength, perf), Math.max(JUDGED_BEAT_TURN_MS, pictureStageLeftMs()))");
    expect(PIPE).toContain("ceilingLeftMs: pictureStageLeftMs(),");
    expect(PIPE).toContain("        pictureStageLeftMs(),\n        judgeBaseMs");
    const POLICY = stripComments(fs.readFileSync(path.join(__dirname, "sourcingPolicy.ts"), "utf8"));
    expect(POLICY).toContain("export function pictureStageWallClockCeilingMs(");
    expect(POLICY).toContain("export const PICTURE_STAGE_RENDER_RESERVE_MIN_MS = 9 * 60_000;");
  });
});

describe("4. a provider that never answers leaves the render finite", () => {
  it("every picture scope is a bounded window: the deadline, the rescue and each provider call", async () => {
    for (const { len, videoSec } of SCENARIOS) {
      const r = lateRender(len, { videoSec });
      const w = emptySceneRescueWindowMs({ deadlineLeftMs: r.deadlineLeftMs, sentencesPerEmptyScene: Array(30).fill(9), sceneParallelism: 1, ceilingLeftMs: r.ceilingLeftMs });
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeLessThanOrEqual(Math.max(EMPTY_SCENE_RESCUE_MIN_MS, r.ceilingLeftMs));
    }
    await expect(withSceneFetchTimeout(() => new Promise<never>(() => {}), 40, "video 647 silent provider")).rejects.toThrow(/Timeout: video 647 silent provider exceeded/);
    expect(youtubeDownloadTimeoutMs()).toBe(180_000);
    expect(PIPE).toContain("const YOUTUBE_SEARCH_TIMEOUT_MS = 12_000;");
    expect(PIPE).toContain("const VISUAL_PROVIDER_FAILURE_STREAK_TRIP = 3;");
    expect(PIPE).toContain("const YOUTUBE_COOLDOWN_MS = 3 * 60_000;");
  });

  it("past the ceiling the old floor holds, so a late rescue is still one bounded minute", () => {
    const w = emptySceneRescueWindowMs({ deadlineLeftMs: -1, sentencesPerEmptyScene: [6], sceneParallelism: 3, ceilingLeftMs: -5 * MIN });
    expect(w).toBe(EMPTY_SCENE_RESCUE_MIN_MS);
    expect(YOUTUBE_FIRST_TURN_MS).toBe(JUDGED_BEAT_TURN_MS);
  });
});
