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
  scenePipelineEnabled,
  visualSourcingTurboMs,
} from "./sourcingPolicy";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** The `if (scenePipelineEnabled())` that splits the two scene paths, and its two halves. */
function branches(): { p5a: string; sequential: string } {
  const start = PIPE.indexOf("if (scenePipelineEnabled()) {");
  expect(start).toBeGreaterThan(0);
  const seqStart = PIPE.indexOf("const chunks = groupScenesIntoChunks(scenes, 60);", start);
  expect(seqStart).toBeGreaterThan(start);
  const seqEnd = PIPE.indexOf("const visualLimit = pLimit(perf.sceneParallelism);", seqStart);
  expect(seqEnd).toBeGreaterThan(seqStart);
  return { p5a: PIPE.slice(start, seqStart), sequential: PIPE.slice(seqStart, seqEnd) };
}

describe("RONDE 172 — both scene paths start the ladder at the visual stage", () => {
  it("the sequential path resets the clock, as FIX 7 made it", () => {
    expect(branches().sequential).toContain("visualDedup.pipelineStartedMs = Date.now();");
  });

  it("the P5A path resets it too — this is the half FIX 7 missed", () => {
    expect(branches().p5a).toContain("visualDedup.pipelineStartedMs = Date.now();");
  });

  it("each path says so, so a log can tell which clock a render was on", () => {
    const { p5a, sequential } = branches();
    expect(p5a).toContain("sourcing-ladder clock started at visual stage (P5A)");
    expect(sequential).toContain("sourcing-ladder clock started at visual stage");
    // Both print the render time already spent, which is exactly the amount that used to be
    // charged to sourcing on the P5A path.
    expect(p5a).toContain("total elapsed so far");
    expect(sequential).toContain("total elapsed so far");
  });

  it("the reset happens BEFORE the heartbeat that can trigger force-export", () => {
    /**
     * The P5A heartbeat calls `ensurePipelineForceExport` every ten seconds. Resetting after it
     * was created would leave the first ticks reading the render clock — the same bug in a smaller
     * window, and a much harder one to see.
     */
    const { p5a } = branches();
    const reset = p5a.indexOf("visualDedup.pipelineStartedMs = Date.now();");
    const heartbeat = p5a.indexOf("const heartbeatP5A = setInterval(");
    expect(reset).toBeGreaterThan(-1);
    expect(heartbeat).toBeGreaterThan(reset);
  });

  it("the render-start initialisation is still there — the reset narrows it, never removes it", () => {
    // A render that somehow reaches a rung before either branch still has a clock rather than a
    // zero, which `isPipelineEmergencyFinish` reads as "not started" and skips.
    expect(PIPE).toContain("visualDedup.pipelineStartedMs = pipelineWallStartMs;");
    expect(PIPE).toContain("if (!dedup.pipelineStartedMs) return false;");
  });
});

describe("RONDE 172 — the ladder itself is untouched", () => {
  it("the three rungs keep their fractions and their order", () => {
    /**
     * turbo < rush < emergency, all against the same clock. Moving the clock without keeping the
     * order would turn a graceful degradation into a cliff.
     */
    for (const length of ["1", "5", "8-10", "10-15"]) {
      const turbo = visualSourcingTurboMs(length);
      const rush = pipelineRushModeMs(length);
      const emergency = pipelineEmergencyFinishMs(length);
      expect(turbo, length).toBeLessThan(rush);
      expect(rush, length).toBeLessThan(emergency);
    }
  });

  it("the fractions are the ones render 555 ran on — no threshold moved", () => {
    const policy = readFileSync(join(__dirname, "sourcingPolicy.ts"), "utf8");
    expect(policy).toContain("const TURBO_FRACTION     = 0.25;");
    expect(policy).toContain("const RUSH_FRACTION      = 0.35;");
    expect(policy).toContain("const EMERGENCY_FRACTION = 0.45;");
  });

  it("force-export still exists, still fires once, and still announces itself", () => {
    expect(PIPE).toContain("function ensurePipelineForceExport(");
    expect(PIPE).toContain("if (!dedup.forceExportMode) {");
    expect(PIPE).toContain("Force-export mode (≥");
  });

  it("which branch runs is still the operator's switch, not something this changed", () => {
    // ENABLE_SCENE_PIPELINE decides; both halves now behave the same about the clock.
    expect(typeof scenePipelineEnabled()).toBe("boolean");
    const policy = readFileSync(join(__dirname, "sourcingPolicy.ts"), "utf8");
    expect(policy).toContain('process.env.ENABLE_SCENE_PIPELINE === "true"');
  });
});
