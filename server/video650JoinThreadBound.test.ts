/**
 * VIDEO 650 — the transition join's thread count is bounded by its INPUT COUNT, not by the host.
 *
 * Video 650's cut join took 27 inputs into one filter graph. Each input opened its own decoder with
 * ffmpeg's automatic thread count (cores × decoder parallelism), and the graph joined them with a
 * filter pool of its own, so the one process reached more than 300 threads on a 4-core host. On a
 * Railway worker with a pids ceiling that is `EAGAIN` from `pthread_create`, and the join dies with a
 * message that names nothing.
 *
 * `transitionGraphEncodeArgs` now states `-threads 1` for every input and `-filter_threads 1`,
 * `-filter_complex_threads 1` for the graph. This file measures that, with real ffmpeg, on a real
 * 20-input join: the peak thread count of the process is read from `/proc/<pid>/task` while it
 * runs, and it must stay under a ceiling that depends on the number of inputs alone.
 *
 * The second test runs the same join as an unprivileged user under a process ceiling of 200
 * (`prlimit --nproc`), which is the production fault's condition — unbounded, the 27-input join of
 * video 650 needed more than 300 threads on four cores. It runs only where the test can drop
 * privileges (root with `setpriv` and `prlimit`), and says so when it cannot: a skipped test here is
 * a missing capability of the host, never a weakened rule. The unbounded join is NOT run as a
 * control, because how many threads it takes depends on the host's cores, and a test whose verdict
 * depends on the machine is not a test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveFFmpegBin } from "./ffmpegBinary";
import { buildTransitionGraph } from "./timelineFilters";
import { transitionGraphEncodeArgs } from "./timelineRenderer";

const run = promisify(execFile);
const FFMPEG = resolveFFmpegBin();
const INPUTS = 20;
const FPS = 30;
const HANDLE = 0.5;
const SEG_SEC = 2.5;
/** Per input: one decoder thread, its demuxer and output threads, plus the graph, muxer and encoder. */
const THREADS_PER_INPUT = 6;
const THREADS_FIXED = 48;

let ROOT = "";
let segments: string[] = [];
let cutFilter = "";

const canDropPrivileges = (() => {
  if (process.platform !== "linux") return false;
  try {
    return (
      process.getuid?.() === 0 &&
      fs.existsSync("/usr/bin/setpriv") &&
      fs.existsSync("/usr/bin/prlimit") &&
      fs.existsSync("/proc/self/task")
    );
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "v650thr-"));
  fs.chmodSync(ROOT, 0o777);
  for (let i = 0; i < INPUTS; i++) {
    const out = path.join(ROOT, `seg_${i}.mp4`);
    await run(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=${FPS}:duration=${SEG_SEC}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", String(FPS), out,
    ]);
    fs.chmodSync(out, 0o644);
    segments.push(out);
  }
  const durations = segments.map(() => SEG_SEC);
  const transitions = segments.map((_, i) => (i === 0 ? { kind: "hard_cut" as const } : { kind: "dissolve" as const, durationSec: HANDLE }));
  const graph = buildTransitionGraph({ durations, transitions, step: "cut", normalize: { widthPx: 640, heightPx: 360, fps: FPS } });
  expect(graph).not.toBeNull();
  cutFilter = graph!.filter;
}, 300_000);

afterAll(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* not worth a failure */ }
});

/** Runs ffmpeg and samples its thread count from /proc every 25 ms; resolves with the peak and exit code. */
function runWatched(cmd: string, args: string[]): Promise<{ code: number | null; peakThreads: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    let peak = 0;
    const timer = setInterval(() => {
      try {
        const n = fs.readdirSync(`/proc/${child.pid}/task`).length;
        if (n > peak) peak = n;
      } catch { /* the process is gone */ }
    }, 25);
    child.on("close", (code) => {
      clearInterval(timer);
      resolve({ code, peakThreads: peak, stderr });
    });
  });
}

describe("VIDEO 650 — a 20-input cut join stays within a thread ceiling set by its input count", () => {
  it.skipIf(process.platform !== "linux")("the bounded args keep the join under 6 threads per input + 48", async () => {
    const output = path.join(ROOT, "join_bounded.mp4");
    const args = transitionGraphEncodeArgs({ segments, filter: cutFilter, output, fps: FPS });
    /** Every input is stated with its own single decoder thread, and the graph with a single pool. */
    expect(args.filter((a) => a === "-i")).toHaveLength(INPUTS);
    expect(args.filter((a, i) => a === "-threads" && args[i + 1] === "1")).toHaveLength(INPUTS);
    expect(args.slice(0, 10).join(" ")).toContain("-filter_threads 1 -filter_complex_threads 1");
    const result = await runWatched(FFMPEG, args);
    expect(result.code, result.stderr.slice(-400)).toBe(0);
    expect(fs.statSync(output).size).toBeGreaterThan(10_000);
    console.log(`[video650JoinThreadBound] bounded run peak threads=${result.peakThreads}`);
    expect(result.peakThreads).toBeGreaterThan(INPUTS);
    expect(result.peakThreads, `peak threads ${result.peakThreads}`).toBeLessThanOrEqual(INPUTS * THREADS_PER_INPUT + THREADS_FIXED);
  }, 600_000);

  it.skipIf(!canDropPrivileges)("the same join succeeds as an unprivileged user under a process ceiling of 200", async () => {
    /**
     * `ulimit -u` counts every process and thread of the uid on the host, so the ceiling is applied
     * to a uid that owns nothing else here (nobody, 65534). The unbounded join needed more than 300.
     */
    const output = path.join(ROOT, "join_limited.mp4");
    const args = transitionGraphEncodeArgs({ segments, filter: cutFilter, output, fps: FPS });
    const result = await runWatched("/usr/bin/prlimit", [
      "--nproc=200",
      "/usr/bin/setpriv", "--reuid=65534", "--regid=65534", "--clear-groups",
      FFMPEG, ...args,
    ]);
    console.log(`[video650JoinThreadBound] limited run peak threads=${result.peakThreads}`);
    expect(result.code, result.stderr.slice(-400)).toBe(0);
    expect(result.stderr).not.toMatch(/Resource temporarily unavailable|EAGAIN|pthread_create/);
    expect(fs.statSync(output).size).toBeGreaterThan(10_000);
  }, 600_000);

});
