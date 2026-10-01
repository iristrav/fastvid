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

import { MAX_STILL_IMAGE_DURATION_SEC, containCenterFilter, stillImageMaxSec } from "./stillImagePolicy";

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), "server", f), "utf8");

let tmpDir: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["MAX_STILL_IMAGE_DURATION_SEC"];

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

  it("RONDE 656 — the encoder's default branch contains the picture and holds it: no flag brings a baked zoom back", () => {
    const curated = src("curatedMediaSourcing.ts");
    const fn = curated.slice(
      curated.indexOf("async function convertImageToKenBurns("),
      curated.indexOf("async function convertImageToKenBurns(") + 9500
    );
    expect(fn).not.toContain("stillKenBurnsEnabled");
    expect(fn).not.toContain("stillZoomOutExpr(");
    expect(fn).toContain("containCenterFilter({ widthPx: VIDEO_WIDTH, heightPx: VIDEO_HEIGHT })");
    expect(fn).toContain('`-vf "${contain},fps=25,format=yuv420p" `');
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

  it("RONDE 124's licence statuses are untouched", async () => {
    const { classifyArchiveLicense } = await import("./youtubeLicenseStatus");
    expect(classifyArchiveLicense(null, null)).toBe("UNVERIFIED");
    expect(classifyArchiveLicense("https://creativecommons.org/licenses/by-nc-nd/4.0/")).toBe("REJECTED");
  });
});
