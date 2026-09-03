/**
 * THE TEST LENGTH TESTS THE PRODUCT.
 *
 * ── What a one-minute render used to prove ──────────────────────────────────────────────────
 *
 * Almost nothing. The one-minute length is admin-only and exists to TEST a render, and it selected
 * a different product: seventy-four branches keyed on `isFastShortVideoLength`, and they are not
 * tuning. They change what the film is and what is checked about it —
 *
 *   the content check on the DELIVERED file        skipped
 *   semantic AI reranking of candidates            skipped
 *   the LLM semantic pass                          skipped
 *   the montage                                    a simpler one
 *   fetching during compose                        forbidden; local files only
 *   weak-beat polish                               off
 *   candidates tried per beat                      8 instead of 14
 *   the stock quality floor                        LOWER (7 instead of 8)
 *   the minimum moving-footage target              none at all
 *
 * — so it answered questions about a pipeline nobody ships, and the two most useful answers a test
 * can give (is the delivered file any good, and were the right pictures chosen) were the two it
 * switched off.
 *
 * There was no shorter honest option either. `VIDEO_LENGTH_VALUES` is ["1", "8-10", "10-15",
 * "15-20"], so the choice was a one-minute test on a different architecture, or a ten-minute one.
 *
 * ── What this pins ──────────────────────────────────────────────────────────────────────────
 *
 * That the one-minute length now takes the same path as every other length, by default. The old
 * tuning is kept whole behind `FAST_SHORT_PATH=true` — a rollback for a measured wall-clock
 * timeout, not a second architecture to choose between — and its own tests still cover it, with the
 * flag set.
 *
 * ── What is NOT claimed ─────────────────────────────────────────────────────────────────────
 *
 * That a one-minute render still fits its budget. It gets 20 minutes of wall clock and now does the
 * work a full render does. Twenty minutes for roughly eighteen shots is expected to fit and has NOT
 * been measured — this environment has no credentials and cannot run a render. That is exactly what
 * the escape hatch is for, and why it exists rather than the branches being deleted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveMinVideoClipsTarget,
  composeLocalClipsOnly,
  fastShortPlainComposeEnabled,
  isFastShortVideoLength,
  maxVisualCandidatesPerBeatTry,
  polishBeforeComposeEnabled,
} from "./sourcingPolicy";
import { postRenderSpotCheckEnabledForVideo } from "./postRenderSpotCheck";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("one minute takes the same path as ten", () => {
  it("is not treated as a fast-short length by default", () => {
    expect(isFastShortVideoLength("1")).toBe(false);
    expect(isFastShortVideoLength("8-10")).toBe(false);
  });

  /**
   * The single most important one. A test length that skips the check on the file it produced is
   * not a test — it is a rehearsal with the marking switched off.
   */
  it("the delivered file gets its content check", () => {
    expect(postRenderSpotCheckEnabledForVideo("1")).toBe(true);
    expect(postRenderSpotCheckEnabledForVideo("8-10")).toBe(true);
  });

  it("gets the full montage, and may fetch while composing", () => {
    expect(fastShortPlainComposeEnabled("1")).toBe(false);
    expect(composeLocalClipsOnly("1")).toBe(false);
  });

  it("gets the same candidate depth per beat", () => {
    expect(maxVisualCandidatesPerBeatTry("1")).toBe(maxVisualCandidatesPerBeatTry("8-10"));
  });

  it("gets a minimum moving-footage target, like every other length", () => {
    expect(archiveMinVideoClipsTarget("1")).toBeGreaterThan(0);
  });

  it("gets the weak-beat polish", () => {
    expect(polishBeforeComposeEnabled("1")).toBe(polishBeforeComposeEnabled("8-10"));
  });
});

describe("the old tuning is kept, not deleted", () => {
  /**
   * Every branch above still exists and still does what it did. Deleting them would throw away real
   * tuning and leave no way back from a wall-clock timeout nobody here can measure.
   */
  it("FAST_SHORT_PATH=true restores the fast-short behaviour", () => {
    vi.stubEnv("FAST_SHORT_PATH", "true");
    expect(isFastShortVideoLength("1")).toBe(true);
    expect(fastShortPlainComposeEnabled("1")).toBe(true);
    expect(composeLocalClipsOnly("1")).toBe(true);
    expect(postRenderSpotCheckEnabledForVideo("1")).toBe(false);
    expect(archiveMinVideoClipsTarget("1")).toBe(0);
  });

  /** And it never reaches the lengths it was never about. */
  it("the flag does not change any other length", () => {
    vi.stubEnv("FAST_SHORT_PATH", "true");
    expect(isFastShortVideoLength("8-10")).toBe(false);
    expect(isFastShortVideoLength("10-15")).toBe(false);
    expect(isFastShortVideoLength("15-20")).toBe(false);
  });

  /** Only the exact word turns it on — a stray value must not silently restore the old product. */
  it("anything but true leaves the unified path in place", () => {
    for (const v of ["", "false", "1", "yes", "TRUE "]) {
      vi.stubEnv("FAST_SHORT_PATH", v);
      expect(isFastShortVideoLength("1"), `FAST_SHORT_PATH=${JSON.stringify(v)}`).toBe(
        v.trim().toLowerCase() === "true"
      );
    }
  });
});
