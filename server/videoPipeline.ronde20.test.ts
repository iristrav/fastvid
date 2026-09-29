import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one-minute length no longer takes the fast-short path by default — see
 * `isFastShortVideoLength`. That tuning still EXISTS and is what this file asserts, so the flag is
 * set here rather than the expectations being loosened: the behaviour is unchanged, only its
 * default is.
 */
beforeEach(() => { vi.stubEnv("FAST_SHORT_PATH", "true"); });
afterEach(() => { vi.unstubAllEnvs(); });

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

// RONDE 20D (download breakers for GDELT and SepiaSearch) left with those providers: VIDEO 619
// removed the sources that delivered nothing to any film across renders 597–619.
