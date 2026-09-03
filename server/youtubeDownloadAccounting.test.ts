/**
 * WHAT `downloaded=20` MEANT FOR YOUTUBE, AND WHY IT COULD NOT BE READ.
 *
 * ── The question the audit asked ────────────────────────────────────────────────────────────
 *
 * "YouTube: 20 downloaded, 0 adopted — is that legitimate quality rejection, or a pipeline
 * defect?" It is a fair question and, until this, the render report could not answer it. Not
 * because the answer was hidden; because the number in the `downloaded` column was not a count of
 * downloads.
 *
 * ── The two readers of one field ────────────────────────────────────────────────────────────
 *
 * `providerMetrics(cache, provider).downloadCount` had two readers who wanted different numbers:
 *
 *   the CEILING  `claimYoutubeDownloadSlot` bounds YouTube's spend per render. RONDE 69 made it
 *                count ATTEMPTS deliberately — a failed download does not return its slot —
 *                because render 533 spent 134 downloads for nothing and a ceiling that counted
 *                only successes never fired. That rule is correct and is not changed here.
 *
 *   the REPORT   the end-of-render fold in videoPipeline copies this field into
 *                `[AssetUsageSummary]`'s `downloaded` column for any provider that files no
 *                DOWNLOAD_SUCCEEDED events of its own. Every other provider bumps it once bytes
 *                are on disk, so for them the column means what it says.
 *
 * YouTube was the one provider whose ceiling wrote the field the report read. So
 * `provider=youtube_cc downloaded=20` meant twenty slots CLAIMED, and these two renders printed
 * the identical line:
 *
 *   twenty attempts, two files arrived, both refused by the picture editor   → RETRIEVAL problem
 *   twenty attempts, twenty files arrived, all twenty refused                → RELEVANCE problem
 *
 * Different causes, different fixes, one number. Neither reader was wrong; one field was being
 * asked two questions.
 *
 * ── What changed ────────────────────────────────────────────────────────────────────────────
 *
 *   1. the ceiling gets `downloadSlotsClaimed`, so `downloadCount` means arrivals everywhere
 *   2. the YouTube route bumps `downloadCount` when a file actually arrives, like the other routes
 *   3. it files the real DOWNLOAD_SUCCEEDED / DOWNLOAD_FAILED outcome, which it never did — it
 *      opened a DOWNLOAD_STARTED for every candidate and closed none of them, so a YouTube clip
 *      that never arrived left a record reading, forever, as still in flight, and YouTube's
 *      download failures never reached the failure-reason histogram at all
 *
 * ── What this does NOT do ───────────────────────────────────────────────────────────────────
 *
 * It does not answer the audit's question. It makes the question answerable. Whether YouTube's
 * clips are being refused on their merits is a fact about a real render's `[ProviderFunnel]` row,
 * and no source-level test can stand in for one.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { claimYoutubeDownloadSlot, createSourcingCache, providerMetrics } from "./videoPipeline";

const PIPELINE = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════════════ the ceiling keeps its own count ═══════════════════════ */

describe("the ceiling counts what it hands out, not what arrives", () => {
  it("a claimed slot is not an arrived file", () => {
    const cache = createSourcingCache();
    for (let i = 0; i < 4; i++) expect(claimYoutubeDownloadSlot(cache, 4)).toBe(true);

    const m = providerMetrics(cache, "youtube_cc");
    expect(m.downloadSlotsClaimed).toBe(4);
    /**
     * The whole finding, in one assertion. Four slots were handed out and nothing was downloaded,
     * so the number the report reads must still be zero. It used to be four.
     */
    expect(m.downloadCount).toBe(0);
  });

  it("the ceiling still bounds attempts, so a failed transfer does not get a second slot", () => {
    const cache = createSourcingCache();
    expect(claimYoutubeDownloadSlot(cache, 2)).toBe(true);
    expect(claimYoutubeDownloadSlot(cache, 2)).toBe(true);
    // Both "downloads" failed. RONDE 69's rule is unchanged: the slots are spent.
    expect(claimYoutubeDownloadSlot(cache, 2)).toBe(false);
  });

  it("the claim never touches the arrivals counter", () => {
    const src = PIPELINE();
    const at = src.indexOf("export function claimYoutubeDownloadSlot(");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, src.indexOf("\n}", at))).not.toContain("downloadCount");
  });

  it("each render's budget is its own", () => {
    const a = createSourcingCache();
    const b = createSourcingCache();
    for (let i = 0; i < 3; i++) claimYoutubeDownloadSlot(a, 3);
    expect(claimYoutubeDownloadSlot(a, 3)).toBe(false);
    expect(claimYoutubeDownloadSlot(b, 3)).toBe(true);
  });
});

/* ═══════════════════════ the route reports what arrived ═══════════════════════ */

describe("the YouTube route closes the download record it opens", () => {
  /**
   * `tagPathWithProviderAsset` files DOWNLOAD_STARTED for every YouTube candidate. Four other call
   * sites in this file close theirs; this one never did.
   */
  it("files the real outcome through the same helper the other routes use", () => {
    const src = PIPELINE();
    /**
     * Anchored on the ceiling claim, which is unique to this route. `const ok = await
     * downloadYouTubeCCClip(` is not: the funnel's pool route calls the same fetcher, and a window
     * opened there swept up an unrelated `recordProviderDownloadOutcome` several thousand lines
     * later and passed for the wrong reason.
     */
    const at = src.indexOf("if (!claimDownloadSlot()) {");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("results.push(outPath);", at));
    expect(block).toContain("recordProviderDownloadOutcome(");
  });

  /** A failure that is not filed is a record that reads as still in flight for the whole render. */
  it("files the failure too, not only the success", () => {
    const src = PIPELINE();
    const at = src.indexOf("if (!claimDownloadSlot()) {");
    const block = src.slice(at, src.indexOf("results.push(outPath);", at));
    expect(at).toBeGreaterThan(-1);
    expect(block).toContain("youtube_download_failed");
  });

  it("counts an arrival only when one arrived", () => {
    const src = PIPELINE();
    expect(src).toContain('if (ok) providerMetrics(sourcingCache, "youtube_cc").downloadCount++;');
  });

  /**
   * Order matters: the outcome is filed for the file that came back, before the picture editor is
   * allowed to refuse it. A clip refused on what it shows still ARRIVED, and recording it as a
   * failed download would swap a relevance problem for a retrieval one — the exact confusion this
   * whole change exists to end.
   */
  it("a clip the picture editor refuses is still counted as downloaded", () => {
    const src = PIPELINE();
    const at = src.indexOf("if (!claimDownloadSlot()) {");
    const outcome = src.indexOf("recordProviderDownloadOutcome(", at);
    const gate = src.indexOf("youtubeClipPassesImageGate(outPath", at);
    expect(outcome).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(outcome);
  });
});

/* ═══════════════════════ the pool route, which closed nothing at all ═══════════════════════ */

/**
 * The same defect, one layer up and for EVERY provider.
 *
 * `downloadAndTrimPoolCandidate` is the scene-pool retrieval path — the primary one in the
 * cinematic build. It opens a DOWNLOAD_STARTED for every candidate through
 * `tagPathWithProviderAsset` and filed no outcome on any of its exits: not on success, not on the
 * eight refusals, not on a throw. And unlike the direct fetchers it does not bump
 * `providerMetrics.downloadCount` either, so a clip retrieved this way was counted in neither
 * channel and appeared in no column of the render report.
 */
describe("the pool route closes its download records too", () => {
  it("files the outcome where it cannot be forgotten by a future branch", () => {
    const src = PIPELINE();
    const at = src.indexOf("async function downloadAndTrimPoolCandidate(");
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf("\n/** Stable stock trim", at));
    // In the `finally`, alongside the heartbeat clear, which every exit already runs.
    const clear = fn.indexOf("clearWorkerHeartbeat(heartbeatLabel);");
    expect(clear).toBeGreaterThan(-1);
    expect(fn.slice(clear)).toContain("recordProviderDownloadOutcome(");
  });

  /**
   * The distinction the whole change exists for. A file that arrived and was then refused on what
   * it shows is a DOWNLOAD that succeeded; recording it as a failed download would turn a relevance
   * problem into a retrieval one in the report.
   */
  it("success is decided by the byte floor, not by whether the clip was any good", () => {
    const src = PIPELINE();
    const at = src.indexOf("async function downloadAndTrimPoolCandidate(");
    const fn = src.slice(at, src.indexOf("\n/** Stable stock trim", at));
    const floor = fn.indexOf("if (!sizeVerdict.ok) {");
    // Bounded by the trim block that follows, so this asserts the arrival is settled BEFORE
    // anything probes, trims or judges the file — not merely that the line exists somewhere.
    const trim = fn.indexOf("// F3-17: rawPath is a temporary intermediate file", floor);
    expect(floor).toBeGreaterThan(-1);
    expect(trim).toBeGreaterThan(floor);
    expect(fn.slice(floor, trim)).toContain("arrivalFailure = null;");
  });

  it("each refusal files the reason it already logs, rather than a second vocabulary", () => {
    const src = PIPELINE();
    const at = src.indexOf("async function downloadAndTrimPoolCandidate(");
    const fn = src.slice(at, src.indexOf("\n/** Stable stock trim", at));
    for (const reason of ["youtube_fetch_failed", "html_not_media", "below_byte_floor"]) {
      expect(fn, `${reason} is logged but not filed`).toContain(`arrivalFailure = "${reason}"`);
    }
    expect(fn).toContain("arrivalFailure = `http_${resp.status}`;");
  });

  /** A throw from any branch, including one written later, must still close the record. */
  it("starts pessimistic, so an unforeseen exit files a failure rather than nothing", () => {
    const src = PIPELINE();
    const at = src.indexOf("async function downloadAndTrimPoolCandidate(");
    const fn = src.slice(at, src.indexOf("\n/** Stable stock trim", at));
    expect(fn).toContain('let arrivalFailure: string | null = "download_did_not_complete";');
  });
});

/* ═══════════════════════ the fold that reads it ═══════════════════════ */

describe("the end-of-render fold reports arrivals", () => {
  it("still folds the provider counter for routes that report on it", () => {
    const src = PIPELINE();
    expect(src).toContain("ledger.countProviderDownloads(provider, m.downloadCount);");
  });

  /**
   * The fold used to SKIP any provider that filed real DOWNLOAD_SUCCEEDED events, on the reasoning
   * that a route filing events files all of its downloads that way. The pool route ends that: it
   * and the direct fetchers are different retrieval paths that both run in one render, so a
   * provider reports through both channels and choosing one silently drops the other.
   *
   * They are disjoint by construction — the pool route files events and bumps no counter, the
   * direct fetchers bump the counter and file no events — which is what makes adding them right
   * rather than double-counting.
   */
  it("adds the two channels instead of choosing between them", () => {
    const src = PIPELINE();
    expect(src).toContain("if (m.downloadCount <= 0) continue;");
    expect(src).not.toContain("const known = already[provider]?.downloadSucceeded ?? 0;");
  });

  /** Pexels was the one provider on both channels for the same download. Now on events alone. */
  it("no provider reports one download through both channels", () => {
    const src = PIPELINE();
    expect(src).not.toContain('providerMetrics(sourcingCache, "pexels").downloadCount++');
    const at = src.indexOf("downloaded = true; // Success");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 1400)).toContain("recordProviderDownloadOutcome(sourcingCache, outPath, true);");
  });
});
