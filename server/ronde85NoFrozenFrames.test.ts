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
  it("a short montage is stretched to the voice length", () => {
    const chain = montageTailPadFilterChain(3, 8, "test");
    expect(chain).toContain("setpts=");
    expect(chain).toContain("*PTS,");
    expect(chain, "the held frame is gone").not.toContain("tpad=stop_mode=clone");
  });

  it("the ratio is the gap it has to fill", () => {
    // 3s of footage under an 8s voice track has to run at 8/3 = 2.666667x its own length.
    expect(montageTailPadFilterChain(3, 8, "test")).toBe("setpts=2.666667*PTS,");
    expect(montageTailPadFilterChain(10, 12, "test")).toBe("setpts=1.200000*PTS,");
    expect(montageTailPadFilterChain(20, 20.5, "test")).toBe("setpts=1.025000*PTS,");
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

    // Same 3-second source, same 8-second target, both fillers.
    const held = await renderWith(
      `tpad=stop_mode=clone:stop_duration=5.000,${FPS_FORMAT_VF}`, 8, "held"
    );
    const slowed = await renderWith(
      `${montageTailPadFilterChain(3, 8, "test")}${FPS_FORMAT_VF}`, 8, "slowed"
    );

    // Both fill the voice track exactly — the fix must not shorten the scene.
    expect(await probeDuration(held)).toBeCloseTo(8, 1);
    expect(await probeDuration(slowed)).toBeCloseTo(8, 1);

    // And this is the whole point of the round.
    expect(await frozenSegments(held), "the old filler should freeze — otherwise this test proves nothing")
      .toBeGreaterThan(0);
    expect(await frozenSegments(slowed), "the new filler must not freeze").toBe(0);
  }, 180_000);

  it("a large gap still produces moving picture", async () => {
    expect(ffmpegAvailable).toBe(true);
    // Scene 16 from render 536: 7.0s of footage under a 20.8s voice track, ratio ~2.97x.
    const vf = `${montageTailPadFilterChain(3, 12, "test")}${FPS_FORMAT_VF}`;
    const out = await renderWith(vf, 12, "wide");
    expect(await probeDuration(out)).toBeCloseTo(12, 1);
    expect(await frozenSegments(out), "even a 4x stretch must keep moving").toBe(0);
  }, 180_000);
});

/* ═════════════ §D — nothing else in compose moved ═════════════ */

describe("RONDE 85 §D — the rest of the compose path is untouched", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("the only remaining clone-pad is behind the explicit override", () => {
    const occurrences = (SRC.match(/tpad=stop_mode=clone/g) ?? []).length;
    expect(occurrences, "a second freeze site would defeat the round").toBe(1);
    const idx = SRC.indexOf("tpad=stop_mode=clone");
    const guard = SRC.slice(Math.max(0, idx - 700), idx);
    expect(guard).toContain('mode === "freeze"');
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
