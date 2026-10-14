/**
 * VIDEO 656 — A CONTACT SHEET AND A REPEAT CHECK FOR EVERY DELIVERED FILM.
 *
 * Render 656 showed the same 2.9 s of a YouTube shot three times in a row, and nothing after the
 * render could see it: every check read the plan, none looked at the picture. The owner asked for
 * an overview of the film that is kept with it, so a person — and the assistant reading the logs —
 * can see what was delivered.
 *
 * One ffmpeg pass over the delivered file makes two things:
 *  - a contact sheet: one thumbnail per sample, eight to a row, stored next to the video;
 *  - a fingerprint per sample (a 9×8 grey thumbnail → 64-bit difference hash), compared here.
 *
 * A REPEAT is a picture that comes back after the film showed something else: sample j looks like
 * sample i, and between them there is a sample that does not. A picture that simply stays on screen
 * (a held frame, a slow shot) is not a repeat. Near-flat samples (black, a plain card ground) are
 * not compared: they look alike without being the same footage.
 *
 * It reports and never gates: the film is already delivered when this runs.
 */
import { execFile } from "child_process";
import fs from "fs";

/** At most this many samples: one a second up to ten minutes, then wider apart. */
export const MAX_SAMPLES = 600;
/** At most this many thumbnails on the sheet (8 × 30): one sample in every N goes on it. */
export const MAX_SHEET_TILES = 240;
export const SHEET_COLUMNS = 8;
/** Differences of up to this many bits out of 64 read as the same picture. */
export const SAME_PICTURE_BITS = 6;
/** A sample whose grey levels vary less than this is flat (black, a plain ground) and not compared. */
export const FLAT_STDDEV = 6;

const FP_W = 9;
const FP_H = 8;

export type FrameFingerprint = { atSec: number; hash: bigint; flat: boolean };

export type RepeatFinding = {
  /** Where the picture was first shown, and where it came back. */
  firstAtSec: number;
  againAtSec: number;
  /** How many consecutive samples came back together. */
  samples: number;
  /** Seconds of film that came back, at the sampling interval. */
  seconds: number;
};

export function sampleIntervalSec(durationSec: number): number {
  if (!(durationSec > 0)) return 1;
  return Math.max(1, Math.ceil(durationSec / MAX_SAMPLES));
}

/** One sample in every `sheetEvery` becomes a tile. */
export function sheetEvery(sampleCount: number): number {
  return Math.max(1, Math.ceil(sampleCount / MAX_SHEET_TILES));
}

/** A difference hash of one 9×8 grey frame: is each pixel brighter than the one to its right. */
export function fingerprintOf(gray: Uint8Array, atSec: number): FrameFingerprint {
  let hash = 0n;
  let sum = 0;
  let sumSq = 0;
  for (let y = 0; y < FP_H; y++) {
    for (let x = 0; x < FP_W - 1; x++) {
      const a = gray[y * FP_W + x]!;
      const b = gray[y * FP_W + x + 1]!;
      hash = (hash << 1n) | (a > b ? 1n : 0n);
    }
  }
  for (let i = 0; i < FP_W * FP_H; i++) {
    sum += gray[i]!;
    sumSq += gray[i]! * gray[i]!;
  }
  const n = FP_W * FP_H;
  const stddev = Math.sqrt(Math.max(0, sumSq / n - (sum / n) ** 2));
  return { atSec, hash, flat: stddev < FLAT_STDDEV };
}

export function hammingBits(a: bigint, b: bigint): number {
  let x = a ^ b;
  let bits = 0;
  while (x) {
    bits += Number(x & 1n);
    x >>= 1n;
  }
  return bits;
}

/** Split raw 9×8 grey frames, one after another, into fingerprints. */
export function fingerprintsFromRaw(raw: Uint8Array, intervalSec: number): FrameFingerprint[] {
  const size = FP_W * FP_H;
  const out: FrameFingerprint[] = [];
  for (let i = 0; (i + 1) * size <= raw.length; i++) {
    out.push(fingerprintOf(raw.subarray(i * size, (i + 1) * size), i * intervalSec));
  }
  return out;
}

/**
 * Pictures that come back. Each finding is a run: sample i ≈ j, i+1 ≈ j+1, … collapsed to one line,
 * and a sample that was reported as a return is not reported again against another earlier sample.
 */
export function findRepeats(prints: readonly FrameFingerprint[], intervalSec: number): RepeatFinding[] {
  const n = prints.length;
  const same = (i: number, j: number) =>
    !prints[i]!.flat && !prints[j]!.flat && hammingBits(prints[i]!.hash, prints[j]!.hash) <= SAME_PICTURE_BITS;
  /** Samples already reported as a return: a still picture is one return, not one per earlier sample. */
  const returned = new Set<number>();
  const findings: RepeatFinding[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (returned.has(j) || !same(i, j)) continue;
      /** something else was on screen between them: a sample unlike sample i */
      let changed = false;
      for (let k = i + 1; k < j && !changed; k++) changed = !prints[k]!.flat && !same(i, k);
      if (!changed) continue;
      let len = 1;
      returned.add(j);
      while (i + len < j && j + len < n && same(i + len, j + len)) {
        returned.add(j + len);
        len++;
      }
      findings.push({
        firstAtSec: prints[i]!.atSec,
        againAtSec: prints[j]!.atSec,
        samples: len,
        seconds: len * intervalSec,
      });
      break;
    }
  }
  return findings;
}

export type ContactSheetResult = {
  sheetPath: string | null;
  intervalSec: number;
  samples: number;
  repeats: RepeatFinding[];
};

/**
 * One decode of the film: the sheet to `sheetPath`, the fingerprints through a pipe. Null on any
 * failure — the caller reports that and carries on.
 */
export async function scanDeliveredFilm(params: {
  videoPath: string;
  sheetPath: string;
  durationSec: number;
  ffmpegBin: string;
  timeoutMs?: number;
}): Promise<ContactSheetResult | null> {
  /** An unmeasured length is read as ten minutes: one sample a second, a full sheet. */
  const durationSec = params.durationSec > 0 ? params.durationSec : MAX_SAMPLES;
  const intervalSec = sampleIntervalSec(durationSec);
  const expected = Math.max(1, Math.ceil(durationSec / intervalSec));
  const every = sheetEvery(expected);
  const rows = Math.max(1, Math.ceil(Math.ceil(expected / every) / SHEET_COLUMNS));
  const graph =
    `[0:v]fps=1/${intervalSec},split[a][b];` +
    `[a]select='not(mod(n\\,${every}))',scale=240:-2,tile=${SHEET_COLUMNS}x${rows}[sheet];` +
    `[b]scale=${FP_W}:${FP_H}:flags=area,format=gray[fp]`;
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-threads", "2",
    "-i", params.videoPath,
    "-filter_complex", graph,
    "-map", "[sheet]", "-frames:v", "1", "-q:v", "4", params.sheetPath,
    "-map", "[fp]", "-f", "rawvideo", "pipe:1",
  ];
  const raw = await new Promise<Buffer | null>((resolve) => {
    execFile(
      params.ffmpegBin,
      args,
      {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        /** The whole film is decoded once: three minutes, or half its length when that is longer. */
        timeout: params.timeoutMs ?? Math.max(180_000, durationSec * 500),
      },
      (err, stdout) => resolve(err ? null : (stdout as Buffer))
    );
  });
  if (!raw) return null;
  const prints = fingerprintsFromRaw(new Uint8Array(raw), intervalSec);
  return {
    sheetPath: fs.existsSync(params.sheetPath) && fs.statSync(params.sheetPath).size > 0 ? params.sheetPath : null,
    intervalSec,
    samples: prints.length,
    repeats: findRepeats(prints, intervalSec),
  };
}

export function contactSheetStorageKey(videoId: number, jobId: number): string {
  return `videos/${videoId}/edits/render_${jobId}_contact_sheet.jpg`;
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/** The line a person — or the assistant reading the log — reads. The storage key, never a URL. */
export function formatContactSheetLine(
  videoId: number,
  jobId: number,
  result: ContactSheetResult | null,
  storedKey: string | null
): string {
  if (!result) {
    return `[ContactSheet] video=${videoId} job=${jobId} NOT MADE — the delivered file could not be read for it`;
  }
  const head =
    `[ContactSheet] video=${videoId} job=${jobId} samples=${result.samples} every=${result.intervalSec}s ` +
    `sheet=${storedKey ?? "not stored"}`;
  if (result.repeats.length === 0) return `${head} repeats=0 — no picture comes back after the film moved on`;
  const list = result.repeats
    .slice(0, 12)
    .map((r) => `${mmss(r.firstAtSec)}→${mmss(r.againAtSec)} (${r.seconds}s)`)
    .join(", ");
  const more = result.repeats.length > 12 ? ` and ${result.repeats.length - 12} more` : "";
  return `${head} REPEATS=${result.repeats.length} — a picture shown earlier comes back: ${list}${more}`;
}
