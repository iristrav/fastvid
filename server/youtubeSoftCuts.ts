/**
 * RONDE 654 — A DISSOLVE IS A CUT TOO.
 *
 * The shot detector (`detectInteriorCutTimesInFile`) finds hard cuts: one frame to the next, a jump
 * in picture. Documentaries on YouTube move between shots as often with a cross-fade or a dip to
 * black, and a cross-fade has no jump — every frame is a little different from the last, for half a
 * second or more. A piece cut from inside one therefore shows two shots melting into each other,
 * which is exactly what the operator asked never to see: "1 beeld zonder overgang naar een volgend
 * beeld".
 *
 * This finds the gradual ones. Each frame (sampled at 10 fps on a small picture) is compared with the
 * one before it: the mean absolute difference of luma and colour, in 0–255 levels. A run of
 * consecutive frames that each change more than the footage around them, and together change a lot,
 * is a transition. Each is returned as a window, and the caller turns both of its edges into cuts, so
 * the transition becomes a segment of its own — too short to take a piece from — and never ends up
 * inside one.
 *
 * RONDE 657 — the first version read ffmpeg's `scene` score, which is the change in the frame
 * difference, not the difference itself. A steady cross-fade changes every frame by the same amount,
 * so its score stayed near zero: the dress rehearsal's red-brown → blue dissolve went unseen. The raw
 * difference sees it at 7–8 levels a frame against 0 in the still shots around it.
 */
import { spawn } from "child_process";

/** `score`: the mean absolute difference from the previous sampled frame, luma + colour, in levels. */
export type SceneSample = { t: number; score: number };
export type TransitionWindow = { start: number; end: number };

/**
 * Measured on real ffmpeg output (RONDE 657): a 1 s cross-fade between two still shots changes each
 * frame by 3–10 levels; a still shot by 0–1 (compression noise); footage that moves changes every
 * frame, by however much it moves. So a frame counts only by how far it rises above the typical change
 * around it — the median over the surrounding 4 s — by at least 1.5 levels and a quarter of that
 * typical change. A run must be dissolve-length and must add up: 12 levels in total is two shots whose
 * average brightness or colour differs by that much, which any real shot change does.
 */
const EXCESS_MIN = 1.5;
const EXCESS_REL = 0.25;
const RUN_SUM_MIN = 12;
const RUN_MIN_FRAMES = 4;
/** 2.5 s at 10 fps. Longer than any cross-fade: that is a camera move, not a transition. */
const RUN_MAX_FRAMES = 25;
const BASELINE_HALF_WINDOW_SEC = 2;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Pure: the gradual transitions in a sequence of per-frame differences. Samples are in time order. */
export function gradualTransitionWindows(samples: readonly SceneSample[]): TransitionWindow[] {
  const excess: Array<{ t: number; x: number; over: boolean }> = [];
  let lo = 0;
  let hi = 0;
  for (const s of samples) {
    while (lo < samples.length && samples[lo]!.t < s.t - BASELINE_HALF_WINDOW_SEC) lo++;
    while (hi < samples.length && samples[hi]!.t <= s.t + BASELINE_HALF_WINDOW_SEC) hi++;
    const base = median(samples.slice(lo, hi).map((o) => o.score));
    const x = s.score - base;
    excess.push({ t: s.t, x, over: x >= Math.max(EXCESS_MIN, EXCESS_REL * base) });
  }
  const out: TransitionWindow[] = [];
  let run: Array<{ t: number; x: number }> = [];
  const flush = () => {
    const sum = run.reduce((a, r) => a + r.x, 0);
    if (run.length >= RUN_MIN_FRAMES && run.length <= RUN_MAX_FRAMES && sum >= RUN_SUM_MIN) {
      out.push({ start: run[0]!.t, end: run[run.length - 1]!.t });
    }
    run = [];
  };
  for (const e of excess) {
    if (e.over) run.push(e);
    else flush();
  }
  flush();
  return out;
}

/**
 * Line by line: ffmpeg `metadata=print` of signalstats on a difference picture → samples. Luma counts
 * whole, the two colour planes half each — a shot change between two equally bright pictures of
 * different colour is still a shot change.
 */
export function frameDifferenceParser(): { push: (line: string) => void; samples: SceneSample[] } {
  const samples: SceneSample[] = [];
  let t: number | null = null;
  let plane: Partial<Record<"Y" | "U" | "V", number>> = {};
  return {
    samples,
    push: (line) => {
      const pts = /pts_time:([\d.]+)/.exec(line);
      if (pts) {
        /** Each of the three metadata filters prints the frame's line again: only a new time is a new frame. */
        if (t !== Number(pts[1])) {
          t = Number(pts[1]);
          plane = {};
        }
        return;
      }
      const v = /lavfi\.signalstats\.([YUV])AVG=([\d.]+)/.exec(line);
      if (v && t != null) {
        plane[v[1] as "Y" | "U" | "V"] = Number(v[2]);
        if (plane.Y != null && plane.U != null && plane.V != null) {
          samples.push({ t, score: Number((plane.Y + (plane.U + plane.V) / 2).toFixed(3)) });
          plane = {};
        }
      }
    },
  };
}

/** Pure: a whole stderr at once (tests, small files). */
export function parseFrameDifferences(stderr: string): SceneSample[] {
  const p = frameDifferenceParser();
  for (const line of stderr.split("\n")) p.push(line);
  return p.samples;
}

/** Pure: transitions as cut points, merged with the hard cuts, ascending and de-duplicated. */
export function cutsWithTransitions(hardCuts: readonly number[], windows: readonly TransitionWindow[]): number[] {
  const all = [...hardCuts, ...windows.flatMap((w) => [w.start, w.end])]
    .filter((c) => Number.isFinite(c) && c > 0)
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const c of all) if (!out.length || c - out[out.length - 1]! > 0.05) out.push(Number(c.toFixed(3)));
  return out;
}

/**
 * RONDE 657 — how long a scan of a source this long may take: 30 s, plus 0.2 s per second of source
 * (a 5-minute 720p file scans in ~10 s on 4 cores; a Railway replica is slower, and runs two passes at
 * once), at most 10 minutes.
 */
export function scanTimeoutMs(durationSec: number): number {
  const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  return Math.min(600_000, Math.round(30_000 + d * 200));
}

/**
 * A scan is complete when ffmpeg ended on its own and the samples reach the end of the file. Anything
 * less is a scan that saw part of the source and would call the rest free of transitions.
 */
export function scanReachedTheEnd(samples: readonly SceneSample[], durationSec: number, exitedCleanly: boolean): boolean {
  if (!exitedCleanly) return false;
  if (!(durationSec > 0)) return samples.length > 0;
  const last = samples.length ? samples[samples.length - 1]!.t : 0;
  return last >= durationSec - 1;
}

export type TransitionScan = { windows: TransitionWindow[]; complete: boolean; lastSec: number };

/** Run the sampling pass. Never throws: a scan that fails or stops early says so in `complete`. */
export async function scanGradualTransitionsInFile(
  filePath: string,
  opts: { ffmpegBin?: string; timeoutMs?: number; durationSec?: number } = {}
): Promise<TransitionScan> {
  const bin = opts.ffmpegBin ?? process.env.FFMPEG_BIN ?? "ffmpeg";
  const stat = (k: string) => `metadata=print:key=lavfi.signalstats.${k}AVG`;
  const args = [
    "-hide_banner", "-nostats", "-i", filePath, "-an",
    "-vf", `fps=10,scale=160:-2,format=yuv420p,tblend=all_mode=difference,signalstats,${stat("Y")},${stat("U")},${stat("V")}`,
    "-f", "null", "-",
  ];
  const parser = frameDifferenceParser();
  const exitedCleanly = await new Promise<boolean>((resolve) => {
    let rest = "";
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? scanTimeoutMs(opts.durationSec ?? 0));
    child.stderr.on("data", (d) => {
      const lines = (rest + String(d)).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) parser.push(l);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      parser.push(rest);
      resolve(code === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  const samples = parser.samples;
  return {
    windows: gradualTransitionWindows(samples),
    complete: scanReachedTheEnd(samples, opts.durationSec ?? 0, exitedCleanly),
    lastSec: samples.length ? samples[samples.length - 1]!.t : 0,
  };
}

/** The windows alone — for a check that reports what it saw rather than refusing on a partial scan. */
export async function detectGradualTransitionsInFile(
  filePath: string,
  opts: { ffmpegBin?: string; timeoutMs?: number; durationSec?: number } = {}
): Promise<TransitionWindow[]> {
  return (await scanGradualTransitionsInFile(filePath, opts)).windows;
}
