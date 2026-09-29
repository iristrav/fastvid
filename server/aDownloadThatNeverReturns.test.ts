/**
 * ONE DOWNLOAD OUT OF 263 NEVER CAME BACK, AND IT COST TWENTY-FIVE MINUTES OF A 96-SECOND BUDGET.
 *
 * ── The measurement ─────────────────────────────────────────────────────────────────────────
 *
 *     [WorkerHeartbeat] downloadAndTrim s0b1 src=loc (601s)
 *     [WorkerHeartbeat] downloadAndTrim s0b1 src=loc (606s)
 *     ...
 *     [WorkerHeartbeat] downloadAndTrim s0b1 src=loc (1506s)
 *
 * Every five seconds, counting upward, still counting when the log ended. The fetch it was waiting
 * on carried `AbortSignal.timeout(22_000)`. Across every render log in this repo that abort worked
 * 262 times out of 263 — and this is the one where it did not.
 *
 * ── Why a total clock, rather than fixing the 22-second one ─────────────────────────────────
 *
 * WHY the inner abort did not fire is not established, and this bound does not depend on knowing.
 * A guard that only holds when the guard beneath it holds is not a backstop. The inner abort stays
 * exactly as it was and still fires first in every ordinary case.
 *
 * ── Why 45 seconds ──────────────────────────────────────────────────────────────────────────
 *
 * 130 pool downloads that completed, across every source the pipeline uses:
 *
 *     median 2.2s · p90 4.3s · p99 8.0s · slowest that EVER succeeded 11.4s
 *
 * And per sub-step: fetch max 4.4s, ffprobe max 3.2s, trim max 7.6s. There is nothing in between
 * to protect — of 536 in-flight durations measured, 403 were past ten minutes and nine were under
 * fifteen seconds. A cap of 30s, 45s, 60s or 120s each cut ZERO of the 130 completed downloads.
 *
 * 45s is four times the slowest success ever recorded and under half the retrieval budget, so one
 * stuck transfer can no longer eat the turn every other source — YouTube included — was waiting
 * for. The Library of Congress proves this is a per-attempt accident and not a slow source: the
 * same `loc` that hung for 25 minutes has a median of 2.8s and has never exceeded 11.4s.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { downloadStallTimeoutMs, poolDownloadTotalTimeoutMs } from "./sourcingPolicy";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** The body of `downloadAndTrimPoolCandidate`, where the clock is armed and read. */
const attempt = (): string => {
  const at = PIPE.indexOf("export async function downloadAndTrimPoolCandidate(");
  expect(at, "the pool download is gone").toBeGreaterThan(0);
  return PIPE.slice(at, PIPE.indexOf("\n}\n", at));
};

describe("2. it is a TOTAL clock, and the idle timeout is left alone", () => {
  /**
   * The idle timeout answers "has this stopped delivering". Its own comment argues, correctly, that
   * turning it into a total cap would break a legitimately large download. The two coexist: this
   * round adds an instrument, it does not repurpose one.
   */
  it("the stall timeout is unchanged at 30s", () => {
    expect(downloadStallTimeoutMs()).toBe(30_000);
  });
});
