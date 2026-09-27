import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN ?? "ffprobe";

/**
 * RONDE 85 — the picture never stops moving.
 *
 * Render 536 shipped a 10.6-second frozen frame. Scene 16 had ONE clip covering 7.0s of a 20.8s
 * scene; the coverage backfill went looking for five more and found none; the montage tail was
 * then filled by holding the last frame. The export's own QA counted 30 frozen segments.
 *
 * The filler is now a slow-down rather than a held frame, so the shot the narration is describing
 * stays on screen and stays in motion.
 *
 * §C does not inspect a filter string — it runs the real ffmpeg filter on a real clip and asks
 * ffmpeg's own freezedetect whether the result is frozen. A test that only compared strings would
 * pass on a filter that does not actually do what it claims.
 */

/** FPS_FORMAT_VF, verbatim from videoPipeline.ts — the chain the pad filter is prepended to. */
const FPS_FORMAT_VF = "fps=25,format=yuv420p,setsar=1,setpts=PTS-STARTPTS";

let workDir = "";
let sourceClip = "";
let ffmpegAvailable = true;

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await exec(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  return parseFloat(String(stdout).trim());
}

/**
 * How many frozen stretches ffmpeg itself finds in a file.
 *
 * freezedetect reports through stderr and ffmpeg still exits 0, so the count has to be read on
 * the success path as well — reading it only from a thrown error reports every file as clean.
 */
async function frozenSegments(file: string): Promise<number> {
  const args = ["-i", file, "-vf", "freezedetect=n=-60dB:d=0.5", "-map", "0:v", "-f", "null", "-"];
  let stderr = "";
  try {
    stderr = String((await exec(FFMPEG, args, { maxBuffer: 32 * 1024 * 1024 })).stderr ?? "");
  } catch (err) {
    stderr = String((err as { stderr?: string }).stderr ?? "");
  }
  return (stderr.match(/freeze_start/g) ?? []).length;
}

/**
 * RONDE 111 — how many genuinely NEW pictures a second the file shows.
 *
 * freezedetect answers "did the picture stop for at least d seconds", which misses the failure
 * this round is about: a stretch that holds every frame for 0.4s is a slideshow and never trips a
 * 0.5s (let alone the production 2.5s) threshold. mpdecimate drops frames that duplicate their
 * predecessor, so what survives is the real picture rate.
 */
async function distinctFramesPerSecond(file: string): Promise<number> {
  const decimated = `${file}.decimated.mp4`;
  await exec(FFMPEG, [
    "-y", "-i", file, "-vf", "mpdecimate=hi=64*12:lo=64*5:frac=0.33",
    "-vsync", "vfr", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", decimated,
  ], { maxBuffer: 32 * 1024 * 1024 });
  const { stdout } = await exec(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", decimated,
  ]);
  const frames = parseInt(String(stdout).trim(), 10);
  const seconds = await probeDuration(file);
  return seconds > 0 ? frames / seconds : 0;
}

async function renderWith(vf: string, outDur: number, name: string): Promise<string> {
  const out = path.join(workDir, `${name}.mp4`);
  await exec(FFMPEG, [
    "-y", "-i", sourceClip, "-vf", vf, "-an", "-vsync", "cfr",
    "-t", outDur.toFixed(3), "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", out,
  ]);
  return out;
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ronde85-"));
  sourceClip = path.join(workDir, "src.mp4");
  try {
    // A moving source: testsrc's clock and pattern change every frame, so anything static in the
    // output came from the filter under test and not from the input.
    await exec(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", sourceClip,
    ]);
  } catch {
    ffmpegAvailable = false;
  }
}, 120_000);

afterAll(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

/* ═════════════ §C — measured with ffmpeg, not inspected ═════════════ */

describe("RONDE 85 §C — ffmpeg's own freezedetect confirms it", () => {

  /**
   * RONDE 111 — the measurement that made the cap necessary.
   *
   * This is the case RONDE 85 believed it had solved: a gap far wider than the footage. The
   * uncapped stretch it produced is frozen by ffmpeg's own definition, which is exactly why the
   * remainder is now answered with real footage instead.
   */
  it("an UNCAPPED stretch is a slideshow — the measurement behind the 2x cap", async () => {
    expect(ffmpegAvailable).toBe(true);
    // What RONDE 85 emitted for 1.2s of footage under a 12s voice track: 10x, uncapped.
    const uncapped = await renderWith(`setpts=10.000000*PTS,${FPS_FORMAT_VF}`, 12, "uncapped");
    expect(await probeDuration(uncapped)).toBeCloseTo(12, 1);

    // There is no interpolation in the chain: setpts spreads the timeline and fps=25 fills the
    // space by repeating frames. At 10x each source frame is held for ten output frames — 0.4s —
    // so the viewer gets fewer than three new pictures a second where footage would give 25.
    const rate = await distinctFramesPerSecond(uncapped);
    expect(rate, "10x must collapse the new-picture rate").toBeLessThan(5);
    const capped = await renderWith(`setpts=2.000000*PTS,${FPS_FORMAT_VF}`, 6, "capped");
    expect(
      await distinctFramesPerSecond(capped),
      "the capped stretch must show markedly more new pictures than the uncapped one"
    ).toBeGreaterThan(rate * 2);

    /**
     * And this is why it went unnoticed for so long: postRenderSpotCheck runs freezedetect with
     * d=2.5, and even at d=0.5 a 0.4-second hold does not reach the threshold. The render's own
     * QA reports a clean file. The number to watch is the one above, not this one.
     */
    expect(await frozenSegments(uncapped)).toBe(0);
  }, 180_000);
});
