/**
 * VIDEO 649 — the transition graph states its own converter per input (see `transitionInputNormalizer`),
 * so a mid-segment property change no longer fails the join in front of `xfade`.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildTransitionGraph, transitionInputNormalizer, SAME_COLOUR_TAGS } from "./timelineFilters";
import { resolveFFmpegBin } from "./ffmpegBinary";

const run = promisify(execFile);
const RENDERER = fs.readFileSync(path.join(__dirname, "timelineRenderer.ts"), "utf8");
const FILTERS = fs.readFileSync(path.join(__dirname, "timelineFilters.ts"), "utf8");
const DISSOLVES = { durations: [4, 4, 4], transitions: [{ kind: "hard_cut" }, { kind: "dissolve", durationSec: 0.5 }, { kind: "dissolve", durationSec: 0.5 }] };
const NORM = { widthPx: 1920, heightPx: 1080, fps: 30 };

describe("the normaliser", () => {
  it("scales to the film's frame, square pixels, yuv420p, the film's frame rate", () => {
    expect(transitionInputNormalizer(NORM)).toBe("scale=1920:1080:flags=bicubic,setsar=1,format=yuv420p,fps=30,");
    expect(transitionInputNormalizer({ widthPx: 1280, heightPx: 720, fps: 29.97 })).toBe("scale=1280:720:flags=bicubic,setsar=1,format=yuv420p,fps=29.97,");
    expect(transitionInputNormalizer({ widthPx: 1920, heightPx: 1080, fps: 0 })).toContain("fps=30,");
  });
  it("without `normalize` the graph is byte-for-byte what it was", () => {
    const g = buildTransitionGraph(DISSOLVES)!;
    expect(g.filter).toContain(`[0:v]settb=AVTB,${SAME_COLOUR_TAGS}[t0]`);
    expect(g.filter).not.toContain("scale=");
    const cut = buildTransitionGraph({ ...DISSOLVES, step: "cut" })!;
    expect(cut.filter).toContain(`[1:v]trim=start=0.500,setpts=PTS-STARTPTS,settb=AVTB,${SAME_COLOUR_TAGS}[t1]`);
  });
  it("with `normalize` every input, on every rung, is converted before anything else; the joins and the total are unchanged", () => {
    const plain = buildTransitionGraph(DISSOLVES)!;
    const g = buildTransitionGraph({ ...DISSOLVES, normalize: NORM })!;
    for (let i = 0; i < 3; i++) expect(g.filter).toContain(`[${i}:v]scale=1920:1080:flags=bicubic,setsar=1,format=yuv420p,fps=30,settb=AVTB,${SAME_COLOUR_TAGS}[t${i}]`);
    expect(g.totalSec).toBe(plain.totalSec);
    expect(g.filter.split(";").slice(3)).toEqual(plain.filter.split(";").slice(3));
    const cut = buildTransitionGraph({ ...DISSOLVES, step: "cut", normalize: NORM })!;
    expect(cut.filter).toContain(`[1:v]scale=1920:1080:flags=bicubic,setsar=1,format=yuv420p,fps=30,trim=start=0.500,setpts=PTS-STARTPTS,settb=AVTB,${SAME_COLOUR_TAGS}[t1]`);
    expect(cut.totalSec).toBe(buildTransitionGraph({ ...DISSOLVES, step: "cut" })!.totalSec);
  });
  it("wiring: the renderer passes the film's frame to the planned graph and to every ladder rung; the join logs at warning level so a 'frame changed' line reaches the failure summary", () => {
    expect(RENDERER).toContain("const graphNormalize = { widthPx: fmt.widthPx, heightPx: fmt.heightPx, fps: fmt.fps };");
    expect(RENDERER).toContain("    normalize: graphNormalize,");
    expect(RENDERER).toContain("buildTransitionGraph({ durations: graphDurations, transitions: graphTransitions, step, normalize: graphNormalize });");
    const args = RENDERER.slice(RENDERER.indexOf("const argsFor = (filter: string): string[] => {"), RENDERER.indexOf("const diagnoseSegmentShapes"));
    expect(args).toContain('const a = ["-y", "-hide_banner", "-loglevel", "warning"];');
    /** every input is opened with graph re-initialisation off — the other half of the fix */
    expect(args).toContain('for (const seg of segments) a.push("-reinit_filter", "0", "-i", seg);');
    expect(FILTERS).toContain("`[${i}:v]settb=AVTB,${SAME_COLOUR_TAGS}[t${i}]`");
  });
});

describe("a real join: three segments, one of which changes size and pixel format mid-stream", () => {
  let dir = "";
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-649-xfade-")); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const colour = async (file: string, c: string, size: string, sec: number) => {
    await run(resolveFFmpegBin(), ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${c}:s=${size}:d=${sec}:r=30`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  };

  it("the planned dissolves render with the normaliser where ffmpeg's own converter had to reconfigure", async () => {
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
    const inputs = (files: string[]) => files.flatMap((f) => ["-reinit_filter", "0", "-i", f]);
    await run(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "warning", ...inputs([a, b, c]),
      "-filter_complex", g.filter, "-map", "[vout]", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", out,
    ]);
    expect(fs.existsSync(out)).toBe(true);
    const durationOf = async (file: string) => {
      const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
      return Number.parseFloat(String(probe.stdout));
    };
    /** the whole film, including the second that follows the change */
    expect(await durationOf(out)).toBeGreaterThan(g.totalSec - 0.3);
    /** the frame after the change is the film's frame, and it is the yellow of the changed stream, not a dropped tail */
    const shape = await run("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]);
    expect(String(shape.stdout).trim()).toBe("640,360");
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
