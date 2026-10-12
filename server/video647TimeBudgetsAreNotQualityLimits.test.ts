/**
 * VIDEO 647 — INTERNAL TIME BUDGETS ARE NO LONGER THE REASON A GOOD YOUTUBE PICTURE IS SKIPPED.
 *
 * What render 646 (a 58-second film, 12 sentences, 3 scenes) actually printed:
 *
 *     [Pipeline] video=646 visual deadline 270s (by length 166s)
 *     [Pipeline] Visual stage cap hit chunk 1/1 (2/3 scenes done) — Timeout … exceeded 270s
 *     [SceneFetchScope] SCOPE_EXPIRED label="youtube-first s0 b0" — opened 29s after the budget …
 *     [JudgeBudget] started base=82500ms ceiling=180000ms perLook=7500ms sentencesWithoutPicture=8
 *     [JudgeBudget] granted=172500ms used=172501ms … queued=23 judged=6 FIT=0 stop=JUDGE_BUDGET_EXHAUSTED
 *       notReviewed=[s0b1,s1b0,s1b1,s2b0,s2b1]
 *     [YouTubeDownload] … cloud:DOWNLOAD_TIMEOUT(Timeout: YouTube CC cloud download scene 1 exceeded 18s
 *
 * Three sentences of one scene never got a YouTube turn (the stage deadline, 6 × 45 s, cut the
 * scene), five sentences never got a verdict (a 3-minute judge ceiling that grants 7.5 s per look
 * when a look costs ~29 s), and a download was cut by the seconds left on a scene clock. None of
 * those is a technical safeguard; each is an internal estimate of how long good pictures may take.
 *
 * These tests pin the widened figures AGAINST 646's own numbers, and pin that the technical
 * safeguards — the hard wall-clock fail, the stall guard, provider timeouts and cooldowns, the
 * download floor, the scope-abort mechanics — are still there and still above the picture stage.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  JUDGE_BUDGET_MAX_CEILING_MS,
  JUDGE_BUDGET_MIN_CEILING_MS,
  JUDGE_CEILING_MS_PER_VIDEO_SEC,
  JUDGE_MS_PER_LOOK,
  JUDGE_BASE_SCALE,
  createJudgeBudget,
  judgeBudgetCeilingMs,
} from "./judgeBudget";
import {
  JUDGED_BEAT_TURN_MS,
  PICTURE_SEC_PER_VIDEO_SEC,
  FINAL_LOOK_TURN_MS,
  FINAL_REVIEW_WINDOW_MS,
  YOUTUBE_SEARCH_TIMEOUT_MS,
  YOUTUBE_TURN_WINDOW_MS,
  judgeableVisualDeadlineMs,
  visualDeadlineForVideoMs,
} from "./videoPipeline";
import {
  YOUTUBE_FIRST_TURN_MS,
  YOUTUBE_FIRST_BEAT_WORST_MS,
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

/** Render 646, as the log describes it. */
const R646 = {
  videoSec: 58,
  scenes: 3,
  /** 12 sentences over 3 scenes; the deadline floor reads the LARGEST scene of a chunk. */
  sentencesByChunk: [[6, 4, 2]],
  queuedLooks: 23,
  measuredMsPerLook: 172_500 / 6,
  oldDeadlineMs: 270_000,
  oldJudgeCeilingMs: 180_000,
};

describe("VIDEO 647 — the picture editor's budget is sized on what a look really costs", () => {
  it("a look is granted at least what 646 measured per look (~29 s), not a quarter of it", () => {
    expect(JUDGE_MS_PER_LOOK).toBeGreaterThanOrEqual(Math.floor(R646.measuredMsPerLook));
  });

  it("646's 23 queued looks fit under the ceiling of a 58-second film", () => {
    const base = Math.round((FINAL_REVIEW_WINDOW_MS + FINAL_LOOK_TURN_MS) * JUDGE_BASE_SCALE);
    const ceiling = judgeBudgetCeilingMs(R646.videoSec, Number.POSITIVE_INFINITY, base);
    expect(ceiling).toBeGreaterThanOrEqual(R646.queuedLooks * R646.measuredMsPerLook);
    expect(ceiling).toBeGreaterThan(R646.oldJudgeCeilingMs);
    /** And 646's run itself, replayed: granted for 23 looks, the budget is not spent at 172.5 s. */
    let t = 0;
    const b = createJudgeBudget({ baseMs: base, ceilingMs: ceiling, now: () => t });
    b.grant(R646.queuedLooks);
    t = 172_501;
    expect(b.leftMs()).toBeGreaterThan(0);
  });

  it("the ceiling still follows the film's length and is still bounded", () => {
    expect(JUDGE_BUDGET_MIN_CEILING_MS).toBeGreaterThanOrEqual(900_000);
    expect(JUDGE_BUDGET_MAX_CEILING_MS).toBeGreaterThan(JUDGE_BUDGET_MIN_CEILING_MS);
    expect(JUDGE_CEILING_MS_PER_VIDEO_SEC).toBeGreaterThanOrEqual(15_000);
    expect(judgeBudgetCeilingMs(3_600, Number.POSITIVE_INFINITY, 1)).toBe(JUDGE_BUDGET_MAX_CEILING_MS);
    /** Never past the render's force-export moment: the time left still caps it. */
    expect(judgeBudgetCeilingMs(600, 120_000, 55_000)).toBe(120_000);
  });
});

describe("VIDEO 647 — the picture stage gives every judged sentence its YouTube turn", () => {
  it("a judged sentence's turn is the whole YouTube-first worst case, so a scene is not cut while its beats still have one", () => {
    expect(JUDGED_BEAT_TURN_MS).toBe(YOUTUBE_FIRST_BEAT_WORST_MS);
    expect(JUDGED_BEAT_TURN_MS).toBeGreaterThan(YOUTUBE_FIRST_TURN_MS);
    expect(FINAL_LOOK_TURN_MS).toBe(JUDGED_BEAT_TURN_MS);
  });

  it("646's shape gets more than 270 s, and the one-minute caps let that through", () => {
    const byLength = visualDeadlineForVideoMs(35_000 * R646.scenes, R646.videoSec);
    expect(byLength).toBeCloseTo(R646.videoSec * PICTURE_SEC_PER_VIDEO_SEC * 1000, -2);
    const cap = Math.min(visualStageWallClockMin("1") * 60_000, pictureStageWallClockCeilingMs("1"));
    const deadline = judgeableVisualDeadlineMs(byLength, R646.sentencesByChunk, cap);
    expect(deadline).toBeGreaterThanOrEqual(6 * YOUTUBE_FIRST_TURN_MS);
    expect(deadline).toBeGreaterThan(R646.oldDeadlineMs * 2);
    expect(cap).toBeGreaterThanOrEqual(6 * YOUTUBE_FIRST_TURN_MS);
  });

  it("a one-minute film has 16 min of pictures inside a 30 min target; longer films keep their own rule", () => {
    expect(maxPipelineWallClockMin("1")).toBe(30);
    expect(visualStageWallClockMin("1")).toBe(16);
    expect(maxPipelineWallClockMin("3")).toBe(30);
    expect(visualStageWallClockMin("3")).toBe(24);
  });

  it("a beat waits up to 3 min for the video's YouTube pool, still inside its own scope", () => {
    expect(PIPE).toContain("Math.min(180_000, remainingScopeMs() - YOUTUBE_MIN_DOWNLOAD_WINDOW_MS)");
    expect(PIPE).not.toContain("Math.min(90_000, remainingScopeMs()");
  });
});

describe("VIDEO 647 — the technical safeguards stay, and stay above the picture stage", () => {
  it.each(["1", "3", "5", "8-10"])("length %s: the picture cap holds six YouTube turns and stays under the hard wall-clock fail", (len) => {
    const visualMs = visualStageWallClockMin(len) * 60_000;
    const ceilingMs = pictureStageWallClockCeilingMs(len);
    const hardMs = maxPipelineWallClockHardMin(len) * 60_000;
    /** The cap the pipeline hands the picture stage: the smaller of the two (VIDEO 647: the ceiling, not force-export). */
    const capMs = Math.min(visualMs, ceilingMs);
    expect(capMs).toBeGreaterThanOrEqual(6 * YOUTUBE_FIRST_TURN_MS);
    expect(hardMs).toBeGreaterThan(visualMs);
    expect(hardMs).toBeGreaterThan(ceilingMs);
    expect(Number.isFinite(hardMs)).toBe(true);
  });

  it("the one-minute force-export comes after its picture stage, the picture ceiling after that, and the hard fail after all", () => {
    expect(pipelineEmergencyFinishMs("1")).toBe(18 * 60_000);
    expect(pipelineEmergencyFinishMs("1")).toBeGreaterThan(visualStageWallClockMin("1") * 60_000);
    expect(pictureStageWallClockCeilingMs("1")).toBe(30 * 60_000);
    expect(maxPipelineWallClockHardMin("1")).toBe(39);
    expect(pipelineProgressStallThresholdMs("1", "generating_visuals")).toBe(45 * 60_000);
    expect(pipelineProgressStallThresholdMs("1", "generating_visuals")).toBeGreaterThan(visualStageWallClockMin("1") * 60_000);
  });

  it("provider timeouts, the transfer floor and the download timeout are unchanged", () => {
    expect(YOUTUBE_SEARCH_TIMEOUT_MS).toBe(12_000);
    expect(YOUTUBE_TURN_WINDOW_MS).toBe(YOUTUBE_SEARCH_TIMEOUT_MS + 24_000);
    expect(YOUTUBE_FIRST_BEAT_WORST_MS).toBe(YOUTUBE_FIRST_TURN_MS + 60_000);
    expect(youtubeDownloadTimeoutMs()).toBe(180_000);
    expect(PIPE).toContain("const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = 12_000;");
    expect(PIPE).toContain("const YOUTUBE_COOLDOWN_MS = 3 * 60_000;");
    /** The scope mechanics: a scope past its deadline is still refused, aborts still carry their flag. */
    expect(PIPE).toContain("if (deadlineAtMs <= openedAtMs) {");
    expect(PIPE).toContain("function scopeAbortError(");
    expect(PIPE).toContain("function hardAbortScope(");
  });
});
