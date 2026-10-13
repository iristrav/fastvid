/**
 * VIDEO 650 — THE FILM IS 30 FRAMES A SECOND, WHICHEVER RUNG JOINED IT.
 *
 * Render 650 was refused by its own quality check: "fps 25 ≠ 30". Every rung of the transition
 * ladder had failed and the picture was joined by the cut rung, whose graph trims each input and
 * resets its timestamps AFTER the frame-rate normaliser. On the bundled ffmpeg 7.0.2 that leaves
 * the frame rate unknown and the encoder falls back to 25 — and really produces 25 frames a second
 * (five of every six), not just a wrong label. The encode now states the timeline's frame rate.
 *
 * Measured here with real segments, the real graph builder and the renderer's own encode arguments,
 * on the ffmpeg build the worker runs: r_frame_rate, avg_frame_rate and the frame count all agree
 * with the timeline for the cut rung, the planned rung and the segment encode.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveFFmpegBin } from "./ffmpegBinary";
import { buildTransitionGraph } from "./timelineFilters";
import { transitionGraphEncodeArgs } from "./timelineRenderer";

const run = promisify(execFile);
const FFMPEG = resolveFFmpegBin();
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const FPS = 30;
const W = 1280;
const H = 720;

let dir: string;
const segments: string[] = [];

async function probeRates(file: string): Promise<{ r: number; avg: number; frames: number; durationSec: number }> {
  /** keyed output: ffprobe prints entries in the stream's own field order, not the asked one */
  const { stdout } = await run(FFPROBE, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=r_frame_rate,avg_frame_rate,nb_frames,duration",
    "-of", "json", file,
  ]);
  const st = (JSON.parse(stdout).streams ?? [])[0] ?? {};
  const rational = (x: string) => { const [n, d] = String(x).split("/").map(Number); return d ? n / d : NaN; };
  return { r: rational(st.r_frame_rate), avg: rational(st.avg_frame_rate), frames: Number(st.nb_frames), durationSec: Number(st.duration) };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-650-fps-"));
  /** Three segments as the renderer makes them: the timeline's size and rate; the second and third carry a 0.5 s handle. */
  for (let i = 0; i < 3; i++) {
    const seg = path.join(dir, `seg_${i}.mp4`);
    const seconds = i === 0 ? 3.08 : 3.58;
    await run(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=${FPS}:duration=${seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", seg,
    ]);
    segments.push(seg);
  }
}, 120_000);

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const DISSOLVES = {
  durations: [3.08, 3.08 + 0.5, 3.08 + 0.5],
  transitions: [{ kind: "hard_cut" }, { kind: "dissolve", durationSec: 0.5 }, { kind: "dissolve", durationSec: 0.5 }],
  normalize: { widthPx: W, heightPx: H, fps: FPS },
};

describe("the encode states the frame rate", () => {
  it("transitionGraphEncodeArgs carries -r <fps>, one decoder thread per input and one filter thread", () => {
    const args = transitionGraphEncodeArgs({ segments: ["a.mp4", "b.mp4"], filter: "[0:v][1:v]concat[vout]", output: "o.mp4", fps: FPS });
    expect(args.slice(0, 8)).toEqual(["-y", "-hide_banner", "-loglevel", "warning", "-filter_threads", "1", "-filter_complex_threads", "1"]);
    expect(args).toContain("-r");
    expect(args[args.indexOf("-r") + 1]).toBe("30");
    expect(args.filter((a) => a === "-threads").length).toBe(2);
    expect(args.indexOf("-r")).toBeLessThan(args.indexOf("-c:v"));
  });

  it("THE CUT RUNG — trim,setpts after the normaliser — RENDERS AT THE TIMELINE'S RATE on the worker's ffmpeg", async () => {
    const cut = buildTransitionGraph({ ...DISSOLVES, step: "cut" });
    expect(cut).not.toBeNull();
    expect(cut!.filter).toContain("trim=start=0.500,setpts=PTS-STARTPTS");
    const out = path.join(dir, "cut.mp4");
    await run(FFMPEG, transitionGraphEncodeArgs({ segments, filter: cut!.filter, output: out, fps: FPS }), { maxBuffer: 16 * 1024 * 1024 });
    const got = await probeRates(out);
    expect(got.r).toBeCloseTo(FPS, 2);
    expect(got.avg).toBeCloseTo(FPS, 1);
    /** the frame COUNT agrees with the length: 25 fps would give five sixths of these */
    expect(Math.abs(got.frames - cut!.totalSec * FPS)).toBeLessThanOrEqual(2);
    expect(Math.abs(got.durationSec - cut!.totalSec)).toBeLessThan(0.15);
  }, 120_000);

  it("and the same graph WITHOUT the stated rate is what 650 produced: 25 fps, with frames missing (the defect, kept as a measurement)", async () => {
    const cut = buildTransitionGraph({ ...DISSOLVES, step: "cut" })!;
    const out = path.join(dir, "cut_no_r.mp4");
    const args = transitionGraphEncodeArgs({ segments, filter: cut.filter, output: out, fps: FPS });
    const i = args.indexOf("-r");
    args.splice(i, 2);
    await run(FFMPEG, args, { maxBuffer: 16 * 1024 * 1024 });
    const got = await probeRates(out);
    /** either the build loses the rate (7.0.x: 25) or keeps it (5.1/6.1: 30); the stated rate removes the difference */
    expect([25, 30].some((v) => Math.abs(got.r - v) < 0.01)).toBe(true);
    if (Math.abs(got.r - 25) < 0.01) expect(got.frames).toBeLessThan(cut.totalSec * FPS - 20);
  }, 120_000);

  it("the planned rung (xfade) renders at the timeline's rate too", async () => {
    const planned = buildTransitionGraph({ ...DISSOLVES })!;
    const out = path.join(dir, "planned.mp4");
    await run(FFMPEG, transitionGraphEncodeArgs({ segments, filter: planned.filter, output: out, fps: FPS }), { maxBuffer: 16 * 1024 * 1024 });
    const got = await probeRates(out);
    expect(got.r).toBeCloseTo(FPS, 2);
    expect(got.avg).toBeCloseTo(FPS, 1);
    expect(Math.abs(got.frames - planned.totalSec * FPS)).toBeLessThanOrEqual(2);
  }, 120_000);
});
