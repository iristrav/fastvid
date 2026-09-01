import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { montageTailPadFilterChain, montageTailPadVF } from "./videoPipeline";

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

/* ═════════════ §A — the filter no longer freezes ═════════════ */

describe("RONDE 85 §A — the tail filler is a slow-down, not a held frame", () => {
  /**
   * SUPERSEDED BY RONDE 111 — the same goal, reached without the trap this version walked into.
   *
   * RONDE 85 removed the held frame by slowing the montage instead, and left the ratio uncapped
   * on purpose: a cap leaves a remainder, and the only fillers for a remainder were the two this
   * round existed to delete. Measured later against real ffmpeg, with no interpolation anywhere
   * in the chain, that was a freeze arriving through a different filter:
   *
   *     1.5x → each picture holds 0.10s     6x  → 0.32s
   *     3.0x → 0.18s                        10x → 0.59s
   *
   * So the ratio is capped at 2x. Under the cap this round's behaviour is unchanged, which is
   * what these two now assert; over it, the answer has to be real footage, which is why the
   * coverage backfill spends its extra searches exactly there (see RONDE 111).
   */
  it("a short montage is stretched to the voice length", () => {
    const chain = montageTailPadFilterChain(6, 8, "test");
    expect(chain).toContain("setpts=");
    expect(chain).toContain("*PTS,");
    expect(chain, "the held frame is gone").not.toContain("tpad=stop_mode=clone");
  });

  it("the ratio is the gap it has to fill, up to the 2x cap", () => {
    // 6s of footage under an 8s voice track runs at 8/6 = 1.333333x its own length.
    expect(montageTailPadFilterChain(6, 8, "test")).toBe("setpts=1.333333*PTS,");
    expect(montageTailPadFilterChain(10, 12, "test")).toBe("setpts=1.200000*PTS,");
    expect(montageTailPadFilterChain(20, 20.5, "test")).toBe("setpts=1.025000*PTS,");
    // Exactly at the cap is still pure slowing.
    expect(montageTailPadFilterChain(4, 8, "test")).toBe("setpts=2.000000*PTS,");
  });

  it("the whole video-filter chain keeps its shape", () => {
    const vf = montageTailPadVF("mont", 7, 20.8);
    expect(vf.startsWith("[mont]")).toBe(true);
    expect(vf.endsWith("[vmont]")).toBe(true);
    // The slow-down must come BEFORE fps=25, which then resamples the stretched timeline.
    expect(vf.indexOf("setpts=") < vf.indexOf("fps=25")).toBe(true);
  });

  it("a montage that already covers the voice is left completely alone", () => {
    expect(montageTailPadVF("mont", 20, 20)).toBe(`[mont]${FPS_FORMAT_VF}[vmont]`);
    expect(montageTailPadVF("mont", 21, 20)).toBe(`[mont]${FPS_FORMAT_VF}[vmont]`);
    // Below the 0.08s threshold nothing is inserted either.
    expect(montageTailPadVF("mont", 19.99, 20)).toBe(`[mont]${FPS_FORMAT_VF}[vmont]`);
  });
});

/* ═════════════ §B — the escape hatches and the edge case ═════════════ */

describe("RONDE 85 §B — overrides and a zero-length montage", () => {
  const withEnv = (value: string | undefined, fn: () => void) => {
    const previous = process.env.MONTAGE_TAIL_PAD;
    if (value === undefined) delete process.env.MONTAGE_TAIL_PAD;
    else process.env.MONTAGE_TAIL_PAD = value;
    try { fn(); } finally {
      if (previous === undefined) delete process.env.MONTAGE_TAIL_PAD;
      else process.env.MONTAGE_TAIL_PAD = previous;
    }
  };

  it("MONTAGE_TAIL_PAD=freeze restores the held frame", () => {
    withEnv("freeze", () => {
      expect(montageTailPadFilterChain(3, 8, "test")).toContain("tpad=stop_mode=clone");
    });
  });

  it("MONTAGE_TAIL_PAD=grey restores the rectangle", () => {
    withEnv("grey", () => {
      expect(montageTailPadFilterChain(3, 8, "test")).toContain("tpad=stop_mode=add");
    });
  });

  it("the default — no variable set — is the slow-down", () => {
    withEnv(undefined, () => {
      expect(montageTailPadFilterChain(3, 8, "test")).toContain("setpts=");
    });
  });

  it("a zero-length montage cannot be stretched, and does not divide by zero", () => {
    // There is nothing to slow down, so this one case keeps the old filler rather than emitting
    // setpts=Infinity*PTS.
    const chain = montageTailPadFilterChain(0, 8, "test");
    expect(chain).toContain("tpad=stop_mode=clone");
    expect(chain).not.toContain("Infinity");
    expect(chain).not.toContain("NaN");
  });

  it("no ratio is ever NaN or Infinity for a real montage", () => {
    for (const [dur, target] of [[0.06, 30], [0.5, 25], [1, 60], [19, 20]] as const) {
      const chain = montageTailPadFilterChain(dur, target, "test");
      expect(chain).not.toContain("NaN");
      expect(chain).not.toContain("Infinity");
      expect(chain.endsWith(",")).toBe(true);
    }
  });
});

/* ═════════════ §C — measured with ffmpeg, not inspected ═════════════ */

describe("RONDE 85 §C — ffmpeg's own freezedetect confirms it", () => {
  it("the old filler produced a frozen frame and the new one does not", async () => {
    expect(ffmpegAvailable, "ffmpeg unavailable in this environment").toBe(true);

    // Same 3-second source, same 6-second target (2x — within RONDE 111's cap), both fillers.
    const held = await renderWith(
      `tpad=stop_mode=clone:stop_duration=3.000,${FPS_FORMAT_VF}`, 6, "held"
    );
    const slowed = await renderWith(
      `${montageTailPadFilterChain(3, 6, "test")}${FPS_FORMAT_VF}`, 6, "slowed"
    );

    // Both fill the voice track exactly — the fix must not shorten the scene.
    expect(await probeDuration(held)).toBeCloseTo(6, 1);
    expect(await probeDuration(slowed)).toBeCloseTo(6, 1);

    // And this is the whole point of the round.
    expect(await frozenSegments(held), "the old filler should freeze — otherwise this test proves nothing")
      .toBeGreaterThan(0);
    expect(await frozenSegments(slowed), "the new filler must not freeze").toBe(0);
  }, 180_000);

  it("slowing within the cap keeps moving", async () => {
    expect(ffmpegAvailable).toBe(true);
    // The source really is 3 seconds, so the filter has to be asked for a 3s montage.
    const vf = `${montageTailPadFilterChain(3, 6, "test")}${FPS_FORMAT_VF}`;
    const out = await renderWith(vf, 6, "wide");
    expect(await probeDuration(out)).toBeCloseTo(6, 1);
    expect(await frozenSegments(out), "a 2x stretch must keep moving").toBe(0);
    /**
     * ...and it is still real motion. Measured against the SOURCE's own picture rate rather than
     * an absolute number: mpdecimate's threshold makes the absolute count depend on the material,
     * so only the ratio between the two is meaningful. At 2x, half the source's rate is the
     * arithmetic floor and anything near it is honest slow motion.
     */
    const sourceRate = await distinctFramesPerSecond(sourceClip);
    expect(await distinctFramesPerSecond(out)).toBeGreaterThan(sourceRate * 0.4);
  }, 180_000);

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

/* ═════════════ §D — nothing else in compose moved ═════════════ */

describe("RONDE 85 §D — the rest of the compose path is untouched", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("clone-padding exists in exactly two places, both of them named", () => {
    /**
     * SUPERSEDED BY RONDE 111: there are two now, and that is the design rather than a leak.
     *   1. the MONTAGE_TAIL_PAD=freeze operator override, unchanged;
     *   2. the remainder after slowing has been capped at 2x — the absolute last technical
     *      fallback, reached only when every search, the short-clip round and re-using the
     *      scene's own footage in motion have all come back empty.
     * A third would be a leak, which is what this still guards.
     */
    const occurrences = (SRC.match(/tpad=stop_mode=clone/g) ?? []).length;
    expect(occurrences, "a third freeze site would defeat the round").toBe(2);
    const first = SRC.indexOf("tpad=stop_mode=clone");
    expect(SRC.slice(Math.max(0, first - 700), first)).toContain('mode === "freeze"');
    const second = SRC.indexOf("tpad=stop_mode=clone", first + 1);
    expect(SRC.slice(Math.max(0, second - 900), second)).toContain(
      "The absolute last technical fallback."
    );
  });

  it("the single-clip montage fills its gap too", () => {
    // It used to skip the filler entirely under strictNoVisualRepeat, leaving the scene short of
    // its own voice track. Slowing repeats nothing, so that guard is gone.
    const idx = SRC.indexOf("Scene ${sceneIndex} single-clip montage");
    expect(idx).toBeGreaterThan(-1);
    const block = SRC.slice(idx - 600, idx + 120);
    expect(block).toContain("pad >= 0.08");
    expect(block).not.toContain("pad >= 0.08 && !strictNoVisualRepeat()");
  });

  it("both callers hand over a real montage duration, not just the gap", () => {
    // The ratio needs the montage's own length; passing only the pad would silently produce a
    // wrong stretch.
    expect(SRC).toContain("montageTailPadFilterChain(\n    montageDur,\n    montageDur + pad,");
    expect(SRC).toContain("montageTailPadFilterChain(est, est + pad,");
  });
});
