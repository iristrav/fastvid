/**
 * RONDE 172 — the degradation ladder's clock started too early on one of the two scene paths.
 *
 * ── Where this came from ─────────────────────────────────────────────────────────────────────
 *
 * Render 555 switched on force-export nine and a half minutes in and refused its research pass for
 * the rest of the render (RONDE 171). The obvious next question is whether the 45% threshold is
 * simply too early. Reading the clock it measures against turned up something more specific.
 *
 * ── The gap ──────────────────────────────────────────────────────────────────────────────────
 *
 * `visualDedup.pipelineStartedMs` is initialised to `pipelineWallStartMs` — the render's own start.
 * RONDE 5 / FIX 7 resets it to the visual stage so the ladder measures SOURCING time, and wrote
 * down why:
 *
 *     "It used to measure from videoRow.generationStartedAt, which meant (a) script + TTS +
 *      archive-pool warm + CLIP prewarm all counted against the sourcing budgets, and (b) a
 *      stall-recovery RETRY inherited the first attempt's clock wholesale — render 517 attempt 2
 *      started with 12s beat budgets 34 seconds in."
 *
 * That reset sits inside the SEQUENTIAL branch. The P5A scene-pipeline branch — the other half of
 * the same `if` — never had one. On that path all three rungs measured render time, so every minute
 * spent on the script, the voice-over, the blueprint and the prewarm came off the sourcing budget.
 *
 * ── What it does and does not claim ──────────────────────────────────────────────────────────
 *
 * This is not offered as render 555's diagnosis: both branch-announcing log lines fall inside the
 * truncated first seven minutes of that log, so which path it took cannot be read from it. It is a
 * hole in the clock that is visible in the code either way, and its direction is one-way — it can
 * only make the ladder fire EARLY, never late.
 *
 * The 25/35/45% fractions are deliberately untouched. One render is not evidence about a threshold
 * that governs every render, and firing later risks the hard wall-clock cap the ladder exists to
 * stay under.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  pipelineEmergencyFinishMs,
  pipelineRushModeMs,
  visualSourcingTurboMs,
} from "./sourcingPolicy";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * RONDE 661 — the P5A scene-pipeline branch (ENABLE_SCENE_PIPELINE, never set in production) was
 * deleted with the old render path. The one scene loop left must still start the clock itself.
 */
function sceneLoop(): string {
  const start = PIPE.indexOf("const chunks = groupScenesIntoChunks(scenes, 60);");
  expect(start).toBeGreaterThan(0);
  const end = PIPE.indexOf("const visualLimit = pLimit(perf.sceneParallelism);", start);
  expect(end).toBeGreaterThan(start);
  return PIPE.slice(start, end + 2000);
}

describe("RONDE 172 — the scene loop starts the ladder at the visual stage", () => {
  it("the scene loop resets the clock, as FIX 7 made it", () => {
    expect(sceneLoop()).toContain("visualDedup.pipelineStartedMs = Date.now();");
  });

  it("the P5A branch and its switch are gone — there is one scene loop", () => {
    expect(PIPE).not.toContain("scenePipelineEnabled");
    expect(PIPE).not.toContain("heartbeatP5A");
  });

  it("it says so, so a log shows when the clock started", () => {
    expect(sceneLoop()).toContain("sourcing-ladder clock started at visual stage");
    expect(sceneLoop()).toContain("total elapsed so far");
  });

  it("the reset happens BEFORE the heartbeat that can trigger force-export", () => {
    const loop = sceneLoop();
    const reset = loop.indexOf("visualDedup.pipelineStartedMs = Date.now();");
    const heartbeat = loop.indexOf("const visualHeartbeat = setInterval(");
    expect(reset).toBeGreaterThan(-1);
    expect(heartbeat).toBeGreaterThan(reset);
    expect(loop.slice(heartbeat)).toContain("ensurePipelineForceExport(visualDedup);");
  });

  it("the render-start initialisation is still there — the reset narrows it, never removes it", () => {
    // A render that somehow reaches a rung before the scene loop still has a clock rather than a
    // zero, which `isPipelineEmergencyFinish` reads as "not started" and skips.
    expect(PIPE).toContain("visualDedup.pipelineStartedMs = pipelineWallStartMs;");
    expect(PIPE).toContain("if (!dedup.pipelineStartedMs) return false;");
  });
});

describe("RONDE 172 — the ladder itself is untouched", () => {

  it("force-export still exists, still fires once, and still announces itself", () => {
    expect(PIPE).toContain("function ensurePipelineForceExport(");
    expect(PIPE).toContain("if (!dedup.forceExportMode) {");
    expect(PIPE).toContain("Force-export mode (≥");
  });
});
