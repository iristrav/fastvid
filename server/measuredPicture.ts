/**
 * VIDEO 663 (R2) — THE MADE FILM, MEASURED: DOES THE PICTURE STAND STILL, OR COME BACK?
 *
 * The [ViewerReport] counted held frames from the renderer's own plan for each segment. The owner's
 * rule is about what a viewer sees: "er mag geen vastgehouden beeld in de video", and "steeds
 * hetzelfde beeld terug achter elkaar". So the delivered file itself is read: one small grey picture
 * every half second (48×27, area-averaged), and
 *
 *   still     the picture hardly changes from one half second to the next (mean difference under
 *             `STILL_DIFF`) for at least `STILL_MIN_SEC` — a frozen or held frame
 *   slow      it changes, but barely (under `SLOW_DIFF`), for at least `SLOW_MIN_SEC` — a viewer
 *             reads it as a still
 *   repeat    a picture with detail in it (not black, not a flat field) that the film already showed
 *             at least `REPEAT_GAP_SEC` earlier, for at least `REPEAT_MIN_SEC`, with other pictures in
 *             between — the same shot coming back
 *
 * The windows of full-frame graphics (a chart's last bars, a card) are left out: they are drawn, not
 * filmed. Pure: the reading is a function of the samples; `measureFilmPicture` only decodes.
 */
import { execFile } from "child_process";
import { promisify } from "util";

import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);

export const SAMPLE_FPS = 2;
export const SAMPLE_W = 48;
export const SAMPLE_H = 27;
export const STILL_DIFF = 0.6;
export const STILL_MIN_SEC = 1;
export const SLOW_DIFF = 1.5;
export const SLOW_MIN_SEC = 4;
export const REPEAT_DIFF = 4;
export const REPEAT_GAP_SEC = 3;
export const REPEAT_MIN_SEC = 1;
/** a picture this flat (grey-level standard deviation) is a black frame or a colour field, not a shot */
export const REPEAT_MIN_DETAIL = 12;

export type Span = { fromSec: number; toSec: number };
export type PictureMeasurement = {
  sampledSec: number;
  stillSec: number;
  slowSec: number;
  repeatSec: number;
  still: Span[];
  slow: Span[];
  repeats: Array<Span & { firstSeenSec: number }>;
};

const meanDiff = (a: Uint8Array, b: Uint8Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
};
const detail = (a: Uint8Array): number => {
  let m = 0;
  for (const v of a) m += v;
  m /= a.length;
  let v2 = 0;
  for (const v of a) v2 += (v - m) * (v - m);
  return Math.sqrt(v2 / a.length);
};
const r2 = (n: number) => Number(n.toFixed(2));
/** a change this large from one half second to the next is a cut to another picture */
export const CUT_DIFF = 12;
/** 4×3-pixel block means of a 48×27 sample (12×9) */
function blockMeans(a: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 * 9);
  for (let by = 0; by < 9; by++)
    for (let bx = 0; bx < 12; bx++) {
      let s = 0;
      for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) s += a[(by * 3 + y) * SAMPLE_W + bx * 4 + x] ?? 0;
      out[by * 12 + bx] = Math.round(s / 12);
    }
  return out;
}

/** Runs of consecutive steps where `low(step)` holds, at least `minSec` long, as spans in film seconds. */
function runs(steps: number, low: (k: number) => boolean, minSec: number, fps: number): Span[] {
  const out: Span[] = [];
  let start = -1;
  for (let k = 0; k <= steps; k++) {
    if (k < steps && low(k)) {
      if (start < 0) start = k;
      continue;
    }
    if (start >= 0) {
      /** steps start..k-1 join samples start..k */
      const span = { fromSec: start / fps, toSec: k / fps };
      if (span.toSec - span.fromSec >= minSec - 1e-6) out.push({ fromSec: r2(span.fromSec), toSec: r2(span.toSec) });
      start = -1;
    }
  }
  return out;
}

/**
 * Read the samples (one grey picture per `1 / fps` s, in film order). `skip` are film windows left
 * out (full-frame graphics): a step or sample inside one counts for nothing.
 */
export function readPicture(samples: readonly Uint8Array[], fps = SAMPLE_FPS, skip: readonly Span[] = []): PictureMeasurement {
  const at = (k: number) => k / fps;
  const skipped = (sec: number) => skip.some((w) => sec >= w.fromSec - 1e-6 && sec <= w.toSec + 1e-6);
  const steps = Math.max(0, samples.length - 1);
  const diffs = Array.from({ length: steps }, (_, k) => meanDiff(samples[k]!, samples[k + 1]!));
  const free = (k: number) => !skipped(at(k)) && !skipped(at(k + 1));

  const still = runs(steps, (k) => free(k) && diffs[k]! < STILL_DIFF, STILL_MIN_SEC, fps);
  const slowAll = runs(steps, (k) => free(k) && diffs[k]! < SLOW_DIFF, SLOW_MIN_SEC, fps);
  /** a slow stretch that is all still is counted once, as still */
  const slow = slowAll.filter((s) => !still.some((x) => x.fromSec <= s.fromSec + 1e-6 && x.toSec >= s.toSec - 1e-6));

  /** repeats: a detailed picture seen before, with a cut (a real change) between the two moments */
  const detailed = samples.map((s) => detail(s) >= REPEAT_MIN_DETAIL);
  /** a cut: one half second to the next changes the picture a lot */
  const cutsBefore = [0];
  for (let k = 0; k < steps; k++) cutsBefore.push(cutsBefore[k]! + (diffs[k]! >= CUT_DIFF ? 1 : 0));
  /** block means: their difference never exceeds the full difference, so a far block pair is never a repeat */
  const coarse = samples.map(blockMeans);
  const firstSeen: Array<number | null> = samples.map(() => null);
  const gapSteps = Math.ceil(REPEAT_GAP_SEC * fps);
  for (let i = 0; i < samples.length; i++) {
    if (!detailed[i] || skipped(at(i))) continue;
    for (let j = 0; j + gapSteps <= i; j++) {
      if (!detailed[j] || skipped(at(j))) continue;
      /** the same shot running on is not a repeat: another picture must have come in between */
      if (cutsBefore[i]! - cutsBefore[j]! === 0) continue;
      if (meanDiff(coarse[i]!, coarse[j]!) >= REPEAT_DIFF + 0.5) continue;
      if (meanDiff(samples[i]!, samples[j]!) >= REPEAT_DIFF) continue;
      firstSeen[i] = at(j);
      break;
    }
  }
  const repeats: PictureMeasurement["repeats"] = [];
  let k = 0;
  while (k < samples.length) {
    if (firstSeen[k] == null) {
      k++;
      continue;
    }
    const from = k;
    while (k + 1 < samples.length && firstSeen[k + 1] != null) k++;
    const span = { fromSec: at(from), toSec: at(k + 1) };
    if (span.toSec - span.fromSec >= REPEAT_MIN_SEC - 1e-6) repeats.push({ fromSec: r2(span.fromSec), toSec: r2(span.toSec), firstSeenSec: r2(firstSeen[from]!) });
    k++;
  }

  const total = (xs: readonly Span[]) => r2(xs.reduce((s, x) => s + (x.toSec - x.fromSec), 0));
  return {
    sampledSec: r2(samples.length / fps),
    stillSec: total(still),
    slowSec: total(slow),
    repeatSec: total(repeats),
    still,
    slow,
    repeats,
  };
}

/** Decode the made film into the samples and read them. Null when the file cannot be read. */
export async function measureFilmPicture(file: string, skip: readonly Span[] = []): Promise<PictureMeasurement | null> {
  try {
    const { stdout } = await execFileAsync(
      resolveFFmpegBin(),
      ["-hide_banner", "-loglevel", "error", "-i", file,
        "-vf", `fps=${SAMPLE_FPS},scale=${SAMPLE_W}:${SAMPLE_H}:flags=area,format=gray`, "-f", "rawvideo", "pipe:1"],
      { encoding: "buffer", maxBuffer: 1024 * 1024 * 64, timeout: 300_000 }
    );
    const bytes = stdout as unknown as Buffer;
    const size = SAMPLE_W * SAMPLE_H;
    const n = Math.floor((bytes?.length ?? 0) / size);
    if (n < 2) return null;
    const samples = Array.from({ length: n }, (_, i) => new Uint8Array(bytes.subarray(i * size, (i + 1) * size)));
    return readPicture(samples, SAMPLE_FPS, skip);
  } catch {
    return null;
  }
}
