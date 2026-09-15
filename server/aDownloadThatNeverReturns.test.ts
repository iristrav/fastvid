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

describe("1. the cap is the measured one, not a number that looked reasonable", () => {
  it("defaults to 45 seconds", () => {
    expect(poolDownloadTotalTimeoutMs()).toBe(45_000);
  });

  /** Four times the slowest download that has ever completed, so it cuts nothing that works. */
  it("is far above every completed download ever measured", () => {
    expect(poolDownloadTotalTimeoutMs()).toBeGreaterThan(11_400 * 3);
  });

  /** And below half the retrieval budget, so one stuck transfer cannot take the scene. */
  it("is under half the 96-second retrieval budget", () => {
    expect(poolDownloadTotalTimeoutMs()).toBeLessThan(96_000 / 2);
  });

  it("can be retuned without a code change", () => {
    vi.stubEnv("POOL_DOWNLOAD_TOTAL_TIMEOUT_MS", "60000");
    expect(poolDownloadTotalTimeoutMs()).toBe(60_000);
    vi.unstubAllEnvs();
  });

  /**
   * The floor sits above the slowest sub-step ever recorded (trim, 7.6s). Below that the cap would
   * start cutting transfers that were going to arrive — which is the defect, not the fix.
   */
  it("cannot be set low enough to cut a working download", () => {
    for (const bad of ["1", "5000", "14999", "-1", "nonsense"]) {
      vi.stubEnv("POOL_DOWNLOAD_TOTAL_TIMEOUT_MS", bad);
      expect(poolDownloadTotalTimeoutMs(), bad).toBeGreaterThanOrEqual(15_000);
    }
    vi.unstubAllEnvs();
  });

  it("nor absurdly high", () => {
    vi.stubEnv("POOL_DOWNLOAD_TOTAL_TIMEOUT_MS", "9999999");
    expect(poolDownloadTotalTimeoutMs()).toBe(45_000);
    vi.unstubAllEnvs();
  });
});

describe("2. it is a TOTAL clock, and the idle timeout is left alone", () => {
  /**
   * The idle timeout answers "has this stopped delivering". Its own comment argues, correctly, that
   * turning it into a total cap would break a legitimately large download. The two coexist: this
   * round adds an instrument, it does not repurpose one.
   */
  it("the stall timeout is unchanged at 30s", () => {
    expect(downloadStallTimeoutMs()).toBe(30_000);
  });

  it("and they are different numbers, measuring different things", () => {
    expect(poolDownloadTotalTimeoutMs()).not.toBe(downloadStallTimeoutMs());
  });
});

describe("3. firing it actually cancels, rather than abandoning the transfer", () => {
  /**
   * `fetchWithTimeout`'s own comment records what orphaned downloads cost this pipeline: a detached
   * fetch outliving its render and crashing on ENOENT when the workDir it was writing into had
   * already been deleted. A clock that only stops WAITING would reproduce exactly that.
   */
  it("the clock's signal is threaded into the fetch", () => {
    const body = attempt();
    expect(body).toContain("const totalClock = new AbortController()");
    expect(body).toMatch(/AbortSignal\.any\(\[AbortSignal\.timeout\(22_000\), totalClock\.signal\]\)/);
  });

  /** The inner abort is the first line of defence and keeps its own budget. */
  it("the 22-second abort is still there, first", () => {
    expect(attempt()).toContain("AbortSignal.timeout(22_000)");
  });

  /**
   * ffprobe and ffmpeg are child processes; an AbortSignal does not reach them. So the steps after
   * the transfer are CHECKED rather than raced — otherwise a clock that fired mid-download would
   * still be followed by a trim nobody bounded.
   */
  it("the steps a signal cannot interrupt are checked instead", () => {
    const body = attempt();
    expect(body).toContain('if (outOfTime("ffprobe")) return null;');
    expect(body).toContain('if (outOfTime("trim")) return null;');
  });

  /** A timer left armed on a worker that outlives renders is a leak, and this worker does. */
  it("the timer is cleared in the finally that runs on every exit", () => {
    const body = attempt();
    const fin = body.lastIndexOf("} finally {");
    expect(fin).toBeGreaterThan(0);
    expect(body.slice(fin)).toContain("clearTimeout(totalClockTimer)");
  });
});

describe("4. a render can prove it happened", () => {
  /**
   * The whole reason this defect survived so long is that nothing said it. A beat simply stopped,
   * and the only trace was a heartbeat counting upward that nobody was reading.
   */
  it("abandoning says so, with the source and the elapsed cap", () => {
    const body = attempt();
    expect(body).toContain("ABANDONED src=");
    expect(body).toContain("cancelled so the beat keeps its budget");
  });

  it("and stopping before a later step says which step", () => {
    expect(attempt()).toContain("stopping before ${step}");
  });

  /** Filed as its own outcome, so it can never be confused with a provider that answered badly. */
  it("the outcome is recorded under its own name", () => {
    expect(attempt()).toContain('arrivalFailure = "download_exceeded_total_budget"');
  });
});
