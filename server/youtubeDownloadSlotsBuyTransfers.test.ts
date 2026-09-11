import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  claimYoutubeDownloadSlot,
  createSourcingCache,
  releaseYoutubeDownloadSlot,
  providerMetrics,
} from "./videoPipeline";

/**
 * SIXTY SLOTS, SEVENTEEN CLIPS, AND 198 CANDIDATES NEVER ASKED FOR.
 *
 * Render 577, with the download ceiling already raised to 60:
 *
 *     [SourcingMetrics] youtube_cc: downloadOutcomes DOWNLOAD_TIMEOUT=50 DOWNLOAD_SUCCESS=10
 *     [AssetUsageSummary] provider=youtube_cc found=215 downloaded=17 neverFetched=198
 *
 * The ceiling was spent in full. `DOWNLOAD_TIMEOUT` is two events under one name — the status's
 * own doc comment says "its own timeout, OR the scene budget that contains it" — and the second
 * kind returns before a byte moves, having already cost a slot, because `claimDownloadSlot()`
 * runs before the fetcher is called at all.
 *
 * These tests pin the repair and, just as hard, pin the rule it must not break: a transfer that
 * STARTED and then failed keeps its slot. That is render 533's rule and the reason the ceiling
 * holds at all.
 */

const cache = () => createSourcingCache(577);

describe("the ceiling still holds", () => {
  it("counts attempts, not successes, and stops at the ceiling", () => {
    const c = cache();
    for (let i = 0; i < 3; i++) expect(claimYoutubeDownloadSlot(c, 3)).toBe(true);
    expect(claimYoutubeDownloadSlot(c, 3), "the fourth is refused").toBe(false);
    expect(providerMetrics(c, "youtube_cc").downloadSlotsClaimed).toBe(3);
  });

  it("A REFUND CANNOT PUSH THE COUNTER BELOW ZERO", () => {
    // A double refund on one claim would hand the render free budget out of nothing.
    const c = cache();
    expect(claimYoutubeDownloadSlot(c, 5)).toBe(true);
    expect(releaseYoutubeDownloadSlot(c)).toBe(true);
    expect(releaseYoutubeDownloadSlot(c), "nothing left to give back").toBe(false);
    expect(providerMetrics(c, "youtube_cc").downloadSlotsClaimed).toBe(0);
    expect(providerMetrics(c, "youtube_cc").downloadSlotsRefunded).toBe(1);
  });

  it("a returned slot is genuinely usable again", () => {
    const c = cache();
    for (let i = 0; i < 2; i++) claimYoutubeDownloadSlot(c, 2);
    expect(claimYoutubeDownloadSlot(c, 2)).toBe(false);
    releaseYoutubeDownloadSlot(c);
    expect(claimYoutubeDownloadSlot(c, 2), "the returned slot buys a real attempt").toBe(true);
  });

  it("THE REFUND IS COUNTED, NOT HIDDEN", () => {
    /**
     * A ceiling that silently un-spends itself would be unauditable: 60 claimed and 60 spent read
     * identically. `downloadSlotsRefunded` is what lets the next render say how many of its
     * attempts were never attempts.
     */
    const c = cache();
    for (let i = 0; i < 4; i++) claimYoutubeDownloadSlot(c, 10);
    releaseYoutubeDownloadSlot(c);
    releaseYoutubeDownloadSlot(c);
    const m = providerMetrics(c, "youtube_cc");
    expect(m.downloadSlotsClaimed).toBe(2);
    expect(m.downloadSlotsRefunded).toBe(2);
  });
});

describe("what decides a refund", () => {
  const pipeline = () => readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("the condition is `no bytes moved` AND NOTHING ELSE", () => {
    /**
     * The whole safety of this change. `transferStarted === false` is the fetcher's own answer to
     * "did bytes move". A condition on the STATUS instead would refund a real failed transfer the
     * moment a status was reclassified, which is exactly render 533's hole.
     */
    const src = pipeline();
    const at = src.indexOf("if (!ok && dl.transferStarted === false) {");
    expect(at, "the refund is keyed on transferStarted").toBeGreaterThan(0);
    const block = src.slice(at, at + 700);
    expect(block).toContain("releaseYoutubeDownloadSlot(sourcingCache)");
    expect(block, "no status may widen this").not.toContain("DOWNLOAD_TIMEOUT");
    expect(block, "nor a reason string").not.toContain("scene_budget");
  });

  it("a SUCCESSFUL download never refunds", () => {
    // `!ok` is half the condition; without it a success that moved bytes could hand its slot back.
    const src = pipeline();
    const at = src.indexOf("if (!ok && dl.transferStarted === false) {");
    expect(src.slice(at, at + 60)).toContain("!ok &&");
  });

  it("the fetcher reports transferStarted to its caller", () => {
    /**
     * RENDER 571 added `transferStarted` for the replay bundle only; the caller holding the slot
     * could not see it. This is the wire.
     */
    const src = pipeline();
    expect(src).toContain("outcome.transferStarted = transferStarted;");
    expect(src).toContain(
      "outcome?: { status?: YoutubeDownloadStatus; reason?: string; transferStarted?: boolean }"
    );
  });

  it("the slot is still claimed BEFORE the download, not after", () => {
    /**
     * RONDE 69: the check and the increment must sit in one event-loop turn with nothing awaited
     * between them, or the ceiling does not hold. The refund is a separate, later decision and
     * must not have moved the claim.
     */
    const src = pipeline();
    const claimAt = src.indexOf("if (!claimDownloadSlot()) {");
    expect(claimAt).toBeGreaterThan(0);
    /** Anchored AFTER the claim: this fetcher is called from more than one route. */
    const downloadAt = src.indexOf("const ok = await downloadYouTubeCCClip(", claimAt);
    const refundAt = src.indexOf("if (!ok && dl.transferStarted === false) {", claimAt);
    expect(downloadAt).toBeGreaterThan(claimAt);
    expect(refundAt).toBeGreaterThan(downloadAt);
  });

  it("a video already refused for good still costs no slot at all", () => {
    // RONDE 223's memo runs BEFORE the claim. The refund must not have made it redundant or moved it.
    const src = pipeline();
    const memoAt = src.indexOf("const alreadyRefused = youtubeDownloadRefusal(videoId);");
    const claimAt = src.indexOf("if (!claimDownloadSlot()) {");
    expect(memoAt).toBeGreaterThan(0);
    expect(claimAt).toBeGreaterThan(memoAt);
  });
});

describe("the render says how much of its ceiling bought a transfer", () => {
  it("spent and returned are reported side by side", () => {
    const src = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    expect(src).toContain("downloadSlots spent=");
    expect(src).toContain("returned=${m.downloadSlotsRefunded}");
  });

  it("the outcome histogram is left exactly as it was", () => {
    /**
     * The refund does not rewrite history: an attempt that stood aside still files its honest
     * status. Changing that line instead of adding a new one would be repairing the metric
     * cosmetically — making the failures look smaller rather than counting the right thing.
     */
    const src = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    expect(src).toContain("`[SourcingMetrics]   ${provider}: downloadOutcomes ` +");
    expect(src).toContain('outcomes.map(([status, n]) => `${status}=${n}`).join(" ")');
  });
});
