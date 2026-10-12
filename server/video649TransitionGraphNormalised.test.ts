/**
 * VIDEO 649 — THE TRANSITION GRAPH LEAVES FFMPEG NOTHING TO INSERT.
 *
 * Every production render since at least 6 October failed its transitions with
 * "[auto_scale_N] Failed to configure output pad … Error reinitializing filters!" and shipped with
 * cuts. `xfade` works in 4:4:4 only, so ffmpeg inserted a converter of its own at every join input
 * and one at the end, and the production build (Debian's 5.1) refused to configure one of them.
 * With `normalize` the graph states every conversion itself: the test below counts ffmpeg's
 * "auto-inserting filter" lines on a production-shaped graph and expects none.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildTransitionGraph,
  transitionInputNormalizer,
  transitionOutputConverter,
  SAME_COLOUR_TAGS,
  TRANSITION_CHAIN_PIX_FMT,
  TRANSITION_OUTPUT_PIX_FMT,
} from "./timelineFilters";
import { alternateFFmpegBin, isGraphConfigurationRefusal, resolveFFmpegBin, staticFFmpegPath } from "./ffmpegBinary";

const run = promisify(execFile);
const RENDERER = fs.readFileSync(path.join(__dirname, "timelineRenderer.ts"), "utf8");
const FILTERS = fs.readFileSync(path.join(__dirname, "timelineFilters.ts"), "utf8");
const DOCKERFILE = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
const DISSOLVES = { durations: [4, 4, 4], transitions: [{ kind: "hard_cut" }, { kind: "dissolve", durationSec: 0.5 }, { kind: "dissolve", durationSec: 0.5 }] };
const NORM = { widthPx: 1920, heightPx: 1080, fps: 30 };
const HEAD = "scale=1920:1080:flags=bicubic,setsar=1,fps=30,";

describe("the stated conversions", () => {
  it("the input head: the film's frame, square pixels, the film's rate — the pixel format is set at the tail", () => {
    expect(transitionInputNormalizer(NORM)).toBe(HEAD);
    expect(transitionInputNormalizer({ widthPx: 1280, heightPx: 720, fps: 29.97 })).toBe("scale=1280:720:flags=bicubic,setsar=1,fps=29.97,");
    expect(transitionInputNormalizer({ widthPx: 1920, heightPx: 1080, fps: 0 })).toContain("fps=30,");
    expect(transitionOutputConverter(NORM)).toBe("scale=1920:1080:flags=bicubic,format=yuv420p");
    expect(TRANSITION_CHAIN_PIX_FMT).toBe("yuv444p");
    expect(TRANSITION_OUTPUT_PIX_FMT).toBe("yuv420p");
  });
  it("without `normalize` the graph is byte-for-byte what it was", () => {
    const g = buildTransitionGraph(DISSOLVES)!;
    expect(g.filter).toContain(`[0:v]settb=AVTB,${SAME_COLOUR_TAGS}[t0]`);
    expect(g.filter).not.toContain("scale=");
    expect(g.filter).not.toContain("format=");
    expect(g.filter.endsWith("[vout]")).toBe(true);
    const cut = buildTransitionGraph({ ...DISSOLVES, step: "cut" })!;
    expect(cut.filter).toContain(`[1:v]trim=start=0.500,setpts=PTS-STARTPTS,settb=AVTB,${SAME_COLOUR_TAGS}[t1]`);
  });
  it("with `normalize` the xfade rungs run in 4:4:4 and are converted back after the last join; the joins and the total are unchanged", () => {
    const plain = buildTransitionGraph(DISSOLVES)!;
    for (const step of ["planned", "simple"] as const) {
      const g = buildTransitionGraph({ ...DISSOLVES, step, normalize: NORM })!;
      for (let i = 0; i < 3; i++) expect(g.filter).toContain(`[${i}:v]${HEAD}settb=AVTB,${SAME_COLOUR_TAGS},format=yuv444p[t${i}]`);
      expect(g.totalSec).toBe(plain.totalSec);
      const steps = g.filter.split(";");
      expect(steps[steps.length - 1]).toBe("[vjoin]scale=1920:1080:flags=bicubic,format=yuv420p[vout]");
      /** the joins themselves: the plain graph's, with the last one writing to the converter instead of the sink */
      const plainJoins = buildTransitionGraph({ ...DISSOLVES, step })!.filter.split(";").slice(3);
      expect(steps.slice(3, -1)).toEqual(plainJoins.map((j, k, all) => (k === all.length - 1 ? j.replace("[vout]", "[vjoin]") : j)));
    }
    /** the cut rung has no xfade: it stays yuv420p and needs no way back */
    const cut = buildTransitionGraph({ ...DISSOLVES, step: "cut", normalize: NORM })!;
    expect(cut.filter).toContain(`[1:v]${HEAD}trim=start=0.500,setpts=PTS-STARTPTS,settb=AVTB,${SAME_COLOUR_TAGS},format=yuv420p[t1]`);
    expect(cut.filter).not.toContain("yuv444p");
    expect(cut.filter).not.toContain("[vjoin]");
    expect(cut.filter.endsWith("[vout]")).toBe(true);
    expect(cut.totalSec).toBe(buildTransitionGraph({ ...DISSOLVES, step: "cut" })!.totalSec);
  });
  it("wiring: the renderer passes the film's frame to the planned graph and to every ladder rung; the join logs at warning level with graph re-initialisation off", () => {
    expect(RENDERER).toContain("const graphNormalize = { widthPx: fmt.widthPx, heightPx: fmt.heightPx, fps: fmt.fps };");
    expect(RENDERER).toContain("    normalize: graphNormalize,");
    expect(RENDERER).toContain("buildTransitionGraph({ durations: graphDurations, transitions: graphTransitions, step, normalize: graphNormalize });");
    const args = RENDERER.slice(RENDERER.indexOf("const argsFor = (filter: string): string[] => {"), RENDERER.indexOf("const diagnoseSegmentShapes"));
    expect(args).toContain('const a = ["-y", "-hide_banner", "-loglevel", "warning"];');
    expect(args).toContain('for (const seg of segments) a.push("-reinit_filter", "0", "-i", seg);');
    expect(FILTERS).toContain("`[${i}:v]settb=AVTB,${SAME_COLOUR_TAGS}[t${i}]`");
  });
});

describe("the other build on this host, for a graph this build cannot configure", () => {
  it("the refusal is recognised narrowly: a scale/format pad that would not configure, nothing else", () => {
    expect(isGraphConfigurationRefusal("[auto_scale_9] Failed to configure output pad on auto_scale_9 | Error reinitializing filters!")).toBe(true);
    expect(isGraphConfigurationRefusal("[Parsed_scale_3] Failed to configure output pad on Parsed_scale_3")).toBe(true);
    expect(isGraphConfigurationRefusal("[Parsed_xfade_12] Failed to configure output pad on Parsed_xfade_12")).toBe(false);
    expect(isGraphConfigurationRefusal("No such filter: 'xfade'")).toBe(false);
    expect(isGraphConfigurationRefusal("")).toBe(false);
    expect(isGraphConfigurationRefusal(null)).toBe(false);
  });
  it("the alternate is never the binary in use, and is one that runs", () => {
    const current = resolveFFmpegBin();
    const alt = alternateFFmpegBin(current);
    if (alt) {
      expect(fs.realpathSync(alt)).not.toBe(fs.realpathSync(current));
      expect(fs.existsSync(alt)).toBe(true);
    }
    /** asked from the bundled build's point of view, a system build (when present) is the other one */
    const fromStatic = alternateFFmpegBin(staticFFmpegPath());
    if (fromStatic) expect(fs.realpathSync(fromStatic)).not.toBe(fs.realpathSync(staticFFmpegPath()));
  });
  it("wiring: the ladder retries the same rung once with the other build, only on that refusal, and says so", () => {
    const ladder = RENDERER.slice(RENDERER.indexOf("for (const step of TRANSITION_LADDER) {"), RENDERER.indexOf("transitionsRendered = rendered.filter("));
    expect(ladder).toContain("const alt = isGraphConfigurationRefusal(said) ? alternateFFmpegBin() : null;");
    expect(ladder).toContain("await runFfmpeg(argsFor(rung.filter), `transition graph (${step}, other build)`, alt);");
    expect(ladder).toContain("joinedByOtherBuild = alt;");
    expect(ladder).toContain("[TransitionLadder] RENDERED BY OTHER BUILD");
    expect(ladder).toContain("skipped.push(line);");
    /** the ladder's own order is untouched: a refusal the other build cannot help goes plainer as before */
    expect(ladder).toContain("if (step === TRANSITION_LADDER[TRANSITION_LADDER.length - 1]) throw firstFailure;");
    expect(RENDERER).toContain("async function runFfmpeg(args: string[], what: string, bin: string = ffmpeg()): Promise<void> {");
    /** the bundled build is fetched in the image, and a failed fetch never fails the build */
    expect(DOCKERFILE).toContain("RUN node node_modules/ffmpeg-static/install.js");
    expect(DOCKERFILE).toContain('|| echo "[Dockerfile] ffmpeg-static binary not fetched');
  });
});

/* ═══════════════════ real joins ═══════════════════ */

const colour = async (file: string, c: string, size: string, sec: number, extra: string[] = []) => {
  await run(resolveFFmpegBin(), [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${c}:s=${size}:d=${sec}:r=30`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...extra, file,
  ]);
};
const durationOf = async (file: string) => {
  const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number.parseFloat(String(probe.stdout));
};
const inputs = (files: string[]) => files.flatMap((f) => ["-reinit_filter", "0", "-i", f]);

describe("a production-shaped join: twenty segments, five dissolves, the rest hard cuts", () => {
  let dir = "";
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-649-xfade20-")); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("with `normalize` ffmpeg inserts no converter of its own; without it, one at every join input and one at the end", async () => {
    const files: string[] = [];
    for (let i = 0; i < 20; i++) {
      const f = path.join(dir, `seg_${String(i).padStart(3, "0")}.mp4`);
      /** the production segments: 1080p yuv420p, bt709 primaries/transfer tagged, colour space unknown */
      await colour(f, `0x${((i * 12) & 255).toString(16).padStart(2, "0")}80${((255 - i * 12) & 255).toString(16).padStart(2, "0")}`, "1920x1080", 1.2, ["-color_primaries", "bt709", "-color_trc", "bt709"]);
      files.push(f);
    }
    const durations = files.map(() => 1.2);
    const transitions = files.map((_, i) => (i > 0 && i % 4 === 3 ? { kind: "dissolve", durationSec: 0.3 } : { kind: "hard_cut" }));
    const graph = buildTransitionGraph({ durations, transitions, normalize: NORM })!;
    expect(graph.filter.split("xfade=").length - 1).toBe(5);
    const plain = buildTransitionGraph({ durations, transitions })!;

    const join = async (filter: string, out: string) => {
      const r = await run(resolveFFmpegBin(), [
        "-y", "-hide_banner", "-loglevel", "verbose", ...inputs(files), "-filter_complex", filter, "-map", "[vout]",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", out,
      ], { maxBuffer: 64 * 1024 * 1024 });
      return String(r.stderr);
    };
    const stated = await join(graph.filter, path.join(dir, "stated.mp4"));
    expect(stated.match(/auto-inserting filter/g) ?? []).toHaveLength(0);
    expect(await durationOf(path.join(dir, "stated.mp4"))).toBeGreaterThan(graph.totalSec - 0.2);

    const left = await join(plain.filter, path.join(dir, "plain.mp4"));
    /** the control: the same joins left to ffmpeg — 5 xfades × 2 inputs + 9 concat inputs + the way back = 19 auto scalers */
    expect((left.match(/auto-inserting filter 'auto_scale_\d+'/g) ?? []).length).toBeGreaterThanOrEqual(11);
    expect(left).toContain("fmt:yuv420p");
    expect(left).toMatch(/auto_scale_\d+.*-> w:1920 h:1080 fmt:yuv444p/);
  }, 300_000);
});

describe("a real join: three segments, one of which changes size and pixel format mid-stream", () => {
  let dir = "";
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-649-xfade-")); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("the planned dissolves render in full with the stated conversions and re-initialisation off", async () => {
    const a = path.join(dir, "a.mp4"), b = path.join(dir, "b.mp4"), c1 = path.join(dir, "c1.mp4"), c2 = path.join(dir, "c2.mp4"), c = path.join(dir, "c.mp4");
    await colour(a, "red", "640x360", 2);
    await colour(b, "green", "640x360", 2);
    /** the third segment is two files of different size and pixel format concatenated by stream copy: its frames change mid-stream */
    await colour(c1, "blue", "640x360", 1);
    await run(resolveFFmpegBin(), ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=yellow:s=320x180:d=1:r=30", "-c:v", "libx264", "-pix_fmt", "yuv444p", c2]);
    const list = path.join(dir, "list.txt");
    fs.writeFileSync(list, `file '${c1}'\nfile '${c2}'\n`);
    await run(resolveFFmpegBin(), ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", c]);
    const durations = [2, 2, 2];
    const transitions = [{ kind: "hard_cut" }, { kind: "dissolve", durationSec: 0.5 }, { kind: "dissolve", durationSec: 0.5 }];
    const g = buildTransitionGraph({ durations, transitions, normalize: { widthPx: 640, heightPx: 360, fps: 30 } })!;
    const out = path.join(dir, "joined.mp4");
    await run(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "warning", ...inputs([a, b, c]),
      "-filter_complex", g.filter, "-map", "[vout]", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", out,
    ]);
    expect(fs.existsSync(out)).toBe(true);
    /** the whole film, including the second that follows the change */
    expect(await durationOf(out)).toBeGreaterThan(g.totalSec - 0.3);
    /** the frame after the change is the film's frame, and it is the yellow of the changed stream, not a dropped tail */
    const shape = await run("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height,pix_fmt", "-of", "csv=p=0", out]);
    expect(String(shape.stdout).trim()).toBe("640,360,yuv420p");
    const tail = await run(
      resolveFFmpegBin(),
      ["-v", "error", "-ss", String(g.totalSec - 0.2), "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }
    );
    const px = tail.stdout as Buffer;
    const n = Math.floor(px.length / 3);
    const mean = [0, 1, 2].map((k) => { let t = 0; for (let i = k; i < n * 3; i += 3) t += px[i]; return t / n; });
    expect(mean[0]).toBeGreaterThan(200);
    expect(mean[1]).toBeGreaterThan(200);
    expect(mean[2]).toBeLessThan(60);

    /** and the control: the same join WITHOUT `-reinit_filter 0` ends early — the film silently loses its tail */
    const control = path.join(dir, "control.mp4");
    await run(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "warning", "-i", a, "-i", b, "-i", c,
      "-filter_complex", g.filter, "-map", "[vout]", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", control,
    ]);
    expect(await durationOf(control)).toBeLessThan(g.totalSec - 0.5);
  }, 120_000);
});
