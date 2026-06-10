import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  buildSimpleKenBurnsVF,
  buildStillEncodeArgs,
  resolveStillCompositionVF,
  stillOutputFrameCount,
} from "./documentaryStyle";

const FFMPEG = path.resolve("node_modules/ffmpeg-static/ffmpeg.exe");

function probeDuration(filePath: string): number {
  try {
    const out = execSync(`"${FFMPEG}" -hide_banner -i "${filePath}" 2>&1`, {
      encoding: "utf8",
      windowsHide: true,
    });
    const m = out.match(/Duration:\s(\d+):(\d+):([\d.]+)/);
    if (!m) return 0;
    return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
  } catch (err) {
    const out = String((err as { stdout?: string }).stdout ?? "");
    const m = out.match(/Duration:\s(\d+):(\d+):([\d.]+)/);
    if (!m) return 0;
    return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
  }
}

function runStillEncode(imgPath: string, outPath: string, duration: number, filterComplex: string): void {
  execSync(`"${FFMPEG}" ${buildStillEncodeArgs(imgPath, outPath, duration, filterComplex)}`, {
    stdio: "pipe",
    windowsHide: true,
  });
}

function extractFramePng(videoPath: string, tSec: number, outPng: string): void {
  execFileSync(
    FFMPEG,
    ["-y", "-ss", String(tSec), "-i", videoPath, "-frames:v", "1", "-q:v", "2", outPng],
    { stdio: "ignore" }
  );
}

function pngSampleHash(pngPath: string): string {
  const buf = fs.readFileSync(pngPath);
  const sample = buf.subarray(Math.floor(buf.length * 0.3), Math.floor(buf.length * 0.5));
  let sum = 0;
  for (let i = 0; i < sample.length; i++) sum = (sum + sample[i] * (i + 1)) % 1_000_000_007;
  return String(sum);
}

describe("documentary still encode (ffmpeg integration)", () => {
  const workDir = path.join(process.cwd(), "tmp-doc-style-test");
  const imgA = path.join(process.cwd(), "tmp-video-analysis", "frame_0001.jpg");
  const imgB = path.join(process.cwd(), "tmp-video-analysis", "frame_0010.jpg");

  beforeAll(() => {
    if (!fs.existsSync(FFMPEG)) {
      throw new Error("ffmpeg-static not found — run npm install");
    }
    fs.mkdirSync(workDir, { recursive: true });
    if (!fs.existsSync(imgA) || !fs.existsSync(imgB)) {
      throw new Error("Test images missing — need tmp-video-analysis/frame_0001.jpg and frame_0010.jpg");
    }
  });

  afterAll(() => {
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("encodes documentary blur-fill still with correct duration and motion", () => {
    const duration = 4;
    const out = path.join(workDir, "still_blur.mp4");
    const fc = resolveStillCompositionVF(duration, 1, 0, false);
    runStillEncode(imgA, out, duration, fc);

    expect(fs.existsSync(out)).toBe(true);
    const probed = probeDuration(out);
    expect(probed).toBeGreaterThan(3.5);
    expect(probed).toBeLessThan(4.5);

    const f0 = path.join(workDir, "blur_f0.png");
    const f2 = path.join(workDir, "blur_f2.png");
    extractFramePng(out, 0.2, f0);
    extractFramePng(out, 2.5, f2);
    expect(pngSampleHash(f0)).not.toBe(pngSampleHash(f2));
  });

  it("encodes two different stills and montages them without freezing on one photo", () => {
    const beatDur = 3.5;
    const clipA = path.join(workDir, "beat_a.mp4");
    const clipB = path.join(workDir, "beat_b.mp4");
    const montageOut = path.join(workDir, "montage.mp4");

    const fcA = resolveStillCompositionVF(beatDur, 0, 1, false);
    const fcB = resolveStillCompositionVF(beatDur, 1, 0, true);
    runStillEncode(imgA, clipA, beatDur, fcA);
    runStillEncode(imgB, clipB, beatDur, fcB);

    const w = 1920;
    const h = 1080;
    const fps = 25;
    const filter =
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-${w})/2:(ih-${h})/2,` +
      `trim=duration=${beatDur},setpts=PTS-STARTPTS[v0];` +
      `[1:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-${w})/2:(ih-${h})/2,` +
      `trim=duration=${beatDur},setpts=PTS-STARTPTS[v1];` +
      `[v0][v1]concat=n=2:v=1:a=0[vout]`;

    execFileSync(
      FFMPEG,
      ["-y", "-i", clipA, "-i", clipB, "-filter_complex", filter, "-map", "[vout]", "-r", String(fps), montageOut],
      { stdio: "pipe" }
    );

    const total = probeDuration(montageOut);
    expect(total).toBeGreaterThan(6.5);
    expect(total).toBeLessThan(7.5);

    const early = path.join(workDir, "montage_early.png");
    const late = path.join(workDir, "montage_late.png");
    extractFramePng(montageOut, 1.0, early);
    extractFramePng(montageOut, 5.5, late);
    expect(pngSampleHash(early)).not.toBe(pngSampleHash(late));
  });

  it("falls back to simple Ken Burns when blur filter string is invalid", () => {
    const duration = 3;
    const out = path.join(workDir, "fallback.mp4");
    const fc = buildSimpleKenBurnsVF(duration, false);
    runStillEncode(imgA, out, duration, fc);
    expect(stillOutputFrameCount(duration)).toBe(75);
    expect(probeDuration(out)).toBeGreaterThan(2.8);
  });
});
