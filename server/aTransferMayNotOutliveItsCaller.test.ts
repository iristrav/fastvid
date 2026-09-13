import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  youtubeDownloadTimeoutMs,
  YOUTUBE_DOWNLOAD_TIMEOUT_FLOOR_MS,
} from "./sourcingPolicy";

/**
 * A TRANSFER MAY NOT BE GIVEN MORE TIME THAN THE CALLER WILL WAIT.
 *
 * ── What render 579 measured ────────────────────────────────────────────────────────────────
 *
 * Twenty-three YouTube downloads failed, every one with `reason=download_timeout`. Five of them
 * then filed a SUCCESS for the same asset:
 *
 *     FOUND               OK
 *     DOWNLOAD_STARTED    OK
 *     DOWNLOAD_FAILED     FAILED   reason=download_timeout
 *     DOWNLOAD_SUCCEEDED  OK          ← after its own timeout
 *
 * A transfer cannot succeed after its own abort. So the abort that fired was not the download's.
 *
 * ── The contradiction ───────────────────────────────────────────────────────────────────────
 *
 *     youtubeDownloadTimeoutMs()        180 000 ms
 *     youtubeBeatFetchTimeoutMs()        22 000 / 55 000 / 80 000 ms on Railway
 *
 * The inner operation was handed three minutes by a caller who would wait at most twenty-two
 * seconds. The wrapper fired first and filed `download_timeout`; the fetch was never actually
 * cancelled, ran to completion, and wrote a success into a ledger nobody was reading. The clip
 * landed on disk and no beat could ever use it.
 *
 * ── Why this is not "raise the budget" ──────────────────────────────────────────────────────
 *
 * It LOWERS the inner ceiling. Nothing is raised: the 180 s default, the env override and its
 * 30 s/600 s bounds are untouched, and a caller that passes no cap gets exactly what it got
 * before. The gain is a transfer that gives up while the beat can still try another candidate,
 * instead of spending the whole beat discovering that this one could never finish in time.
 */

describe("the download timeout answers to the caller's budget", () => {
  it("WITHOUT A CAP IT IS EXACTLY WHAT IT WAS", () => {
    /** The compatibility guarantee: rehydration and the runtime tool are untouched. */
    expect(youtubeDownloadTimeoutMs()).toBe(180_000);
    expect(youtubeDownloadTimeoutMs(undefined)).toBe(180_000);
  });

  it("A SHORTER CALLER BUDGET WINS — 22s on Railway, not 180s", () => {
    expect(youtubeDownloadTimeoutMs(22_000)).toBe(22_000);
    expect(youtubeDownloadTimeoutMs(55_000)).toBe(55_000);
    expect(youtubeDownloadTimeoutMs(80_000)).toBe(80_000);
  });

  it("and a LONGER caller budget does not raise it — the ceiling still binds", () => {
    /**
     * The direction that matters. A cap may only ever tighten; a caller willing to wait ten
     * minutes must not thereby grant the transfer ten minutes.
     */
    expect(youtubeDownloadTimeoutMs(600_000)).toBe(180_000);
    expect(youtubeDownloadTimeoutMs(10_000_000)).toBe(180_000);
  });

  it("a nearly spent budget cannot produce an instant abort", () => {
    /**
     * `AbortSignal.timeout(0)` aborts immediately and would be reported as a transfer failure
     * rather than as the budget exhaustion it actually is — a wrong diagnosis filed under the
     * wrong provider.
     */
    expect(youtubeDownloadTimeoutMs(0)).toBe(YOUTUBE_DOWNLOAD_TIMEOUT_FLOOR_MS);
    expect(youtubeDownloadTimeoutMs(-5_000)).toBe(YOUTUBE_DOWNLOAD_TIMEOUT_FLOOR_MS);
    expect(youtubeDownloadTimeoutMs(1_000)).toBe(YOUTUBE_DOWNLOAD_TIMEOUT_FLOOR_MS);
  });

  it("a nonsense cap is ignored rather than obeyed", () => {
    expect(youtubeDownloadTimeoutMs(Number.NaN)).toBe(180_000);
    expect(youtubeDownloadTimeoutMs(Number.POSITIVE_INFINITY)).toBe(180_000);
  });

  it("the result is always a usable number of milliseconds", () => {
    for (const cap of [undefined, 0, 1, 8_000, 22_000, 180_000, 600_000, Number.NaN]) {
      const ms = youtubeDownloadTimeoutMs(cap as number | undefined);
      expect(Number.isFinite(ms), String(cap)).toBe(true);
      expect(ms, String(cap)).toBeGreaterThanOrEqual(YOUTUBE_DOWNLOAD_TIMEOUT_FLOOR_MS);
      expect(ms, String(cap)).toBeLessThanOrEqual(180_000);
    }
  });
});

describe("the fetcher hands over the budget it is itself held to", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const code = PIPE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("THE DOWNLOAD IS GIVEN THE BEAT WRAPPER'S OWN NUMBER", () => {
    expect(code).toContain("youtubeBeatFetchTimeoutMs(scriptGuided?.fastMode ?? false)");
  });

  it("and the timeout call reads that cap", () => {
    expect(code).toContain("youtubeDownloadTimeoutMs(budgetMs)");
  });

  it("the wrapper's own values are untouched — nothing was widened to make room", () => {
    expect(code).toContain("if (realFootageFirstEnabled()) return IS_RAILWAY ? 55_000 : 70_000;");
    expect(code).toContain("if (fastStockMode) return IS_RAILWAY ? 22_000 : 35_000;");
    expect(code).toContain("return 80_000;");
  });

  it("and the env override keeps its original bounds", () => {
    const POLICY = readFileSync(join(__dirname, "sourcingPolicy.ts"), "utf8");
    expect(POLICY).toContain("if (!isNaN(n) && n >= 30_000 && n <= 600_000) base = n;");
    expect(POLICY).toContain("YOUTUBE_DOWNLOAD_TIMEOUT_MS");
  });
});
