import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { composeRescueWallClockMs } from "./sourcingPolicy";

// RONDE 20 — render 527 hung outright and then showed "busy" in the app for hours. Three defects,
// each proven by its log line:
//
//   15:23:54  [Pipeline] GDELT clip failed scene 1: Timeout: Archive TV metadata exceeded 12s
//             ...then ZERO activity...                                    ← 20A: unbounded rescue
//   15:45:32  [Watchdog] video=527 KILL — no activity for 1323s
//   15:45:32  [Worker] Unhandled rejection (worker kept alive)             ← 20B: kill was a no-op
//   18:02:28  [VideoQueue] Video 527 exceeded 180min but is still
//             actively progressing — freeing worker slot only             ← 20C: never went terminal
//
// 20A: recoverSceneClipsIfEmpty (compose-time rescue) had no wall-clock bound at all — it loops the
//      full external cascade ~7x per scene. It was both the largest cost (1084s of render 526's 25
//      min) and where 527 hung. Now capped, keeping whatever it already found.
// 20B: killAll only SIGKILLed children (there were none) and rejected a `deadline` promise that
//      NOTHING in the codebase ever consumed — hence the unhandled rejection. It now fires the real
//      cancellation signal and writes the terminal state itself.
// 20D: RONDE 19's breakers only watched SEARCH calls, but 65 GDELT + 43 SepiaSearch timeouts were
//      in the per-clip DOWNLOAD step, which a successful search kept resetting. Separate streaks.

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const watchdogSrc = readFileSync(path.join(__dirname, "renderWatchdog.ts"), "utf8");

describe("RONDE 20A — the compose-time rescue is wall-clock bounded", () => {
  it("exposes a bounded, env-overridable budget", () => {
    expect(composeRescueWallClockMs("8-10")).toBe(240_000);
    expect(composeRescueWallClockMs("1")).toBeLessThan(composeRescueWallClockMs("8-10"));
    // Must always be finite — an unbounded rescue is the bug this round fixes.
    expect(Number.isFinite(composeRescueWallClockMs("8-10"))).toBe(true);
  });

  it("wraps the rescue in withSceneFetchTimeout and keeps partial results", () => {
    const fn = pipelineSrc.slice(
      pipelineSrc.indexOf("export async function recoverSceneClipsIfEmpty("),
      pipelineSrc.indexOf("async function recoverSceneClipsIfEmptyInner("),
    );
    expect(fn).toContain("withSceneFetchTimeout");
    expect(fn).toContain("composeRescueWallClockMs(dedup.videoLength)");
    // On timeout it returns the clips gathered so far rather than discarding them.
    expect(fn).toContain("return { clips, beatDurations };");
  });

  it("hands the wrapper's arrays to the inner so they can be filled in place", () => {
    expect(pipelineSrc).toMatch(
      /recoverSceneClipsIfEmptyInner\(\s*scene,\s*workDir,\s*topicContext,\s*dedup,\s*clips,\s*beatDurations\s*\)/
    );
  });
});

describe("RONDE 20B — a watchdog kill actually ends the render", () => {
  const killAll = watchdogSrc.slice(
    watchdogSrc.indexOf("const killAll ="),
    watchdogSrc.indexOf("const timer = setInterval("),
  );

  it("fires the real cancellation signal, not just a promise nobody awaits", () => {
    expect(killAll).toContain("requestVideoGenerationCancel(numericVideoId)");
  });

  it("writes the terminal state itself so the row can never stay 'generating'", () => {
    expect(killAll).toContain('updateVideoStatus(numericVideoId, "failed"');
    expect(killAll).toContain("Render stopped by watchdog");
  });

  it("never lets the unconsumed deadline surface as an unhandled rejection", () => {
    expect(killAll).toContain("deadline.catch(");
    expect(killAll).toContain("deadlineReject(");
  });

  it("only touches the DB for a resolvable numeric video id", () => {
    expect(killAll).toContain("Number.isFinite(numericVideoId)");
  });
});

describe("RONDE 20D — download-tier breakers (the RONDE 19 gap)", () => {
  it("GDELT counts clip-download failures on their own streak", () => {
    expect(pipelineSrc).toContain("function markGdeltDownloadResult(success: boolean)");
    expect(pipelineSrc).toContain("function isGdeltDownloadInCooldown()");
    expect(pipelineSrc).toContain("markGdeltDownloadResult(false)");
    expect(pipelineSrc).toContain("markGdeltDownloadResult(true)");
  });

  it("SepiaSearch counts download failures on their own streak", () => {
    expect(pipelineSrc).toContain("function markSepiaDownloadResult(success: boolean)");
    expect(pipelineSrc).toContain("function isSepiaDownloadInCooldown()");
    expect(pipelineSrc).toContain("markSepiaDownloadResult(false)");
    expect(pipelineSrc).toContain("markSepiaDownloadResult(true)");
  });

  it("both tiers skip while their download breaker is open", () => {
    expect(pipelineSrc).toContain("isGdeltInCooldown() || isGdeltDownloadInCooldown()");
    expect(pipelineSrc).toContain("isSepiaSearchInCooldown() || isSepiaDownloadInCooldown()");
  });

  it("reuses the shared 3-failure trip from RONDE 19", () => {
    const gdelt = pipelineSrc.slice(
      pipelineSrc.indexOf("function markGdeltDownloadResult"),
      pipelineSrc.indexOf("const sepiaDownloadCooldownMs"),
    );
    expect(gdelt).toContain("VISUAL_PROVIDER_FAILURE_STREAK_TRIP");
  });

  it("the test-reset helper clears the new download breakers too", () => {
    const reset = pipelineSrc.slice(
      pipelineSrc.indexOf("export function __resetProviderCircuitBreakersForTest"),
      pipelineSrc.indexOf("export function __resetProviderCircuitBreakersForTest") + 1800,
    );
    expect(reset).toContain("gdeltDownloadFailureStreak = 0");
    expect(reset).toContain("sepiaDownloadFailureStreak = 0");
  });
});
