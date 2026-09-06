/**
 * RONDE 115 — WHY DID SEVENTEEN YOUTUBE DOWNLOADS FAIL? RENDER 572 COULD NOT SAY.
 *
 * ── The measurement ─────────────────────────────────────────────────────────────────────────
 *
 *     [VisualFunnel] youtube_cc retrieved=343 downloadStarted=17 downloadSucceeded=0
 *     failureReasons: other=17
 *
 * Seventeen attempts, zero arrivals, and one bucket named `other`. The status was known at the
 * time — `summariseYoutubeDownloadAttempts` picks one of seven, and `[YouTubeDownload]` logs it —
 * but the cascade handed the ledger the single string `youtube_download_failed`, which
 * `normalizeFailureReason` has no branch for. So a render whose YouTube ingest is simply not
 * CONFIGURED (`DOWNLOAD_UNAVAILABLE`) and one whose transfers all died (`DOWNLOAD_FAILED`) print
 * the identical line, and only the second is a bug.
 *
 * ── What this file guards ───────────────────────────────────────────────────────────────────
 *
 * That the status the fetcher decided survives to the histogram. Nothing about downloading
 * changes: no timeout is raised, no budget widened, no route added. The seventeen would still
 * fail — the next render just says which of the seven ways.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  createSourcingCache,
  normalizeFailureReason,
  recordProviderDownloadOutcome,
  tagPathWithProviderAsset,
} from "./videoPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * The seven, read from the type itself rather than copied.
 *
 * A copy would pass forever after an eighth status is added and left unmapped — which is exactly
 * the shape of the bug this round is fixing.
 */
const YOUTUBE_DOWNLOAD_STATUSES: string[] = (() => {
  const at = PIPE.indexOf("export type YoutubeDownloadStatus =");
  const decl = PIPE.slice(at, PIPE.indexOf(";", PIPE.indexOf('"DOWNLOAD_FAILED"', at)));
  return [...new Set([...decl.matchAll(/"(DOWNLOAD_[A-Z_]+)"/g)].map((m) => m[1]!))];
})();

/* ═══════════════ the seven statuses stay seven ═══════════════ */

describe("a decided download status is not re-derived from its spelling", () => {
  it("keeps every one of the seven distinct", () => {
    const buckets = YOUTUBE_DOWNLOAD_STATUSES.map((s) => normalizeFailureReason(s));
    expect(new Set(buckets).size).toBe(YOUTUBE_DOWNLOAD_STATUSES.length);
    expect(buckets).not.toContain("other");
  });

  it("does not let the generic timeout branch swallow DOWNLOAD_TIMEOUT", () => {
    /**
     * The keyword branch below it matches "timeout" for every provider's socket timeout. A YouTube
     * budget refusal before any transfer is a different thing and needs a different name.
     */
    expect(normalizeFailureReason("DOWNLOAD_TIMEOUT")).toBe("download_timeout");
    expect(normalizeFailureReason("fetch timed out after 22s")).toBe("timeout");
  });

  it("names the configuration gap as itself, not as `other`", () => {
    /** DOWNLOAD_UNAVAILABLE means no route is configured — an operator action, not a bug. */
    expect(normalizeFailureReason("DOWNLOAD_UNAVAILABLE")).toBe("download_unavailable");
  });

  it("still buckets everything it never recognised", () => {
    expect(normalizeFailureReason("something nobody has seen before")).toBe("other");
    expect(normalizeFailureReason("")).toBe("unspecified");
    /** Not a status token: the prefix rule must not swallow prose that merely starts with it. */
    expect(normalizeFailureReason("download failed because the disk was full")).toBe("other");
  });
});

/* ═══════════════ the status reaches the ledger ═══════════════ */

describe("the reason that reaches the funnel is the one the fetcher decided", () => {
  it("files the specific status against the asset", () => {
    const cache = createSourcingCache(573);
    const tagged = tagPathWithProviderAsset("/w/s1_yt.mp4", "youtube_cc", "abc123", cache, {
      sceneIndex: 1, beatIndex: 2, mediaType: "video",
    });
    recordProviderDownloadOutcome(cache, tagged, false, "DOWNLOAD_TIMEOUT");
    const reasons = cache.lineage.summary().failureReasons;
    expect(reasons["download_timeout"]).toBe(1);
    expect(reasons["other"]).toBeUndefined();
  });

  it("a render 572 shaped batch no longer collapses into one bucket", () => {
    const cache = createSourcingCache(573);
    const statuses = ["DOWNLOAD_TIMEOUT", "DOWNLOAD_TIMEOUT", "DOWNLOAD_UNAVAILABLE", "DOWNLOAD_FAILED"];
    statuses.forEach((status, i) => {
      const tagged = tagPathWithProviderAsset(`/w/s1_yt_${i}.mp4`, "youtube_cc", `v${i}`, cache, {
        sceneIndex: 1, mediaType: "video",
      });
      recordProviderDownloadOutcome(cache, tagged, false, status);
    });
    const reasons = cache.lineage.summary().failureReasons;
    expect(reasons["download_timeout"]).toBe(2);
    expect(reasons["download_unavailable"]).toBe(1);
    expect(reasons["download_failed"]).toBe(1);
  });
});

/* ═══════════════ the wiring, and what it did not disturb ═══════════════ */

describe("the wiring at the cascade", () => {
  const block = (): string => {
    const at = PIPE.indexOf("if (!claimDownloadSlot()) {");
    expect(at).toBeGreaterThan(-1);
    return PIPE.slice(at, PIPE.indexOf("results.push(outPath);", at));
  };

  it("hands the fetcher a box and passes what came back to the ledger", () => {
    expect(block()).toContain("downloadYouTubeCCClip(");
    expect(block()).toContain("dl.status ?? \"youtube_download_failed\"");
  });

  it("keeps the generic string as the fallback, so an unreported status still files something", () => {
    /**
     * Not test-shaping: the fallback genuinely applies when the fetcher reported no status, and a
     * failure filed under a vague name is still better than a record left open forever.
     */
    expect(block()).toContain("youtube_download_failed");
  });

  it("fills the box at the single exit point, so no route can forget", () => {
    const report = PIPE.indexOf("const reportDownload = (status: YoutubeDownloadStatus");
    const fill = PIPE.indexOf("outcome.status = status;", report);
    const line = PIPE.indexOf("formatYoutubeDownloadLine({", report);
    expect(report).toBeGreaterThan(-1);
    expect(fill).toBeGreaterThan(report);
    expect(fill).toBeLessThan(line);
  });

  it("leaves the ceiling, the success counter and the screening order untouched", () => {
    const b = block();
    expect(b).toContain("claimDownloadSlot()");
    expect(PIPE).toContain('if (ok) providerMetrics(sourcingCache, "youtube_cc").downloadCount++;');
    /** RONDE 114's order still holds: the arrival is filed before the editor may refuse it. */
    const outcome = b.indexOf("recordProviderDownloadOutcome(");
    const gate = b.indexOf("youtubeClipPassesImageGate(outPath");
    expect(gate).toBeGreaterThan(outcome);
  });

  it("the new parameter is optional, so every other caller is unchanged", () => {
    /** Two production call sites and four test files call this fetcher with the old arity. */
    expect(PIPE).toContain("outcome?: { status?: YoutubeDownloadStatus; reason?: string }");
  });
});
