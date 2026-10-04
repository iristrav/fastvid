/**
 * OCTOBER 2026 — RAILWAY LOAD TEST for the Remotion overlay (test tooling, not part of the product).
 *
 * Runs ONLY in a separate Railway service ("remotion-loadtest", start command
 * `node dist/remotionLoadTest.js`); no worker, no database, no user traffic. It drives the unchanged
 * production route — `productionGraphicsOverlay` → `renderGraphicsOverlay` (PNG frames → .mov) — then
 * the composite with the exact ffmpeg arguments `timelineRenderer` uses, and logs what the container
 * really did: wall time, frames, PNG file count, the .mov, container RAM and CPU (cgroup), and free
 * disk on the work directory, sampled every 2 s. Lengths run shortest first and it STOPS at the
 * first failure. One controlled failure (the browser killed mid-render) checks the cleanup.
 *
 * Every line it prints starts with LOADTEST so it can be read back from the service's logs.
 */
import { execFile, execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import { resolveFFmpegBin } from "./ffmpegBinary";
import { productionGraphicsOverlay } from "./graphicsOverlayDeps";
import { emptyTimeline, type ProjectTimeline, type TimelineGraphic } from "./projectTimeline";

const run = promisify(execFile);
const log = (msg: string) => console.log(`LOADTEST ${msg}`);
const ROOT = path.join(os.tmpdir(), "remotion-loadtest");

function readNum(file: string): number | null {
  try {
    const n = Number(fs.readFileSync(file, "utf8").trim().split(/\s+/)[0]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function cpuUsageUsec(): number | null {
  try {
    const m = fs.readFileSync("/sys/fs/cgroup/cpu.stat", "utf8").match(/usage_usec\s+(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
function throttledUsec(): number | null {
  try {
    const m = fs.readFileSync("/sys/fs/cgroup/cpu.stat", "utf8").match(/throttled_usec\s+(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
function memBytes(): number | null {
  return readNum("/sys/fs/cgroup/memory.current") ?? (os.totalmem() - os.freemem());
}
function freeDiskMB(dir: string): number {
  const s = fs.statfsSync(dir);
  return Math.round((s.bavail * s.bsize) / 1e6);
}
function countPng(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".png")) n++;
    }
  };
  walk(dir);
  return n;
}
function dirMB(dir: string): number {
  try {
    return Math.round(Number(execSync(`du -sk "${dir}"`, { stdio: ["ignore", "pipe", "ignore"] }).toString().split(/\s/)[0]) / 1024);
  } catch {
    return 0;
  }
}

/** The same synthetic film as the local benchmark: captions throughout, five graphics a minute. */
function timeline(minutes: number): ProjectTimeline {
  const dur = minutes * 60;
  const t = emptyTimeline(1);
  t.durationSec = dur;
  const graphics: TimelineGraphic[] = [];
  for (let m = 0; m < minutes; m++) {
    const b = m * 60;
    graphics.push(
      { id: `map${m}`, graphicType: "map_point", start: b + 2, end: b + 6.5, label: "Berlin, Germany", data: { locationName: "Berlin, Germany", lon: 13.4, lat: 52.52, iso3: "DEU" } },
      { id: `cnt${m}`, graphicType: "counter", start: b + 15, end: b + 18.5, label: "140", data: { fromValue: 0, toValue: 140, caption: "people" } },
      { id: `lt${m}`, graphicType: "lower_third", start: b + 25, end: b + 29, label: "Ronald Reagan", data: { name: "Ronald Reagan" } },
      { id: `dc${m}`, graphicType: "date_card", start: b + 35, end: b + 38, label: "1987", data: { text: "1987" } },
      { id: `ch${m}`, graphicType: "line_chart", start: b + 45, end: b + 50, label: "Population", data: { title: "Population", series: [{ label: "1990", value: 79.8 }, { label: "2000", value: 82.2 }, { label: "2020", value: 83.2 }] } },
    );
  }
  const captions: unknown[] = [];
  for (let s = 0; s < dur; s += 3) {
    captions.push({ id: `c${s}`, text: "On 9 November 1989 the crossings opened", start: s, end: Math.min(dur, s + 3), style: { position: "bottom", fontSizePx: 44 } });
  }
  for (const track of t.tracks) {
    if (track.kind === "GRAPHICS") track.graphics.push(...graphics);
    if (track.kind === "CAPTIONS") (track.captions as unknown[]).push(...captions);
  }
  return t;
}

let lastPeak: { peakWorkMB: number; peakMemMB: number } | null = null;

type Sample = { at: number; memMB: number; freeMB: number; png: number; workMB: number; movSeen: boolean };

function startSampler(workDir: string): { stop: () => Sample[] } {
  const samples: Sample[] = [];
  const tick = () => {
    const mov = path.join(workDir, "graphics_overlay.mov");
    samples.push({
      at: Date.now(),
      memMB: Math.round((memBytes() ?? 0) / 1e6),
      freeMB: freeDiskMB(ROOT),
      png: countPng(workDir),
      workMB: dirMB(workDir),
      movSeen: fs.existsSync(mov),
    });
  };
  tick();
  const timer = setInterval(tick, 2000);
  return { stop: () => { clearInterval(timer); tick(); return samples; } };
}

async function probe(file: string): Promise<string> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,pix_fmt,width,height,r_frame_rate,nb_frames:format=duration",
      "-of", "default=nw=1", file,
    ]);
    return stdout.trim().replace(/\n/g, " ");
  } catch (err) {
    return `ffprobe failed: ${(err as Error).message.slice(0, 160)}`;
  }
}

async function oneLength(minutes: number): Promise<boolean> {
  const workDir = path.join(ROOT, `m${minutes}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const freeBefore = freeDiskMB(ROOT);
  const memBefore = Math.round((memBytes() ?? 0) / 1e6);
  const cpu0 = cpuUsageUsec();
  const thr0 = throttledUsec();
  log(`START minutes=${minutes} freeDiskMB=${freeBefore} memMB=${memBefore}`);
  const sampler = startSampler(workDir);
  const t0 = Date.now();
  let overlayPath: string | null = null;
  let error: string | null = null;
  try {
    const result = await productionGraphicsOverlay({ workDir, cacheDir: path.join(ROOT, "bundle") })(timeline(minutes));
    overlayPath = result?.overlayPath ?? null;
  } catch (err) {
    error = (err as Error).message.slice(0, 300);
  }
  const overlayMs = Date.now() - t0;
  const samples = sampler.stop();
  const cpu1 = cpuUsageUsec();
  const thr1 = throttledUsec();
  const movFirst = samples.find((s) => s.movSeen)?.at ?? null;
  const pngPhaseMs = movFirst ? movFirst - t0 : null;
  const packMs = movFirst ? t0 + overlayMs - movFirst : null;
  const frames = minutes * 60 * 30;
  const coresUsed = cpu0 != null && cpu1 != null ? ((cpu1 - cpu0) / 1000 / overlayMs).toFixed(2) : "n/a";
  const peakMem = Math.max(...samples.map((s) => s.memMB));
  const minFree = Math.min(...samples.map((s) => s.freeMB));
  const peakPng = Math.max(...samples.map((s) => s.png));
  const peakWork = Math.max(...samples.map((s) => s.workMB));
  if (error || !overlayPath) {
    log(`FAIL minutes=${minutes} afterMs=${overlayMs} error="${error ?? "no overlay written"}" peakMemMB=${peakMem} minFreeDiskMB=${minFree} peakPng=${peakPng} pngLeftAfter=${countPng(workDir)}`);
    fs.rmSync(workDir, { recursive: true, force: true });
    return false;
  }
  lastPeak = { peakWorkMB: peakWork, peakMemMB: peakMem };
  const movMB = Math.round(fs.statSync(overlayPath).size / 1e6);
  const pngLeft = countPng(workDir);
  const framesDirLeft = fs.existsSync(`${overlayPath}.frames`);
  log(
    `OVERLAY minutes=${minutes} frames=${frames} overlayMs=${overlayMs} fps=${(frames / (overlayMs / 1000)).toFixed(1)} ` +
      `pngPhaseMs≈${pngPhaseMs ?? "n/a"} packMs≈${packMs ?? "n/a"} movMB=${movMB} ` +
      `peakPngFiles=${peakPng} peakWorkDirMB=${peakWork} pngLeftAfter=${pngLeft} framesDirLeft=${framesDirLeft} ` +
      `memBeforeMB=${memBefore} peakMemMB=${peakMem} memAfterMB=${Math.round((memBytes() ?? 0) / 1e6)} ` +
      `cpuCoresUsedAvg=${coresUsed} throttledMs=${thr0 != null && thr1 != null ? Math.round((thr1 - thr0) / 1000) : "n/a"} ` +
      `freeDiskBeforeMB=${freeBefore} minFreeDiskMB=${minFree}`
  );
  log(`PROBE minutes=${minutes} ${await probe(overlayPath)}`);

  /** The composite, with the renderer's own arguments, on a plain base of the same length. */
  const base = path.join(workDir, "base.mp4");
  const tb = Date.now();
  await run(resolveFFmpegBin(), [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0x334455:s=1920x1080:r=30:d=${minutes * 60}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", base,
  ], { maxBuffer: 1 << 24 });
  const baseMs = Date.now() - tb;
  const out = path.join(workDir, "with_graphics.mp4");
  const tc = Date.now();
  const comp = startSampler(workDir);
  let compError: string | null = null;
  try {
    await run(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error", "-i", base, "-i", overlayPath,
      "-filter_complex", "[0:v][1:v]overlay=format=auto:shortest=1[vout]", "-map", "[vout]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", out,
    ], { maxBuffer: 1 << 24 });
  } catch (err) {
    compError = (err as Error).message.slice(0, 300);
  }
  const compSamples = comp.stop();
  const compositeMs = Date.now() - tc;
  log(
    `COMPOSITE minutes=${minutes} baseGenMs=${baseMs} compositeMs=${compositeMs} ` +
      `outMB=${fs.existsSync(out) ? Math.round(fs.statSync(out).size / 1e6) : 0} ` +
      `peakMemMB=${Math.max(...compSamples.map((s) => s.memMB))} minFreeDiskMB=${Math.min(...compSamples.map((s) => s.freeMB))}` +
      (compError ? ` error="${compError}"` : "")
  );
  if (!compError) log(`PROBE_FINAL minutes=${minutes} ${await probe(out)}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  log(`CLEANED minutes=${minutes} freeDiskAfterMB=${freeDiskMB(ROOT)} workDirExists=${fs.existsSync(workDir)}`);
  return !compError;
}

/**
 * The browser processes THIS test started: descendants of this node process whose command line
 * names the headless shell. Read from /proc rather than a `pkill -f` pattern, which matched the
 * shell running it (its own command line held the pattern) and never reached the browser.
 */
function ownBrowserPids(): number[] {
  const parent = new Map<number, number>();
  const cmd = new Map<number, string>();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const [state, ppid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      /** A killed child nobody reaped yet (state Z) is not a running browser. */
      if (state === "Z") continue;
      parent.set(Number(d), Number(ppid));
      cmd.set(Number(d), fs.readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " "));
    } catch {
      /* the process ended while being read */
    }
  }
  const descends = (pid: number) => {
    let p = parent.get(pid);
    for (let i = 0; i < 64 && p; i++) {
      if (p === process.pid) return true;
      p = parent.get(p);
    }
    return false;
  };
  return [...parent.keys()].filter((pid) => descends(pid) && /headless[-_]shell/.test(cmd.get(pid) ?? ""));
}

/** A browser that dies mid-render: the frame folder must go with it. */
async function failureCleanup(): Promise<void> {
  const workDir = path.join(ROOT, "fail");
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const freeBefore = freeDiskMB(ROOT);
  /**
   * Kill only once frames are provably being written, so the render cannot have finished. Remotion
   * relaunches a crashed browser and retries the frame (measured: one kill alone was recovered and
   * the render completed), so every relaunch is killed too, up to MAX_KILL_ROUNDS.
   */
  const KILL_AT_PNG = 300;
  const MAX_KILL_ROUNDS = 5;
  let pngAtKill = 0;
  let killedPids = 0;
  let killRounds = 0;
  let killedAtMs = 0;
  const t0 = Date.now();
  const watcher = setInterval(() => {
    if (killRounds >= MAX_KILL_ROUNDS) return;
    if (!killRounds && countPng(workDir) < KILL_AT_PNG) return;
    const pids = ownBrowserPids();
    if (!pids.length) return;
    if (!killRounds) {
      pngAtKill = countPng(workDir);
      killedAtMs = Date.now() - t0;
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone with its parent */
      }
    }
    killedPids += pids.length;
    killRounds++;
  }, 250);
  let error: string | null = null;
  let finished = false;
  const render = productionGraphicsOverlay({ workDir, cacheDir: path.join(ROOT, "bundle") })(timeline(2)).then(
    () => { finished = true; },
    (err) => { error = (err as Error).message.slice(0, 200).replace(/"/g, "'").replace(/\s+/g, " "); }
  );
  /** A render that hangs after the kill is a result too, not a reason for the test to hang. */
  await Promise.race([render, new Promise((r) => setTimeout(r, 15 * 60_000))]);
  clearInterval(watcher);
  const settledMs = Date.now() - t0;
  const left = countPng(workDir);
  const framesDirs = fs.readdirSync(workDir).filter((f) => f.endsWith(".frames"));
  const files = fs.readdirSync(workDir);
  log(
    `FAILURE_TEST killRounds=${killRounds} killedPids=${killedPids} killedAtMs=${killedAtMs} pngBeforeKill=${pngAtKill} ` +
      `failed=${error != null} finished=${finished} hung=${error == null && !finished} settledMs=${settledMs} ` +
      `error="${error ?? "none"}" pngLeftAfter=${left} framesDirsLeft=${framesDirs.length} ` +
      `filesLeft=${files.length}${files.length ? `(${files.join(",")})` : ""} workDirMB=${dirMB(workDir)} ` +
      `browserPidsAlive=${ownBrowserPids().length} freeDiskBeforeMB=${freeBefore} freeDiskAfterMB=${freeDiskMB(ROOT)}`
  );
  fs.rmSync(workDir, { recursive: true, force: true });
  log(`FAILURE_TEST_CLEANED workDirExists=${fs.existsSync(workDir)} freeDiskMB=${freeDiskMB(ROOT)}`);
}

async function main(): Promise<void> {
  fs.mkdirSync(ROOT, { recursive: true });
  let nproc = "n/a";
  try {
    nproc = execSync("nproc").toString().trim();
  } catch {
    /* reported as n/a */
  }
  log(
    `ENV node=${process.version} cpus=${os.cpus().length} availableParallelism=${os.availableParallelism?.() ?? "n/a"} nproc=${nproc} ` +
      `cgroupCpuMax="${(() => { try { return fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(); } catch { return "n/a"; } })()}" ` +
      `cgroupMemMaxMB=${(() => { const m = readNum("/sys/fs/cgroup/memory.max"); return m ? Math.round(m / 1e6) : "n/a"; })()} ` +
      `totalMemMB=${Math.round(os.totalmem() / 1e6)} tmp=${os.tmpdir()} freeDiskMB=${freeDiskMB(ROOT)} ` +
      `diskTotalMB=${(() => { const s = fs.statfsSync(ROOT); return Math.round((s.blocks * s.bsize) / 1e6); })()}`
  );
  try {
    const { stdout } = await run("df", ["-h", ROOT]);
    log(`DF ${stdout.trim().split("\n").pop()}`);
  } catch {
    /* df is informational */
  }
  const lengths = (process.env.LOADTEST_MINUTES ?? "2,5,10,20,30").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
  const memMax = readNum("/sys/fs/cgroup/memory.max");
  let prev: { minutes: number; peakWorkMB: number; peakMemMB: number } | null = null;
  for (const minutes of lengths) {
    /** A longer length only runs when the previous one, scaled up, leaves room (disk 1.5×, RAM < 70 %). */
    if (prev) {
      const needDisk = (prev.peakWorkMB * minutes) / prev.minutes * 1.5;
      const free = freeDiskMB(ROOT);
      const memOk = !memMax || prev.peakMemMB * 1e6 < memMax * 0.7;
      if (needDisk > free || !memOk) {
        log(`SKIP minutes=${minutes} needDiskMB≈${Math.round(needDisk)} freeDiskMB=${free} prevPeakMemMB=${prev.peakMemMB} — not safe`);
        break;
      }
    }
    lastPeak = null;
    const ok = await oneLength(minutes).catch((err) => {
      log(`FAIL minutes=${minutes} error="${(err as Error).message.slice(0, 300)}"`);
      return false;
    });
    if (!ok) {
      log(`STOPPED after minutes=${minutes} — not going longer after a failure`);
      break;
    }
    const peak = lastPeak as { peakWorkMB: number; peakMemMB: number } | null;
    if (peak) prev = { minutes, ...peak };
  }
  if (process.env.LOADTEST_FAILURE_TEST !== "0") await failureCleanup().catch((err) => log(`FAILURE_TEST error="${(err as Error).message}"`));
  log(`DONE freeDiskMB=${freeDiskMB(ROOT)}`);
  /** Stay up so the restart policy never runs the whole test again; the service is deleted afterwards. */
  setInterval(() => undefined, 1 << 30);
}

main().catch((err) => {
  log(`CRASH ${(err as Error).stack?.slice(0, 500)}`);
  setInterval(() => undefined, 1 << 30);
});
