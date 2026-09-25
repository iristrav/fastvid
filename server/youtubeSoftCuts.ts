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
 * This finds the gradual ones. ffmpeg's `scene` score is sampled at 10 fps on a small frame; a run of
 * consecutive frames that each change modestly, and together change a lot, is a transition. Each is
 * returned as a window, and the caller turns both of its edges into cuts, so the transition becomes
 * a segment of its own — too short to take a piece from — and never ends up inside one.
 */
import { spawn } from "child_process";

export type SceneSample = { t: number; score: number };
export type TransitionWindow = { start: number; end: number };

/**
 * Measured on real ffmpeg output (RONDE 654): a 1 s cross-fade in still footage scores 0.01–0.02 per
 * frame at 10 fps, ~0.19 in total; footage that simply moves scores 0.01–0.04 on EVERY frame. So a
 * fixed threshold cannot tell them apart. A frame counts only by how far it rises above the typical
 * change around it — the median over the surrounding 4 s — and a run must be dissolve-length.
 */
const EXCESS_MIN = 0.006;
const RUN_SUM_MIN = 0.1;
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

/** Pure: the gradual transitions in a sequence of per-frame scene scores. */
export function gradualTransitionWindows(samples: readonly SceneSample[]): TransitionWindow[] {
  const excess = samples.map((s) => {
    const around = samples
      .filter((o) => Math.abs(o.t - s.t) <= BASELINE_HALF_WINDOW_SEC)
      .map((o) => o.score);
    return { t: s.t, x: s.score - median(around) };
  });
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
    if (e.x >= EXCESS_MIN) run.push(e);
    else flush();
  }
  flush();
  return out;
}

/** Pure: ffmpeg `metadata=print` output → samples. */
export function parseSceneScores(stderr: string): SceneSample[] {
  const out: SceneSample[] = [];
  let t: number | null = null;
  for (const line of stderr.split("\n")) {
    const pts = /pts_time:([\d.]+)/.exec(line);
    if (pts) {
      t = Number(pts[1]);
      continue;
    }
    const sc = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (sc && t != null) {
      out.push({ t, score: Number(sc[1]) });
      t = null;
    }
  }
  return out;
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

/** Run the sampling pass. Never throws: a failed pass finds no transitions, and says so. */
export async function detectGradualTransitionsInFile(
  filePath: string,
  opts: { ffmpegBin?: string; timeoutMs?: number } = {}
): Promise<TransitionWindow[]> {
  const bin = opts.ffmpegBin ?? process.env.FFMPEG_BIN ?? "ffmpeg";
  const args = [
    "-hide_banner", "-nostats", "-i", filePath, "-an",
    "-vf", "fps=10,scale=160:-2,select='gte(scene\\,0)',metadata=print",
    "-f", "null", "-",
  ];
  const stderr = await new Promise<string>((resolve) => {
    let buf = "";
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 30_000);
    child.stderr.on("data", (d) => {
      if (buf.length < 8_000_000) buf += String(d);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(buf);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
  return gradualTransitionWindows(parseSceneScores(stderr));
}
