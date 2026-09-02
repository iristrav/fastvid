/**
 * RENDER 564 — THE CUTOVER, FINISHED.
 *
 * ── What 564 proved ─────────────────────────────────────────────────────────────────────────
 *
 * The cinematic route was chosen, the plan was validated and stored, and a render job was queued
 * 27 milliseconds before the pipeline announced the video was COMPLETE. The job then ran, failed
 * with `ASSET_NOT_REHYDRATABLE`, and the file the viewer downloaded was the compose montage — as it
 * would have been even if the job had succeeded, because a render job publishes to
 * `editedVideoUrl` and the dashboard reads `videoUrl`.
 *
 * Two separate defects, both invisible from the log line that said `route=cinematic_timeline`:
 *
 *   1. the job re-fetched assets this process already held, and one re-fetch failed;
 *   2. nothing connected the job's output to the file a person receives.
 *
 * This file guards the pieces of the repair that are pure enough to be checked directly, plus the
 * wiring in `videoPipeline.ts` that no unit test can reach — a 41-thousand-line function with a
 * database, ffmpeg and a queue in it. A source-level assertion is a weak test and it is not
 * pretending otherwise; it exists because the alternative for those three lines is nothing at all,
 * and every one of them is a line whose deletion would silently restore the 564 behaviour.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { beatIdFor, beatIndexFromBeatId, localFilesForTimelineClips } from "./cinematicPipelineInputs";

/* ═══════════════════════ the beat id, both ways ═══════════════════════ */

describe("a beat id can be read back as the numbers that made it", () => {
  it("round-trips every position it is minted for", () => {
    for (const [sceneIndex, beatIndex] of [[0, 0], [1, 4], [12, 37], [0, 2005]] as const) {
      expect(beatIndexFromBeatId(beatIdFor(sceneIndex, beatIndex))).toEqual({ sceneIndex, beatIndex });
    }
  });

  it("surrounding whitespace does not change what it means", () => {
    expect(beatIndexFromBeatId("  s3b1  ")).toEqual({ sceneIndex: 3, beatIndex: 1 });
  });

  /**
   * The refusals matter more than the successes.
   *
   * A parser that answered `{sceneIndex: 0, beatIndex: 0}` for anything it did not understand would
   * file every unrecognised beat's clip under scene 0, beat 0 — which is precisely the class of bug
   * (a verdict recorded under the wrong beat) this system has already been bitten by. Null is the
   * only honest answer to an id that did not come from `beatIdFor`.
   */
  it("refuses anything that did not come from beatIdFor, rather than guessing zero", () => {
    for (const bad of ["", "s3", "b1", "sb", "scene3beat1", "s3b", "sxb1", "s3b1x", "xs3b1", "s-1b2", "s3.0b1"]) {
      expect(beatIndexFromBeatId(bad), bad).toBeNull();
    }
  });
});

/* ═══════════════════════ the files this process already holds ═══════════════════════ */

describe("the clips a render already downloaded are addressed by clip id", () => {
  const clip = (id: string, sceneIndex?: number, beatIndex?: number) => ({ id, sceneIndex, beatIndex });

  it("pairs each clip with the file its own beat used", () => {
    const files = new Map([["0:0", "/w/a.mp4"], ["0:1", "/w/b.mp4"], ["1:0", "/w/c.mp4"]]);
    const got = localFilesForTimelineClips({
      clips: [clip("vc_a", 0, 0), clip("vc_b", 0, 1), clip("vc_c", 1, 0)],
      localPathFor: (s, b) => files.get(`${s}:${b}`) ?? null,
    });
    expect(Object.fromEntries(got)).toEqual({
      vc_a: "/w/a.mp4",
      vc_b: "/w/b.mp4",
      vc_c: "/w/c.mp4",
    });
  });

  /**
   * Scene 1 beat 0 and scene 0 beat 0 are different beats. A key built from the beat alone would
   * collide across scenes and hand a scene its neighbour's picture.
   */
  it("the same beat number in two scenes is two different beats", () => {
    const got = localFilesForTimelineClips({
      clips: [clip("vc_s0", 0, 0), clip("vc_s1", 1, 0)],
      localPathFor: (s, b) => (s === 0 && b === 0 ? "/w/scene0.mp4" : "/w/scene1.mp4"),
    });
    expect(got.get("vc_s0")).toBe("/w/scene0.mp4");
    expect(got.get("vc_s1")).toBe("/w/scene1.mp4");
  });

  it("a clip with no beat is left out rather than paired with a guess", () => {
    const got = localFilesForTimelineClips({
      clips: [clip("no_beat", 0, undefined), clip("no_scene", undefined, 0), clip("neither")],
      localPathFor: () => "/w/would-be-wrong.mp4",
    });
    expect(got.size).toBe(0);
  });

  it("a beat the render used no file for contributes nothing", () => {
    const got = localFilesForTimelineClips({
      clips: [clip("vc_a", 0, 0), clip("vc_b", 0, 1)],
      localPathFor: (_s, b) => (b === 0 ? "/w/a.mp4" : null),
    });
    expect(Object.fromEntries(got)).toEqual({ vc_a: "/w/a.mp4" });
  });

  /**
   * Two clips cut from the same beat share that beat's file. That is correct rather than a
   * collision: they are two moments of one piece of footage, and the renderer trims each itself.
   */
  it("two clips on one beat both get that beat's file", () => {
    const got = localFilesForTimelineClips({
      clips: [clip("vc_first", 2, 3), clip("vc_second", 2, 3)],
      localPathFor: () => "/w/shared.mp4",
    });
    expect(got.get("vc_first")).toBe("/w/shared.mp4");
    expect(got.get("vc_second")).toBe("/w/shared.mp4");
  });

  it("an empty plan asks for nothing", () => {
    expect(localFilesForTimelineClips({ clips: [], localPathFor: () => "/w/x.mp4" }).size).toBe(0);
  });
});

/* ═══════════════════════ the three lines no unit test can reach ═══════════════════════ */

describe("the delivered file is wired to the cinematic render", () => {
  const pipeline = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  /**
   * The single most important line in this round.
   *
   * Before it, `updateVideoStatus(..., { videoUrl: url })` wrote the compose montage no matter what
   * the cinematic route had produced. Someone restoring that literal `url` would put render 564's
   * behaviour back with no test anywhere going red.
   */
  it("the row is written with the delivered file, not the compose intermediate", () => {
    expect(pipeline).toContain("const deliveredUrl = cinematicDeliveredUrl ?? url;");
    expect(pipeline).toContain("videoUrl: deliveredUrl,");
    expect(pipeline).not.toContain("videoUrl: url,");
  });

  it("the pipeline returns what it delivered, so the row and the caller cannot disagree", () => {
    expect(pipeline).toContain("return deliveredUrl;");
  });

  it("the render job is handed the clips this process already holds", () => {
    expect(pipeline).toContain("localFilesForTimelineClips");
    expect(pipeline).toContain("existingByClipId,");
  });

  /**
   * The claim is what keeps two ffmpeg runs off one queue row. Without it the poll loop and the
   * pipeline can both take the same job.
   */
  it("the job is claimed before it is rendered in-process", () => {
    expect(pipeline).toContain("claimQueuedRenderJob");
    const claimAt = pipeline.indexOf("claimQueuedRenderJob(cutover.renderJobId)");
    const runAt = pipeline.indexOf("runRenderJob({");
    expect(claimAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(claimAt);
  });

  /**
   * "Geen stille terugval." A compose delivery must always carry the renderer's own reason for why
   * the cinematic file is not the one being shipped.
   */
  it("a compose delivery states why, every time", () => {
    expect(pipeline).toContain("cinematicRefusal");
    expect(pipeline).toContain("the delivered file is the compose montage");
  });

  it("the route line reports what was DELIVERED, not what was queued", () => {
    expect(pipeline).toContain('route: cinematicDeliveredUrl ? "cinematic_timeline" : "legacy_compose"');
  });

  /**
   * The in-process render is invisible to the watchdog.
   *
   * `timelineRenderer` spawns ffmpeg through its own exec and never calls `trackChild`, so while
   * the cinematic render runs the pipeline looks idle to the watchdog's total-budget check. A kill
   * there fires `throwIfVideoGenerationCancelled` and fails a video whose compose file was already
   * uploaded and fine. Without the heartbeat this round would trade one production failure for
   * another.
   */
  it("the watchdog is told the cinematic render is not a hang", () => {
    expect(pipeline).toContain("get_activeWatchdog()?.ping(");
    expect(pipeline).toContain("clearInterval(heartbeat)");
  });

  /**
   * And the vouching is bounded. A heartbeat with no deadline would switch the watchdog off for
   * however long the render took, which is the protection it exists to give.
   */
  it("the heartbeat stops at a deadline, so a stuck render is still caught", () => {
    expect(pipeline).toContain("inProcessCinematicRenderBudgetMs()");
    expect(pipeline).toContain("if (Date.now() - renderStartedAt > renderDeadlineMs) return;");
  });
});

describe("the in-process render budget", () => {
  it("defaults to twenty minutes and is capped, whatever the environment says", async () => {
    const { inProcessCinematicRenderBudgetMs } = await import("./cinematicProduction");
    const original = process.env.CINEMATIC_INPROCESS_RENDER_BUDGET_MS;
    try {
      delete process.env.CINEMATIC_INPROCESS_RENDER_BUDGET_MS;
      expect(inProcessCinematicRenderBudgetMs()).toBe(20 * 60_000);

      process.env.CINEMATIC_INPROCESS_RENDER_BUDGET_MS = "300000";
      expect(inProcessCinematicRenderBudgetMs()).toBe(300_000);

      // A nonsense value is not honoured, and neither is one that would disable the watchdog for
      // the rest of the day.
      for (const bad of ["", "nonsense", "0", "-1"]) {
        process.env.CINEMATIC_INPROCESS_RENDER_BUDGET_MS = bad;
        expect(inProcessCinematicRenderBudgetMs(), bad).toBe(20 * 60_000);
      }
      process.env.CINEMATIC_INPROCESS_RENDER_BUDGET_MS = "999999999";
      expect(inProcessCinematicRenderBudgetMs()).toBe(60 * 60_000);
    } finally {
      if (original === undefined) delete process.env.CINEMATIC_INPROCESS_RENDER_BUDGET_MS;
      else process.env.CINEMATIC_INPROCESS_RENDER_BUDGET_MS = original;
    }
  });
});
