/**
 * RONDE 124 — two things that survived RONDE 123, and one correction to the brief.
 *
 * ── The correction ───────────────────────────────────────────────────────────────────────────
 *
 * The brief describes this as a YouTube Data API problem. It is not. In the worker log the live
 * YouTube search returned nothing at all — "YouTube CC 0 relevant results" ×14, "YouTube fair-use
 * 0 relevant results" ×14 — so no live result was ever licence-checked. All 56 refusals are
 * INTERNET ARCHIVE items whose identifier begins with `youtube-`:
 *
 *     Archive item youtube-cS2JdEghHDo has no usable license (licenseurl=none, rights=none)
 *
 * Changing the YouTube API path would have left every one of them exactly as it was.
 *
 * ── The two faults ───────────────────────────────────────────────────────────────────────────
 *
 *  1. one boolean stood for two different facts: "the licence forbids this" and "nobody filled
 *     the field in";
 *  2. `report.score = healed` destroyed the raw number, so a render whose quality inputs measured
 *     10 was stored as 85 with nothing left to say otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import {
  allowUnverifiedYoutube,
  classifyArchiveLicense,
  formatYoutubeLicenseLine,
  formatYoutubeUsageReport,
  isYoutubeOriginIdentifier,
  youtubeLicenseDecision,
  youtubeVideoIdFromIdentifier,
} from "./youtubeLicenseStatus";
import { isAllowedInternetArchiveLicense } from "./videoPipeline";
import { isAllowedInternetArchiveLicensePool } from "./scenePool";
import { healQualityReportForExport } from "./pipelineSelfHeal";
import { buildVideoQualityReport } from "./videoQualityReport";

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), "server", f), "utf8");

let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env.ALLOW_UNVERIFIED_YOUTUBE;
  delete process.env.ALLOW_UNVERIFIED_YOUTUBE;
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.ALLOW_UNVERIFIED_YOUTUBE;
  else process.env.ALLOW_UNVERIFIED_YOUTUBE = savedFlag;
  vi.restoreAllMocks();
});

/* ═══════════ 1. the flag, and what it may never do ═══════════ */

describe("RONDE 124 — ALLOW_UNVERIFIED_YOUTUBE", () => {
  it("is off unless it is explicitly the string 'true'", () => {
    expect(allowUnverifiedYoutube()).toBe(false);
    for (const v of ["", "false", "1", "yes", "TRUE ", "on"]) {
      process.env.ALLOW_UNVERIFIED_YOUTUBE = v;
      expect(allowUnverifiedYoutube()).toBe(v === "TRUE " ? true : false);
    }
    process.env.ALLOW_UNVERIFIED_YOUTUBE = "true";
    expect(allowUnverifiedYoutube()).toBe(true);
  });

  it("is read at call time, so the worker's own environment decides", () => {
    /**
     * Captured at import, a flag set on the worker service but not on the web service would
     * behave differently depending on which process happened to load the module first.
     */
    expect(src("youtubeLicenseStatus.ts")).toContain(
      "return process.env.ALLOW_UNVERIFIED_YOUTUBE?.trim().toLowerCase() === \"true\";"
    );
  });
});

/* ═══════════ 2. three statuses where there was one boolean ═══════════ */

describe("RONDE 124 — VERIFIED / UNVERIFIED / REJECTED", () => {
  it("THE PRODUCTION CASE: licenseurl=none, rights=none is UNVERIFIED, not REJECTED", () => {
    expect(classifyArchiveLicense(null, null)).toBe("UNVERIFIED");
    expect(classifyArchiveLicense(undefined, undefined)).toBe("UNVERIFIED");
    expect(classifyArchiveLicense("", "")).toBe("UNVERIFIED");
  });

  it("...and an -nc/-nd licence is REJECTED, which is a different fact entirely", () => {
    // Also from the same log, on a different item.
    expect(classifyArchiveLicense("https://creativecommons.org/licenses/by-nc-nd/4.0/", null)).toBe(
      "REJECTED"
    );
    expect(classifyArchiveLicense(null, "CC BY-NC 4.0")).toBe("REJECTED");
    expect(classifyArchiveLicense(null, "noncommercial use only")).toBe("REJECTED");
  });

  it("the permissive cases are VERIFIED", () => {
    expect(classifyArchiveLicense("https://creativecommons.org/publicdomain/mark/1.0/")).toBe("VERIFIED");
    expect(classifyArchiveLicense("https://creativecommons.org/licenses/by/4.0/")).toBe("VERIFIED");
    expect(classifyArchiveLicense("https://creativecommons.org/licenses/by-sa/4.0/")).toBe("VERIFIED");
    expect(classifyArchiveLicense(null, "Public Domain")).toBe("VERIFIED");
    expect(classifyArchiveLicense(null, "No known copyright restrictions")).toBe("VERIFIED");
  });

  it("a rights note that is about attribution is UNVERIFIED, not a refusal", () => {
    // The third distinct wording in the production log.
    expect(
      classifyArchiveLicense(null, "Every effort has been made to provide attribution of content")
    ).toBe("UNVERIFIED");
  });

  it("CRITICAL: VERIFIED is exactly what the old boolean called allowed", () => {
    /**
     * This is what makes the default behaviour provably unchanged. Both existing gates — the one
     * in videoPipeline and the deliberate copy in scenePool — must agree with the classifier on
     * every case, or the flag being off would not reproduce today's pipeline.
     */
    const cases: Array<[string | null, string | null]> = [
      [null, null],
      ["", ""],
      ["https://creativecommons.org/publicdomain/zero/1.0/", null],
      ["https://creativecommons.org/licenses/by/4.0/", null],
      ["https://creativecommons.org/licenses/by-sa/3.0/", null],
      ["https://creativecommons.org/licenses/by-nc-nd/4.0/", null],
      ["https://creativecommons.org/licenses/by-nc/4.0/", null],
      ["https://example.com/some-licence", null],
      [null, "Public Domain"],
      [null, "No known copyright restrictions"],
      [null, "CC BY-NC 4.0"],
      [null, "no derivative works"],
      [null, "Contact the rights holder"],
    ];
    for (const [url, rights] of cases) {
      const verified = classifyArchiveLicense(url, rights) === "VERIFIED";
      expect(isAllowedInternetArchiveLicense(url, rights)).toBe(verified);
      expect(isAllowedInternetArchiveLicensePool(url, rights)).toBe(verified);
    }
  });
});

/* ═══════════ 3. the decision, which is what the pipeline acts on ═══════════ */

describe("RONDE 124 — what the pipeline may do with each status", () => {
  const yt = "youtube-cS2JdEghHDo";

  /**
   * RONDE 141 — these three pin `allowOperatorLicensed: false` explicitly.
   *
   * They were written before RONDE 147's operator authorisation existed, so they injected one flag
   * and let the other default. RONDE 141 turned that other default ON, which would otherwise make
   * them describe rule 3 while claiming to describe rule 2. Pinning it keeps each test asserting
   * exactly the rule it was written for; the new default's own behaviour is asserted separately in
   * ronde141OperatorAuthorisation.test.ts, where it is visible rather than buried here.
   */
  it("flag OFF + no licence → rejected, exactly as today", () => {
    const d = youtubeLicenseDecision({
      identifier: yt,
      allowUnverified: false,
      allowOperatorLicensed: false,
    });
    expect(d.status).toBe("UNVERIFIED");
    expect(d.allowed).toBe(false);
    expect(d.action).toBe("REJECT");
  });

  it("flag ON + no licence → an UNVERIFIED candidate may continue", () => {
    const d = youtubeLicenseDecision({ identifier: yt, allowUnverified: true });
    expect(d.status).toBe("UNVERIFIED");
    expect(d.allowed).toBe(true);
    expect(d.action).toBe("ALLOW_UNVERIFIED_YOUTUBE");
    expect(d.youtubeVideoId).toBe("cS2JdEghHDo");
    // It never claims a licence exists.
    expect(d.licenseUrl).toBeNull();
    expect(d.rights).toBeNull();
  });

  it("CRITICAL: the flag NEVER overrides an explicit refusal", () => {
    const d = youtubeLicenseDecision({
      identifier: yt,
      licenseUrl: "https://creativecommons.org/licenses/by-nc-nd/4.0/",
      allowUnverified: true,
      // RONDE 141: rule 2 is what this test is about. Rule 3 DOES override an explicit refusal,
      // deliberately and on the owner's authorisation — see ronde147/ronde141.
      allowOperatorLicensed: false,
    });
    expect(d.status).toBe("REJECTED");
    expect(d.allowed).toBe(false);
    expect(d.action).toBe("REJECT");
  });

  it("a verified YouTube item is allowed either way — nothing about that changed", () => {
    for (const flag of [false, true]) {
      const d = youtubeLicenseDecision({
        identifier: yt,
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        allowUnverified: flag,
      });
      expect(d.status).toBe("VERIFIED");
      expect(d.action).toBe("ALLOW");
    }
  });

  it("the flag is scoped to YouTube — a non-YouTube archive item is untouched", () => {
    const d = youtubeLicenseDecision({
      identifier: "SomeNewsreel1943",
      allowUnverified: true,
    });
    expect(d.status).toBe("UNVERIFIED");
    expect(d.allowed).toBe(false);
    expect(d.youtubeVideoId).toBeNull();
  });

  it("the identifiers from the production log are recognised, and their IDs preserved", () => {
    for (const [id, videoId] of [
      ["youtube-p_rrH7MQIOY", "p_rrH7MQIOY"],
      ["youtube-zUU-LNi7FBc", "zUU-LNi7FBc"],
      ["youtube-cS2JdEghHDo", "cS2JdEghHDo"],
      ["youtube-q4_7hY0qT_E", "q4_7hY0qT_E"],
      ["youtube-iH7eISxI4d0", "iH7eISxI4d0"],
      ["youtube-IDVup_Pqb2w", "IDVup_Pqb2w"],
    ] as const) {
      expect(isYoutubeOriginIdentifier(id)).toBe(true);
      expect(youtubeVideoIdFromIdentifier(id)).toBe(videoId);
    }
    expect(isYoutubeOriginIdentifier("prelinger_home_movies")).toBe(false);
  });
});

/* ═══════════ 4. it is wired into BOTH gates, not just the first one found ═══════════ */

describe("RONDE 124 — the whole chain, not the first hit", () => {
  it("videoPipeline's archive gate asks the classifier", () => {
    const p = src("videoPipeline.ts");
    expect(p).toContain("const licenseDecision = youtubeLicenseDecision({");
    expect(p).toContain("if (!licenseDecision.allowed) {");
    expect(p).toContain("formatYoutubeLicenseLine(licenseDecision)");
  });

  it("scenePool's copy of the same gate asks it too", () => {
    const p = src("scenePool.ts");
    expect(p).toContain("const poolLicense = youtubeLicenseDecision({");
    expect(p).toContain("if (!poolLicense.allowed) continue;");
  });

  it("the module has no pipeline imports, so the scenePool cycle stays impossible", () => {
    const m = src("youtubeLicenseStatus.ts");
    expect(m).not.toContain('from "./videoPipeline"');
    expect(m).not.toContain('from "./scenePool"');
    expect(m).not.toContain("import ");
  });

  it("the preview check and the vision gate are still ahead of any use", () => {
    /**
     * The flag decides whether an item may CONTINUE, never whether it may be used. A broken
     * download still fails RONDE 118's preview check and a wrong picture still fails the vision
     * gate — this asserts those two are untouched rather than assuming it.
     */
    const p = src("videoPipeline.ts");
    expect(p).toContain("beatClipRefusedByRelevanceGate");
    expect(src("archiveIngestion.ts")).toContain("verifyArchivePreview({");
    expect(src("archiveUpload.ts")).toContain("verifyArchivePreviewBuffer");
  });
});

/* ═══════════ 5. the logs and the report ═══════════ */

describe("RONDE 124 — an unverified item says so everywhere", () => {
  it("the log line names the video, the status and the action", () => {
    const allow = formatYoutubeLicenseLine(
      youtubeLicenseDecision({
        identifier: "youtube-abc123",
        allowUnverified: true,
        allowOperatorLicensed: false,
      })
    );
    expect(allow).toContain("[YouTubeLicense] video=abc123");
    expect(allow).toContain("status=UNVERIFIED");
    expect(allow).toContain("action=ALLOW_UNVERIFIED_YOUTUBE");
    expect(allow).toContain("licenseUrl=null");
    expect(allow).toMatch(/rights NOT proven/i);

    const reject = formatYoutubeLicenseLine(
      youtubeLicenseDecision({
        identifier: "youtube-abc123",
        allowUnverified: false,
        allowOperatorLicensed: false,
      })
    );
    expect(reject).toContain("status=UNVERIFIED action=REJECT");
  });

  it("the usage report answers 'did this video use YouTube footage'", () => {
    expect(formatYoutubeUsageReport([])).toBe("[YouTubeUsage] used=0");

    const report = formatYoutubeUsageReport([
      {
        sceneIndex: 1, beatIndex: 4, youtubeVideoId: "abc123",
        title: "Göring newsreel 1935", channel: "Archive Channel",
        licenseStatus: "UNVERIFIED", licenseUrl: null, rights: null,
        previewStatus: "PASS", visionVerdict: "FITS",
      },
    ]);
    expect(report).toContain("[YouTubeUsage] used=1");
    expect(report).toContain("scene=1 beat=4 youtubeVideoId=abc123");
    expect(report).toContain("https://www.youtube.com/watch?v=abc123");
    expect(report).toContain("licenseStatus=UNVERIFIED licenseUrl=null rights=null");
    expect(report).toContain("preview=PASS vision=FITS used=true");
    expect(report).toMatch(/check this one manually/i);
  });

  it("it never dresses a missing licence up as a licence", () => {
    const d = youtubeLicenseDecision({ identifier: "youtube-abc", allowUnverified: true });
    expect(d.licenseUrl).toBeNull();
    const line = formatYoutubeLicenseLine(d);
    expect(line).not.toMatch(/creativecommons|public domain|licensed/i);
  });
});

/* ═══════════ 6. the score that overwrote itself ═══════════ */

describe("RONDE 124 — raw visual quality survives the availability policy", () => {
  const finalOk = {
    ok: true, durationSec: 74, hasAudio: true, hasVideo: true,
    sizeBytes: 48_000_000, spotOk: true, reasons: [],
  };

  it("THE PRODUCTION CASE: 10 → 85 keeps both numbers", () => {
    /**
     * Video 544 logged rawScore=10 healedScore=85. The jump is `archiveMontageOk` — a montage of
     * real archive clips with no fallback beats scores 85 on SOURCE TYPE alone, which says
     * nothing about held frames, coverage or whether the pictures fit. `report.score = healed`
     * then destroyed the 10.
     */
    const report = buildVideoQualityReport(
      ["/tmp/scene_0_b0_curated_a1.mp4", "/tmp/scene_0_b1_curated_a2.mp4"],
      "The real reason Hermann Göring joined Hitler",
      { archiveOnly: true, fastShort: true }
    );
    report.score = 10;
    healQualityReportForExport(report, "1", finalOk);

    expect(report.rawVisualQualityScore).toBe(10);
    expect(report.availabilityAdjustedScore).toBe(report.score);
    expect(report.score).toBeGreaterThan(10);
    // The raw number is never raised by the policy.
    expect(report.rawVisualQualityScore).toBeLessThan(report.score);
  });

  it("the warning says which number is the measurement", () => {
    const report = buildVideoQualityReport(
      ["/tmp/scene_0_b0_curated_a1.mp4"],
      "T",
      { archiveOnly: true, fastShort: true }
    );
    report.score = 10;
    healQualityReportForExport(report, "1", finalOk);
    const w = report.warnings.join(" | ");
    expect(w).toContain("raw=10/100");
    expect(w).toMatch(/availability, not picture quality/i);
  });

  it("a render the policy did NOT raise still records its raw score", () => {
    /**
     * Otherwise a reader cannot tell "the policy did not fire" from "this field was never
     * written", and the absence of the field would itself become misleading.
     */
    const report = buildVideoQualityReport(
      ["/tmp/scene_0_b0_curated_a1.mp4"],
      "T",
      { archiveOnly: true, fastShort: true }
    );
    report.score = 95;
    healQualityReportForExport(report, "1", finalOk);
    expect(report.rawVisualQualityScore).toBe(95);
    expect(report.availabilityAdjustedScore).toBeUndefined();
  });

  it("the raw score is recorded once and never re-raised by a second pass", () => {
    const report = buildVideoQualityReport(
      ["/tmp/scene_0_b0_curated_a1.mp4"],
      "T",
      { archiveOnly: true, fastShort: true }
    );
    report.score = 10;
    healQualityReportForExport(report, "1", finalOk);
    const afterFirst = report.rawVisualQualityScore;
    healQualityReportForExport(report, "1", finalOk);
    expect(report.rawVisualQualityScore).toBe(afterFirst);
    expect(report.rawVisualQualityScore).toBe(10);
  });
});
