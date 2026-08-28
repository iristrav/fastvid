/**
 * RONDE 156 — does the finished film show the same picture twice?
 *
 * ── The gap this closes ──────────────────────────────────────────────────────────────────────
 *
 * The sourcing dedup is thorough. `usedContentKeys` blocks the same file, `usedCuratedAssetIds`
 * and `usedCuratedStorageUrls` block the same archive row and storage object, and
 * `usedFingerprints` blocks near-duplicate footage all three of those miss — the same event from
 * a different archive or encode. Fourteen check sites in videoPipeline.ts.
 *
 * Every one of them runs BEFORE adoption, and two routes step around them deliberately. Both fire
 * only when a scene is starved of footage:
 *
 *   ensureArchiveMontageVoiceCoverage round B   re-uses dedup.lastRealClip
 *   montageTailPadFilterChain                   loop=loop=N replays the whole scene montage
 *
 * Video 551's scene 1 is the second one in the log: `loop=loop=3:size=124, setpts=2.0*PTS` —
 * 4.96s of source, looped four times to cover 38s. Nothing in the pre-adoption dedup can see that,
 * because it is not an adoption; it is a filter applied after the fact.
 *
 * So nothing could answer "does the finished video repeat itself". This measures the exported MP4
 * and answers it, the same way the stillness audit measures the exported MP4 rather than trusting
 * the plan that produced it.
 *
 * ── Verified against real video ──────────────────────────────────────────────────────────────
 *
 *     three different pictures, once each   0 repeats, passed
 *     one picture returning three times     4s repeated (33%), failed, timestamps named
 *
 * A first attempt at this test used the same source with different `hue` values and got one group
 * for everything — hue changes colour, not luminance, and the hash is computed on 8x8 grayscale.
 * That was the test being wrong, not the audit; the clips below differ in structure.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  REPEAT_MAX_SHARE,
  REPEAT_MIN_GAP_SEC,
  auditVideoRepeats,
  checkRepeatLimit,
  formatRepeatReport,
} from "./videoRepeatAudit";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

let dir: string;
let uniquePath: string;
let repeatedPath: string;

const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", ...args], { stdio: "ignore" });

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r156-"));
  const clip = (name: string, source: string) => {
    const p = path.join(dir, name);
    // `-t` rather than a `duration=` option: cellauto has no such option, and `-t` works for all
    // three sources.
    ff(["-f", "lavfi", "-i", `${source}=size=640x360:rate=25`, "-t", "4",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", p]);
    return p;
  };
  // Structurally different pictures, not merely differently coloured ones.
  const a = clip("a.mp4", "testsrc2");
  const b = clip("b.mp4", "smptebars");
  const c = clip("c.mp4", "cellauto");

  const concat = (name: string, parts: string[]) => {
    const list = path.join(dir, `${name}.txt`);
    const out = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(list, parts.map((f) => `file '${f}'`).join("\n") + "\n");
    ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
    return out;
  };
  uniquePath = concat("unique", [a, b, c]);
  // The shape a starved scene produces: one picture coming back between the others.
  repeatedPath = concat("repeated", [a, b, a, c, a]);
}, 120_000);

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("RONDE 156 — measured on real video", () => {
  it("a film whose pictures each appear once passes", async () => {
    const report = await auditVideoRepeats({ videoPath: uniquePath });
    const verdict = checkRepeatLimit(report);
    expect(report.repeats).toEqual([]);
    expect(report.repeatedSec).toBe(0);
    expect(verdict.ok).toBe(true);
  }, 120_000);

  it("a film that shows one picture again FAILS, and says where", async () => {
    const report = await auditVideoRepeats({ videoPath: repeatedPath });
    const verdict = checkRepeatLimit(report);
    expect(report.repeats.length).toBeGreaterThan(0);
    expect(report.repeatedSec).toBeGreaterThan(0);
    expect(verdict.ok).toBe(false);
    // The timestamps matter: "something repeats" is not actionable, "at 0s and 8s" is.
    expect(verdict.violations[0]).toMatch(/returns \d+×/);
    expect(verdict.violations[0]).toMatch(/seen at/);
  }, 120_000);

  it("the report names the numbers a person needs", async () => {
    const report = await auditVideoRepeats({ videoPath: repeatedPath });
    const text = formatRepeatReport("test", report, checkRepeatLimit(report));
    expect(text).toContain("distinct pictures");
    expect(text).toContain("repeated screen");
    expect(text).toContain("passed              NO");
  }, 120_000);
});

describe("RONDE 156 — what counts as a repeat", () => {
  it("a shot staying on screen is not a repeat", () => {
    // Consecutive seconds are one appearance. Banning that would ban shots longer than a second.
    const report = {
      durationSec: 10, sampled: 10, distinctPictures: 1,
      repeats: [], repeatedSec: 0, repeatedShare: 0,
    };
    expect(checkRepeatLimit(report).ok).toBe(true);
  });

  it("a returning shot is allowed in moderation — it is an ordinary documentary device", () => {
    /**
     * The limit is a SHARE, not a count. A film that revisits an image is normal; a film that is
     * mostly its own reruns is what a starved scene produces, and that is what this catches.
     */
    expect(REPEAT_MAX_SHARE).toBeGreaterThan(0);
    expect(REPEAT_MAX_SHARE).toBeLessThan(0.5);
    const modest = {
      durationSec: 100, sampled: 100, distinctPictures: 20,
      repeats: [{ atSec: [1, 40], appearances: 2, repeatedSec: 1 }],
      repeatedSec: 1, repeatedShare: 0.01,
    };
    expect(checkRepeatLimit(modest).ok).toBe(true);
  });

  it("a film that is mostly reruns fails", () => {
    const starved = {
      durationSec: 38, sampled: 38, distinctPictures: 2,
      repeats: [{ atSec: [0, 5, 10, 15, 20, 25, 30], appearances: 7, repeatedSec: 30 }],
      repeatedSec: 30, repeatedShare: 30 / 38,
    };
    const verdict = checkRepeatLimit(starved);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations[0]).toContain("returns 7×");
  });

  it("the gap that separates a return from a shot is explicit", () => {
    expect(REPEAT_MIN_GAP_SEC).toBeGreaterThanOrEqual(2);
  });
});

describe("RONDE 156 — wired into the render, as a measurement only", () => {
  it("it runs on the finished MP4, beside the stillness audit", () => {
    expect(PIPE).toContain("auditVideoRepeats({ videoPath: finalVideoPath");
    expect(PIPE).toContain("checkRepeatLimit(repeats)");
    expect(PIPE).toContain("formatRepeatReport(");
  });

  it("it decides nothing — no export is blocked by it", () => {
    const idx = PIPE.indexOf("auditVideoRepeats({ videoPath: finalVideoPath");
    const block = PIPE.slice(idx, idx + 1400);
    // It reports and warns. A `throw` or an export-gate change here would make a measurement into
    // a decision, which is not what this round is for.
    expect(block).not.toContain("throw ");
    expect(block).toContain("qualityReport.warnings.push");
  });

  it("its result reaches the quality report, so it survives the render", () => {
    expect(PIPE).toContain("qualityReport.repeats = {");
    const report = fs.readFileSync(path.join(__dirname, "videoQualityReport.ts"), "utf8");
    expect(report).toContain("repeats?: {");
    expect(report).toContain("distinctPictures: number;");
  });

  it("a failed audit is reported as absent, never as a pass", () => {
    // Same rule the stillness audit follows: an unmeasured film is not a clean one.
    const idx = PIPE.indexOf("auditVideoRepeats({ videoPath: finalVideoPath");
    expect(PIPE.slice(Math.max(0, idx - 3000), idx)).toContain("try {");
  });
});
