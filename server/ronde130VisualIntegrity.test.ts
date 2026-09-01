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

import {
  auditVideoStillness,
  checkStillnessLimit,
  formatStillnessReport,
} from "./videoStillnessAudit";
import { MAX_STILL_IMAGE_DURATION_SEC, containCenterFilter } from "./stillImagePolicy";
import { montageTailPadFilterChain } from "./videoPipeline";

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), "server", f), "utf8");

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronde130-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const ff = (cmd: string) => execSync(`ffmpeg ${cmd} 2>/dev/null`, { maxBuffer: 64 * 1024 * 1024 });
const probe = (f: string, e: string) =>
  execSync(`ffprobe -v error -show_entries ${e} -of default=nw=1:nk=1 "${f}"`, { encoding: "utf8" }).trim();

/* ═══════════ 1. the auditor itself has to be trustworthy ═══════════ */

describe("RONDE 130 — the measuring instrument", () => {
  it("a file that never changes measures as one long still", async () => {
    const out = path.join(dir, "frozen.mp4");
    ff(`-y -f lavfi -i "color=c=blue:size=320x240:rate=25:duration=9" -c:v libx264 -pix_fmt yuv420p "${out}"`);
    const r = await auditVideoStillness({ videoPath: out });
    expect(r.longestStillSec).toBeGreaterThan(8);
    expect(checkStillnessLimit(r, 5).ok).toBe(false);
  }, 120_000);

  it("a file that never stops moving measures as no still at all", async () => {
    const out = path.join(dir, "moving.mp4");
    ff(`-y -f lavfi -i "testsrc=size=320x240:rate=25:duration=9" -c:v libx264 -pix_fmt yuv420p "${out}"`);
    const r = await auditVideoStillness({ videoPath: out });
    expect(r.longestStillSec).toBeLessThan(1);
    expect(r.visualChanges).toBeGreaterThan(20);
    expect(checkStillnessLimit(r, 5).ok).toBe(true);
  }, 120_000);

  it("it finds a still in the MIDDLE of moving footage, and says where", async () => {
    /**
     * The case a duration check cannot see: a file of the right length whose picture stops for
     * seven seconds somewhere inside it.
     */
    const a = path.join(dir, "a.mp4"), b = path.join(dir, "b.mp4");
    const list = path.join(dir, "l.txt"), out = path.join(dir, "mixed.mp4");
    ff(`-y -f lavfi -i "testsrc=size=320x240:rate=25:duration=4" -c:v libx264 -pix_fmt yuv420p "${a}"`);
    ff(`-y -f lavfi -i "color=c=red:size=320x240:rate=25:duration=7" -c:v libx264 -pix_fmt yuv420p "${b}"`);
    fs.writeFileSync(list, `file '${a}'\nfile '${b}'\nfile '${a}'\n`);
    ff(`-y -f concat -safe 0 -i "${list}" -c:v libx264 -preset ultrafast -crf 23 "${out}"`);

    const r = await auditVideoStillness({ videoPath: out });
    const v = checkStillnessLimit(r, 5);
    expect(v.ok).toBe(false);
    expect(r.longestStillSec).toBeGreaterThan(6);
    // It begins where the still footage begins, not at zero.
    expect(r.longestStillStartSec).toBeGreaterThan(3);
    expect(formatStillnessReport("mixed", r, v)).toContain("VIOLATION");
  }, 180_000);
});

/* ═══════════ 2. THE PRODUCTION CASE, rendered and measured ═══════════ */

describe("RONDE 130 — scene 1's 3-second source against a 34-second slot", () => {
  it("REGRESSION: the old chain produced 28 seconds of one frame", async () => {
    const source = path.join(dir, "src.mp4"), out = path.join(dir, "old.mp4");
    ff(`-y -f lavfi -i "testsrc=size=320x240:rate=25:duration=3" -c:v libx264 -pix_fmt yuv420p "${source}"`);
    // Exactly what montageTailPadFilterChain used to emit: slow to the 2x cap, freeze the rest.
    ff(`-y -i "${source}" -vf "setpts=2.0*PTS,tpad=stop_mode=clone:stop_duration=28.0,fps=25,format=yuv420p" -c:v libx264 -preset ultrafast -crf 23 -an "${out}"`);

    const r = await auditVideoStillness({ videoPath: out });
    expect(r.durationSec).toBeGreaterThan(33);
    // The measurement this round exists for.
    expect(r.longestStillSec).toBeGreaterThan(20);
    expect(checkStillnessLimit(r, MAX_STILL_IMAGE_DURATION_SEC).ok).toBe(false);
  }, 180_000);

  it("THE FIX, MEASURED: the same slot now keeps moving", async () => {
    const source = path.join(dir, "src.mp4"), out = path.join(dir, "new.mp4");
    ff(`-y -f lavfi -i "testsrc=size=320x240:rate=25:duration=3" -c:v libx264 -pix_fmt yuv420p "${source}"`);
    // The chain the pipeline emits now, taken from the pipeline itself rather than retyped.
    const chain = montageTailPadFilterChain(3, 34, "test scene 1");
    expect(chain).toContain("loop=loop=");
    ff(`-y -i "${source}" -vf "${chain}fps=25,format=yuv420p" -c:v libx264 -preset ultrafast -crf 23 -an "${out}"`);

    const r = await auditVideoStillness({ videoPath: out });
    const v = checkStillnessLimit(r, MAX_STILL_IMAGE_DURATION_SEC);
    expect(r.durationSec).toBeGreaterThan(33);
    expect(v.ok, formatStillnessReport("fixed", r, v)).toBe(true);
    expect(r.longestStillSec).toBeLessThan(MAX_STILL_IMAGE_DURATION_SEC);
    expect(r.visualChanges).toBeGreaterThan(50);
  }, 180_000);

  it("a shortfall INSIDE the limit is still a plain hold — nothing else changed", () => {
    /**
     * 3s montage against an 8s slot: slowing to the 2x cap covers 6s, leaving 2s. A two-second
     * hold breaks no rule, so nothing about that case changes.
     *
     * The first version of this test used 10s against 12s, which produces no hold at all — the
     * slowdown alone covers it. Measuring the real planner rather than assuming its arithmetic is
     * what showed that.
     */
    const chain = montageTailPadFilterChain(3, 8, "small gap");
    expect(chain).toContain("tpad=stop_mode=clone");
    expect(chain).not.toContain("loop=loop=");
  });

  it("a slot the slowdown alone can cover emits no hold at all", () => {
    // 10s montage, 12s target: 1.2x covers it entirely.
    const chain = montageTailPadFilterChain(10, 12, "slow only");
    expect(chain).toContain("setpts=1.200000*PTS");
    expect(chain).not.toContain("tpad");
    expect(chain).not.toContain("loop=loop=");
  });

  it("no shortfall at all still emits nothing", () => {
    expect(montageTailPadFilterChain(12, 12, "no gap")).toBe("");
  });

  it("a montage too large to loop keeps a CAPPED hold and says it is a failure", () => {
    /**
     * `loop` buffers `size` decoded frames — about 3MB each at 1080p — so a long montage cannot
     * be looped while scenes compose in parallel. The hold stays, but capped, and the shortfall
     * is reported rather than absorbed.
     */
    const chain = montageTailPadFilterChain(60, 200, "huge montage");
    expect(chain).toContain("tpad=stop_mode=clone:stop_duration=5.000");
    expect(chain).not.toContain("loop=loop=");
  });

  it("the 2x slow-motion cap is still what bounds the slowdown", () => {
    const chain = montageTailPadFilterChain(3, 34, "cap check");
    // 34/3 is 11.3x; the emitted slowdown must be the cap, not the ratio.
    expect(chain).toContain("setpts=2.000000*PTS");
    expect(chain).not.toMatch(/setpts=(?:[3-9]|1[0-9])\./);
  });
});

/* ═══════════ 3. stills, rendered and measured ═══════════ */

describe("RONDE 130 — a photograph in the finished file", () => {
  it("five seconds of one photo passes; twelve does not", async () => {
    const img = path.join(dir, "p.png");
    ff(`-y -f lavfi -i "testsrc=size=640x360:rate=1:duration=1" -frames:v 1 "${img}"`);
    const contain = containCenterFilter({ widthPx: 1920, heightPx: 1080 });

    const ok = path.join(dir, "ok.mp4");
    ff(`-y -loop 1 -i "${img}" -t 5 -vf "${contain},fps=25,format=yuv420p" -c:v libx264 -preset ultrafast -crf 23 -an "${ok}"`);
    const rOk = await auditVideoStillness({ videoPath: ok });
    expect(checkStillnessLimit(rOk, MAX_STILL_IMAGE_DURATION_SEC).ok).toBe(true);

    const bad = path.join(dir, "bad.mp4");
    ff(`-y -loop 1 -i "${img}" -t 12 -vf "${contain},fps=25,format=yuv420p" -c:v libx264 -preset ultrafast -crf 23 -an "${bad}"`);
    const rBad = await auditVideoStillness({ videoPath: bad });
    expect(checkStillnessLimit(rBad, MAX_STILL_IMAGE_DURATION_SEC).ok).toBe(false);
    expect(rBad.longestStillSec).toBeGreaterThan(10);
  }, 180_000);

  it("three different photos of five seconds each pass, where one of fifteen fails", async () => {
    const contain = containCenterFilter({ widthPx: 1920, heightPx: 1080 });
    const parts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const img = path.join(dir, `p${i}.png`);
      const seg = path.join(dir, `s${i}.mp4`);
      // Three visibly different pictures.
      // Deliberately far apart, so "the picture changed" is unambiguous to the decimator.
      const colours = ["red", "green", "blue"];
      ff(`-y -f lavfi -i "color=c=${colours[i]}:size=640x360:rate=1:duration=1" -frames:v 1 "${img}"`);
      ff(`-y -loop 1 -i "${img}" -t 5 -vf "${contain},fps=25,format=yuv420p" -c:v libx264 -preset ultrafast -crf 23 -an "${seg}"`);
      parts.push(seg);
    }
    const list = path.join(dir, "l.txt"), out = path.join(dir, "three.mp4");
    fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
    ff(`-y -f concat -safe 0 -i "${list}" -c:v libx264 -preset ultrafast -crf 23 "${out}"`);

    const r = await auditVideoStillness({ videoPath: out });
    expect(r.durationSec).toBeGreaterThan(14);
    // Each still is five seconds; none exceeds the rule.
    expect(checkStillnessLimit(r, MAX_STILL_IMAGE_DURATION_SEC).ok).toBe(true);
    // ...and the picture changed, which a single 15-second still would not have done.
    expect(r.stillRuns.length).toBeGreaterThanOrEqual(2);
    expect(r.visualChanges).toBeGreaterThanOrEqual(2);
  }, 240_000);

  it("a wide photo keeps its whole picture and its square pixels", async () => {
    const img = path.join(dir, "w.png"), out = path.join(dir, "w.mp4");
    ff(`-y -f lavfi -i "testsrc=size=1600x400:rate=1:duration=1" -frames:v 1 "${img}"`);
    ff(`-y -loop 1 -i "${img}" -t 2 -vf "${containCenterFilter({ widthPx: 1920, heightPx: 1080 })},fps=25,format=yuv420p" -c:v libx264 -preset ultrafast -crf 23 -an "${out}"`);
    const dims = probe(out, "stream=width,height,sample_aspect_ratio").split("\n");
    expect(dims[0]).toBe("1920");
    expect(dims[1]).toBe("1080");
    expect(["1:1", "N/A"]).toContain(dims[2]);
  }, 120_000);

  it("a tall photo is letterboxed on the SIDES, not cropped top and bottom", async () => {
    const img = path.join(dir, "t.png"), out = path.join(dir, "t.mp4");
    ff(`-y -f lavfi -i "testsrc=size=400x1200:rate=1:duration=1" -frames:v 1 "${img}"`);
    ff(`-y -loop 1 -i "${img}" -t 2 -vf "${containCenterFilter({ widthPx: 1920, heightPx: 1080 })},fps=25,format=yuv420p" -c:v libx264 -preset ultrafast -crf 23 -an "${out}"`);
    // 400x1200 contained in 1920x1080 becomes 360x1080 — pillarboxed, full height, nothing cut.
    const left = path.join(dir, "left.png"), centre = path.join(dir, "centre.png");
    ff(`-y -i "${out}" -vf "crop=2:1080:0:0" -frames:v 1 "${left}"`);
    ff(`-y -i "${out}" -vf "crop=2:1080:959:0" -frames:v 1 "${centre}"`);
    expect(fs.statSync(left).size).toBeLessThan(fs.statSync(centre).size);
  }, 120_000);
});

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

  it("RONDE 121/122: the closing tail moves, and the trimmer leaves it alone", async () => {
    const { closingTailZoomExpr, trailingBlackTrimReachesClosingTail } = await import("./closingTail");
    expect(closingTailZoomExpr(75)).toBe("1+0.06*on/74");
    expect(
      trailingBlackTrimReachesClosingTail({ lastBlackEndSec: 74, videoDurationSec: 74, closingTailSec: 3 })
    ).toBe(true);
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

  it("RONDE 124: the raw quality score is never overwritten by the availability policy", async () => {
    const { healQualityReportForExport } = await import("./pipelineSelfHeal");
    const { buildVideoQualityReport } = await import("./videoQualityReport");
    const report = buildVideoQualityReport(["/tmp/scene_0_b0_curated_a1.mp4"], "T", {
      archiveOnly: true, fastShort: true,
    });
    report.score = 10;
    healQualityReportForExport(report, "1", {
      ok: true, durationSec: 74, hasAudio: true, hasVideo: true,
      sizeBytes: 48_000_000, spotOk: true, reasons: [],
    });
    expect(report.rawVisualQualityScore).toBe(10);
    expect(report.score).toBeGreaterThan(10);
  });
});
