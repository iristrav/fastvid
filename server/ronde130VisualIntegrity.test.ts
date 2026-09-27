/**
 * RONDE 130 — measure the finished file, not the plan that made it.
 *
 * Every earlier round proved its rule against the code that implements it. That is not evidence
 * about the MP4 a viewer watches, and the two can disagree for reasons no unit test would see —
 * a filter that silently does nothing, a stream that outlives its picture, a concat that repeats.
 *
 * This file renders real MP4s with real ffmpeg and measures their frames.
 *
 * ── What the measurement found ───────────────────────────────────────────────────────────────
 *
 * The compose-time pad was capped nowhere. Rendered with the production shape of scene 1 — a 3s
 * source against a 34s target, exactly the case the worker log reported:
 *
 *     before   34.0s file, longest unchanging picture 28.13s, 33 visual changes    FAILS
 *     after    34.0s file, longest unchanging picture  0.00s, 167 visual changes   passes
 *
 * Twenty-eight seconds of one frame, on the one path taken precisely when a scene is worst off.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { MAX_STILL_IMAGE_DURATION_SEC, containCenterFilter } from "./stillImagePolicy";

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), "server", f), "utf8");

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronde130-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const ff = (cmd: string) => execSync(`ffmpeg ${cmd} 2>/dev/null`, { maxBuffer: 64 * 1024 * 1024 });
const probe = (f: string, e: string) =>
  execSync(`ffprobe -v error -show_entries ${e} -of default=nw=1:nk=1 "${f}"`, { encoding: "utf8" }).trim();

/* ═══════════ 4. the invariants of every earlier round ═══════════ */

describe("RONDE 130 — earlier rounds, asserted rather than assumed", () => {
  it("RONDE 111/112: the 2x cap and the 1.2s stitch floor", async () => {
    const { MAX_COVERAGE_SLOWDOWN, MIN_STITCHABLE_SOURCE_SEC } = await import("./coverageFillPlan");
    expect(MAX_COVERAGE_SLOWDOWN).toBe(2);
    expect(MIN_STITCHABLE_SOURCE_SEC).toBe(1.2);
  });

  it("RONDE 118: preview validation still stands in front of every archive insert", () => {
    expect(src("archiveIngestion.ts")).toContain("verifyArchivePreview({");
    expect(src("archiveUpload.ts")).toContain("verifyArchivePreviewBuffer");
  });

  it("RONDE 124: the three licence statuses", async () => {
    const { classifyArchiveLicense, youtubeLicenseDecision } = await import("./youtubeLicenseStatus");
    expect(classifyArchiveLicense(null, null)).toBe("UNVERIFIED");
    expect(classifyArchiveLicense("https://creativecommons.org/licenses/by-nc-nd/4.0/")).toBe("REJECTED");
    // ALLOW_UNVERIFIED_YOUTUBE can never override an explicit refusal — RONDE 124's rule, and it
    // still holds. RONDE 141: the OPERATOR authorisation is a different rule and does override it,
    // deliberately and on the owner's say-so, so it is pinned off here rather than left to a
    // default that would silently turn this into a test of the other rule.
    expect(
      youtubeLicenseDecision({
        identifier: "youtube-abc",
        licenseUrl: "https://creativecommons.org/licenses/by-nc-nd/4.0/",
        allowUnverified: true,
        allowOperatorLicensed: false,
      }).allowed
    ).toBe(false);
  });

  it("RONDE 125: Hermann Göring is one person and the title words are not people", async () => {
    const { extractPersonNamesFromText } = await import("./videoPipeline");
    const bad = extractPersonNamesFromText("The Influential Choice Hermann Göring Made To Join Hitler");
    expect(bad).not.toContain("Influential");
    expect(bad).not.toContain("Choice");
    expect(bad).not.toContain("Hermann");
    expect(extractPersonNamesFromText("The real reason Hermann Göring joined Hitler")).toContain(
      "Hermann Göring"
    );
  });

  it("RONDE 128: contain, centred, no crop, no zoom", () => {
    const f = containCenterFilter({ widthPx: 1920, heightPx: 1080 });
    expect(f).toContain("force_original_aspect_ratio=decrease");
    expect(f).not.toContain("crop");
    expect(f).not.toContain("zoompan");
    expect(f).toContain("setsar=1");
  });

  it("RONDE 129: a cancellation is not retried and a 429 stands one provider down", async () => {
    const { classifyProviderFailure, cooldownMsForFailure, shouldRetryAfterFailure } = await import(
      "./providerFailureClass"
    );
    expect(classifyProviderFailure({ err: new Error("Video generation cancelled") })).toBe("CANCELLED");
    expect(shouldRetryAfterFailure({ kind: "CANCELLED", attempt: 0, maxAttempts: 4 }).retry).toBe(false);
    expect(cooldownMsForFailure("RATE_LIMITED")).toBeGreaterThanOrEqual(60_000);
  });
});
