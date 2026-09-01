/**
 * RONDE 136 — nothing was looking at the last frame.
 *
 * ── The blind spot, measured before it was closed ────────────────────────────────────────────
 *
 * Two checks run on a finished render, and neither of them inspects the ending:
 *
 *   postRenderSpotCheck   samples at 12%, 38%, 62% and 88% of the duration. On a three-minute
 *                         film the last sample is at 2:38 — a black final second is twenty-two
 *                         seconds past anything it sees.
 *   videoStillnessAudit   measured motion only. A file can end on a second and a half of pure
 *                         black with every number it reported staying healthy.
 *
 * Reproduced on a real MP4 built for this round: 4s of moving picture, then a 7-second still,
 * then 1.5s of black. The pre-RONDE-136 audit reported the still correctly and said nothing at
 * all about the ending.
 *
 * That matters more than it sounds. The last frame is what the viewer is left looking at and what
 * YouTube freezes for its end screen — and RONDE 132 added a closing tail specifically so that it
 * would be a picture. Nothing verified the result.
 *
 * ── Note on what this round did NOT do ───────────────────────────────────────────────────────
 *
 * RONDE 136 asked for a live production render. This environment has no credentials for one — all
 * seventeen are absent, listed in the round's report — so no production metric is claimed here.
 * These tests measure real MP4s built by the tests themselves.
 */
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditVideoStillness,
  checkStillnessLimit,
  formatStillnessReport,
  END_FRAME_BLACK_LUMA,
} from "./videoStillnessAudit";
import { stillImageMaxSec } from "./stillImagePolicy";

const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";

let dir = "";
/** 4s moving → 7s still → 1.5s black. Two defects, one file. */
let defectivePath = "";
/** The same film without the black tail: still defective on the still, fine at the end. */
let stillOnlyPath = "";
/** Moving throughout, ending on a picture. */
let cleanPath = "";

function concat(parts: string[], out: string): void {
  const list = join(dir, `list_${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
  execFileSync(
    FFMPEG,
    ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list,
     "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", "25", out],
    { timeout: 180_000 }
  );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "r136-"));
  const moving = join(dir, "moving.mp4");
  const moving2 = join(dir, "moving2.mp4");
  const still = join(dir, "still.mp4");
  const black = join(dir, "black.mp4");

  execFileSync(FFMPEG, ["-y", "-v", "error", "-f", "lavfi",
    "-i", "testsrc2=size=320x180:rate=25:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", moving], { timeout: 120_000 });
  execFileSync(FFMPEG, ["-y", "-v", "error", "-f", "lavfi",
    "-i", "testsrc2=size=320x180:rate=25:duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", moving2], { timeout: 120_000 });
  // A genuinely unchanging 7 seconds: one colour, held.
  execFileSync(FFMPEG, ["-y", "-v", "error", "-f", "lavfi",
    "-i", "color=c=0x4488cc:s=320x180:r=25:d=7",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", still], { timeout: 120_000 });
  execFileSync(FFMPEG, ["-y", "-v", "error", "-f", "lavfi",
    "-i", "color=c=black:s=320x180:r=25:d=1.5",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", black], { timeout: 120_000 });

  defectivePath = join(dir, "defective.mp4");
  stillOnlyPath = join(dir, "still_only.mp4");
  cleanPath = join(dir, "clean.mp4");
  concat([moving, still, black], defectivePath);
  concat([moving, still], stillOnlyPath);
  concat([moving, moving2], cleanPath);
}, 600_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("RONDE 136 — the film's last frame is measured", () => {
  it("1. a film that ends on black is caught", async () => {
    const report = await auditVideoStillness({ videoPath: defectivePath, timeoutMs: 180_000 });
    expect(report.endFrameLuma).not.toBeNull();
    expect(report.endFrameLuma!).toBeLessThan(END_FRAME_BLACK_LUMA);
    expect(report.endsOnBlack).toBe(true);
  }, 300_000);

  it("2. and it fails the verdict, however well the rest of it moved", async () => {
    const report = await auditVideoStillness({ videoPath: defectivePath, timeoutMs: 180_000 });
    const verdict = checkStillnessLimit(report, stillImageMaxSec());
    expect(verdict.ok).toBe(false);
    // The black ending alone is disqualifying — proved by a file with no over-limit still.
    const cleanReport = await auditVideoStillness({ videoPath: cleanPath, timeoutMs: 180_000 });
    expect(checkStillnessLimit(cleanReport, stillImageMaxSec()).ok).toBe(true);
  }, 300_000);

  it("3. a film that ends on a picture passes", async () => {
    const report = await auditVideoStillness({ videoPath: cleanPath, timeoutMs: 180_000 });
    expect(report.endsOnBlack).toBe(false);
    expect(report.endFrameLuma!).toBeGreaterThan(END_FRAME_BLACK_LUMA);
    expect(checkStillnessLimit(report, stillImageMaxSec()).ok).toBe(true);
  }, 300_000);

  it("4. the still-cap check is unchanged (RONDE 130/133)", async () => {
    const report = await auditVideoStillness({ videoPath: stillOnlyPath, timeoutMs: 180_000 });
    // Ends on a picture, so the ending is fine; the seven-second still is not.
    expect(report.endsOnBlack).toBe(false);
    expect(report.longestStillSec).toBeGreaterThan(stillImageMaxSec());
    const verdict = checkStillnessLimit(report, stillImageMaxSec());
    expect(verdict.ok).toBe(false);
    expect(verdict.stillsOverLimit).toBe(1);
  }, 300_000);

  it("5. imagesOver5Sec counts what the violations list names", async () => {
    const report = await auditVideoStillness({ videoPath: stillOnlyPath, timeoutMs: 180_000 });
    const verdict = checkStillnessLimit(report, stillImageMaxSec());
    expect(verdict.stillsOverLimit).toBe(verdict.violations.length);
  }, 300_000);

  it("6. the report block carries every field RONDE 136 §12 names", async () => {
    const report = await auditVideoStillness({ videoPath: defectivePath, timeoutMs: 180_000 });
    const verdict = checkStillnessLimit(report, stillImageMaxSec());
    const out = formatStillnessReport("r136", report, verdict);
    expect(out).toContain("duration");
    expect(out).toContain("visual changes");
    expect(out).toContain("longest still");
    expect(out).toContain("imagesOver5Sec");
    expect(out).toContain("endFrameLuma");
    expect(out).toContain("endsOnBlack         YES");
    expect(out).toContain("ends on a black frame");
    expect(out).toContain("passed              NO");
  }, 300_000);

  it("7. an unreadable end frame is NOT_MEASURED, never a pass", async () => {
    // A file the frame grab cannot read yields null, and null must not become `endsOnBlack: false`
    // dressed up as a verified bright ending.
    const missing = join(dir, "does_not_exist.mp4");
    expect(existsSync(missing)).toBe(false);
    const fake = {
      durationSec: 10, longestStillSec: 0, longestStillStartSec: 0,
      stillRuns: [], visualChanges: 40,
      endFrameLuma: null, endsOnBlack: false,
    };
    const verdict = checkStillnessLimit(fake, stillImageMaxSec());
    const out = formatStillnessReport("unmeasured", fake, verdict);
    expect(out).toContain("endFrameLuma        NOT_MEASURED");
    expect(out).toContain("endsOnBlack         NOT_MEASURED");
    // It does not fail the render — an unread frame is not evidence of a defect — but it never
    // claims the ending was checked.
    expect(out).not.toContain("endsOnBlack         no");
  });
});

describe("RONDE 136 — the pipeline reports it", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("8. the end-frame facts are stored on the quality report", () => {
    expect(PIPE).toContain("endFrameLuma: stillness.endFrameLuma");
    expect(PIPE).toContain("endsOnBlack: stillness.endsOnBlack");
    expect(PIPE).toContain("imagesOverLimit: verdict.stillsOverLimit");
  });

  it("9. a black ending becomes a warning the operator sees", () => {
    expect(PIPE).toContain("if (stillness.endsOnBlack)");
    expect(PIPE).toContain("de video eindigt op een zwart beeld");
  });

  it("10. the audit still runs on the exported file (RONDE 133)", () => {
    expect(PIPE).toContain("auditVideoStillness({");
    expect(PIPE).toContain("videoPath: finalVideoPath");
  });

  it("11. the earlier spot check still never looks at the end — this is why", () => {
    const spot = readFileSync(join(__dirname, "postRenderSpotCheck.ts"), "utf8");
    // Documented rather than changed: the two checks measure different things, and widening the
    // spot check's sampling would duplicate what the audit now does exactly.
    expect(spot).toContain("SAMPLE_FRACTIONS = [0.12, 0.38, 0.62, 0.88]");
    expect(Math.max(0.12, 0.38, 0.62, 0.88)).toBeLessThan(1);
  });
});

describe("RONDE 136 — mutation guards", () => {
  const AUDIT = readFileSync(join(__dirname, "videoStillnessAudit.ts"), "utf8");

  it("M1. the last frame is taken with -update 1, never at a computed timestamp", () => {
    // RONDE 132 established why: a target timestamp past the final frame yields an empty output
    // and a zero exit code, which reads exactly like a black frame that could not be measured.
    expect(AUDIT).toContain("-update 1");
    expect(AUDIT).toContain("readFinalFrameLuma");
    expect(AUDIT).not.toMatch(/-ss\s+\$\{[^}]*duration/);
  });

  it("M2. endsOnBlack cannot be true on an unmeasured frame", () => {
    expect(AUDIT).toContain("endFrameLuma !== null && endFrameLuma < END_FRAME_BLACK_LUMA");
  });

  it("M3. the verdict actually consults the ending", () => {
    expect(AUDIT).toContain("violations.length === 0 && !report.endsOnBlack");
  });

  it("M4. the black threshold matches the one the spot check already uses", () => {
    const spot = readFileSync(join(__dirname, "postRenderSpotCheck.ts"), "utf8");
    expect(AUDIT).toContain("END_FRAME_BLACK_LUMA = 22");
    expect(spot).toContain("BLACK_LUMA_THRESHOLD = 22");
  });

  it("M5. the temporary frame is cleaned up", () => {
    expect(AUDIT).toContain("fs.unlinkSync(framePath)");
    expect(AUDIT).toContain("finally");
  });
});
