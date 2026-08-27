/**
 * RONDE 128 — a photograph is shown whole, centred, and for five seconds.
 *
 * ── What a still used to become ──────────────────────────────────────────────────────────────
 *
 * The image→video encoder built this, for a duration the beat asked for with no upper bound:
 *
 *     scale=2150:1210:force_original_aspect_ratio=increase,   COVER: upscale past the frame
 *     crop=1920:1080:(iw-1920)/2:(ih-1080)/2,                 cut off whatever overflowed
 *     zoompan=z='min(zoom+…,1.2)':x='iw/2-(iw/zoom/2)-on*N'   zoom in, and pan sideways
 *
 * Enlarged past the frame, edges cut off, then moved across what was left — for as long as the
 * narration ran.
 *
 * ── The tension with RONDE 111, resolved rather than ignored ─────────────────────────────────
 *
 * RONDE 111 required Ken Burns to keep moving because a motionless picture reads as a frozen
 * frame. That is true for an UNBOUNDED duration and stops being true at five seconds, which is a
 * shot length. The shared rule is unchanged — the viewer must never look at the same unchanging
 * thing for long — and this round achieves it by changing the picture instead of moving it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import {
  MAX_STILL_IMAGE_DURATION_SEC,
  MIN_STILL_SEGMENT_SEC,
  containCenterFilter,
  formatStillPlan,
  planStillSegments,
  stillImageMaxSec,
  stillKenBurnsEnabled,
  stillPlanIsValid,
} from "./stillImagePolicy";

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), "server", f), "utf8");

let tmpDir: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["MAX_STILL_IMAGE_DURATION_SEC", "ENABLE_STILL_KEN_BURNS"];

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ronde128-"));
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ═══════════ 1. five seconds ═══════════ */

describe("RONDE 128 — an image is on screen for at most five seconds", () => {
  it("the cap is five, and nobody has to configure it", () => {
    expect(MAX_STILL_IMAGE_DURATION_SEC).toBe(5);
    expect(stillImageMaxSec()).toBe(5);
  });

  it("it can be moved, but not removed", () => {
    process.env.MAX_STILL_IMAGE_DURATION_SEC = "4";
    expect(stillImageMaxSec()).toBe(4);
    // An override that removed the cap would remove the round.
    process.env.MAX_STILL_IMAGE_DURATION_SEC = "600";
    expect(stillImageMaxSec()).toBe(15);
    process.env.MAX_STILL_IMAGE_DURATION_SEC = "nonsense";
    expect(stillImageMaxSec()).toBe(5);
  });

  it("REGRESSION: the encoder caps the duration itself", () => {
    /**
     * At the one function that turns an image into a clip, not at its callers — a cap a caller
     * has to remember is a cap that eventually gets forgotten.
     */
    const curated = src("curatedMediaSourcing.ts");
    const fn = curated.slice(curated.indexOf("async function convertImageToKenBurns("));
    expect(fn.slice(0, 2000)).toContain("const cap = stillImageMaxSec();");
    expect(fn.slice(0, 2000)).toContain("duration = cap;");
  });

  it("15s across three images is 5 + 5 + 5", () => {
    const plan = planStillSegments({ totalSec: 15, imageCount: 3 });
    expect(plan.map((s) => s.durationSec)).toEqual([5, 5, 5]);
    expect(plan.map((s) => s.imageIndex)).toEqual([0, 1, 2]);
    expect(stillPlanIsValid(plan)).toBe(true);
  });

  it("20s across four images is four shots, none over five seconds", () => {
    const plan = planStillSegments({ totalSec: 20, imageCount: 4 });
    expect(plan).toHaveLength(4);
    for (const s of plan) expect(s.durationSec).toBeLessThanOrEqual(5);
    expect(stillPlanIsValid(plan)).toBe(true);
  });

  it("a stretch that fits stays one shot", () => {
    expect(planStillSegments({ totalSec: 4, imageCount: 1 })).toEqual([
      { imageIndex: 0, durationSec: 4 },
    ]);
  });
});

/* ═══════════ 2. never the same picture twice in a row ═══════════ */

describe("RONDE 128 — a repeat is a held frame with a cut drawn in it", () => {
  it("CRITICAL: one image cannot cover more than the cap", () => {
    /**
     * Repeating the same photograph back to back is the same picture standing still with an edit
     * in the middle. An empty plan is a coverage gap the caller must report — never a licence to
     * hold one frame for the whole stretch.
     */
    expect(planStillSegments({ totalSec: 12, imageCount: 1 })).toEqual([]);
    expect(planStillSegments({ totalSec: 5.5, imageCount: 1 })).toEqual([]);
  });

  it("two images alternate rather than one being exhausted", () => {
    const plan = planStillSegments({ totalSec: 15, imageCount: 2 });
    expect(plan.map((s) => s.imageIndex)).toEqual([0, 1, 0]);
    expect(stillPlanIsValid(plan)).toBe(true);
  });

  it("no plan ever puts the same image in consecutive segments", () => {
    for (let total = 6; total <= 40; total += 1.5) {
      for (let images = 2; images <= 5; images++) {
        const plan = planStillSegments({ totalSec: total, imageCount: images });
        for (let i = 1; i < plan.length; i++) {
          expect(plan[i]!.imageIndex, `${total}s / ${images} images`).not.toBe(plan[i - 1]!.imageIndex);
        }
      }
    }
  });

  it("a sliver at the end is folded in, not shown as a flash", () => {
    const plan = planStillSegments({ totalSec: 10.4, imageCount: 2 });
    for (const s of plan) expect(s.durationSec).toBeGreaterThanOrEqual(MIN_STILL_SEGMENT_SEC);
    expect(plan.reduce((a, s) => a + s.durationSec, 0)).toBeCloseTo(10.4, 2);
  });

  it("the total is always covered exactly", () => {
    for (const total of [7, 11, 13.5, 22, 31.7]) {
      const plan = planStillSegments({ totalSec: total, imageCount: 4 });
      expect(plan.reduce((a, s) => a + s.durationSec, 0), `${total}s`).toBeCloseTo(total, 2);
    }
  });

  it("the log says a gap is a gap, not a held frame", () => {
    expect(formatStillPlan(1, 4, 12, [])).toMatch(/coverage gap, NOT a held frame/);
    expect(formatStillPlan(1, 4, 15, planStillSegments({ totalSec: 15, imageCount: 3 }))).toContain(
      "3 still(s)"
    );
  });
});

/* ═══════════ 3. contain, centre, no zoom, no crop ═══════════ */

describe("RONDE 128 — the whole picture, in the middle", () => {
  it("REGRESSION: contain, not cover", () => {
    const f = containCenterFilter({ widthPx: 1920, heightPx: 1080 });
    // `decrease` is the single word that separates contain from cover.
    expect(f).toContain("force_original_aspect_ratio=decrease");
    expect(f).not.toContain("increase");
    // After a contain scale there is nothing outside the frame, so there is nothing to crop.
    expect(f).not.toContain("crop");
    expect(f).not.toContain("zoompan");
  });

  it("centred on both axes, and the pixel aspect ratio pinned", () => {
    const f = containCenterFilter({ widthPx: 1920, heightPx: 1080 });
    expect(f).toContain("pad=1920:1080:(ow-iw)/2:(oh-ih)/2");
    // A padded frame inherits the source's SAR otherwise — which is how a correctly scaled image
    // still comes out stretched.
    expect(f).toContain("setsar=1");
  });

  it("Ken Burns is off for ordinary stills, and reversible in one setting", () => {
    expect(stillKenBurnsEnabled()).toBe(false);
    process.env.ENABLE_STILL_KEN_BURNS = "true";
    expect(stillKenBurnsEnabled()).toBe(true);
  });

  it("the encoder's default branch is the contain one", () => {
    const curated = src("curatedMediaSourcing.ts");
    const fn = curated.slice(
      curated.indexOf("async function convertImageToKenBurns("),
      curated.indexOf("async function convertImageToKenBurns(") + 6000
    );
    // The zoom/crop path is now behind the flag...
    expect(fn).toContain("} else if (stillKenBurnsEnabled()) {");
    // ...and the default path contains the picture.
    expect(fn).toContain("containCenterFilter({ widthPx: VIDEO_WIDTH, heightPx: VIDEO_HEIGHT })");
  });

  it("THE REAL TEST: a wide photo really is letterboxed and centred, not cropped", () => {
    /**
     * Everything above is about a filter string. This renders it and measures the pixels: a
     * 1600x400 photograph in a 1920x1080 frame must appear at its own aspect ratio with equal
     * bars above and below, and its edges must survive.
     */
    const img = path.join(tmpDir, "wide.png");
    const out = path.join(tmpDir, "out.mp4");
    // A picture with a distinct left and right edge, so a crop would be visible as a loss.
    execSync(
      `ffmpeg -y -f lavfi -i "testsrc=size=1600x400:rate=1:duration=1" -frames:v 1 "${img}" 2>/dev/null`
    );
    execSync(
      `ffmpeg -y -loop 1 -i "${img}" -t 1 -vf "${containCenterFilter({ widthPx: 1920, heightPx: 1080 })},fps=25,format=yuv420p" ` +
        `-c:v libx264 -preset ultrafast -crf 18 -an "${out}" 2>/dev/null`
    );
    const dims = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,sample_aspect_ratio -of default=nw=1:nk=1 "${out}"`,
      { encoding: "utf8" }
    ).trim().split("\n");
    expect(dims[0]).toBe("1920");
    expect(dims[1]).toBe("1080");
    // Square pixels — nothing stretched.
    expect(["1:1", "N/A"]).toContain(dims[2]);

    // The picture is 1600x400 -> contained at 1920 wide it becomes 1920x480, leaving 300px of
    // padding above and below. Sample the top row: it must be the pad colour, not picture.
    const top = path.join(tmpDir, "top.png");
    execSync(`ffmpeg -y -i "${out}" -vf "crop=1920:2:0:0" -frames:v 1 "${top}" 2>/dev/null`);
    const mid = path.join(tmpDir, "mid.png");
    execSync(`ffmpeg -y -i "${out}" -vf "crop=1920:2:0:539" -frames:v 1 "${mid}" 2>/dev/null`);
    // The bars are uniform and the middle is not — i.e. the picture sits between them.
    expect(fs.statSync(top).size).toBeLessThan(fs.statSync(mid).size);
  }, 120_000);
});

/* ═══════════ 4. nothing from the earlier rounds is disturbed ═══════════ */

describe("RONDE 128 — earlier guarantees intact", () => {
  it("the 2x slow-motion cap and the 1.2s stitch floor are untouched", async () => {
    const { MAX_COVERAGE_SLOWDOWN, MIN_STITCHABLE_SOURCE_SEC } = await import("./coverageFillPlan");
    expect(MAX_COVERAGE_SLOWDOWN).toBe(2);
    expect(MIN_STITCHABLE_SOURCE_SEC).toBe(1.2);
  });

  it("the coverage ladder still has its rungs, in order", () => {
    const p = src("videoPipeline.ts");
    const a = p.indexOf("Round A — ask for SHORT holds");
    const a2 = p.indexOf("Round A2: footage of what the shortest beats are ABOUT");
    const b = p.indexOf("Round B — re-use this scene's OWN footage, in motion");
    expect(a).toBeGreaterThan(0);
    expect(a2).toBeGreaterThan(a);
    expect(b).toBeGreaterThan(a2);
  });

  it("the closing tail still moves — RONDE 121 is a deliberate exception, not a still", async () => {
    const { closingTailZoomExpr } = await import("./closingTail");
    expect(closingTailZoomExpr(75)).toBe("1+0.06*on/74");
  });

  it("RONDE 124's licence statuses are untouched", async () => {
    const { classifyArchiveLicense } = await import("./youtubeLicenseStatus");
    expect(classifyArchiveLicense(null, null)).toBe("UNVERIFIED");
    expect(classifyArchiveLicense("https://creativecommons.org/licenses/by-nc-nd/4.0/")).toBe("REJECTED");
  });
});
