/**
 * RONDE 648 — A SHOT WITH BLACK BARS BAKED IN IS CROPPED, NOT THROWN AWAY.
 *
 * Render 606 refused three YouTube shots with `Rejecting clip with embedded black bars`: archival
 * 4:3 footage an uploader had put in a 16:9 frame with black sides. The picture itself was usable.
 * The operator's choice: cut the bars off and fill the frame the way a standing shot is filled — the
 * picture whole and sharp in the middle, over a blurred, darkened copy of itself (`blurFillChain`).
 *
 * The crop is MEASURED by ffmpeg's own `cropdetect` over a few seconds, never guessed. When there is
 * nothing sensible to crop — the bars do not measure, or what would remain is a sliver — the caller
 * refuses the shot exactly as it did before.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

import { resolveFFmpegBin } from "./ffmpegBinary";
import { blurFillChain } from "./timelineFilters";

const run = promisify(execFile);

export type BarsCrop = { w: number; h: number; x: number; y: number; srcW: number; srcH: number };

/** The last `crop=w:h:x:y` cropdetect printed, which is its settled answer. */
export function parseCropdetect(stderr: string): { w: number; h: number; x: number; y: number } | null {
  const all = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const last = all.at(-1);
  if (!last) return null;
  const [w, h, x, y] = last.slice(1, 5).map(Number);
  return { w: w!, h: h!, x: x!, y: y! };
}

/**
 * Is this a crop worth making? Something must actually be removed (at least 6% of a side), and the
 * picture that remains must be a real picture — at least 30% of the width and height.
 */
export function cropIsWorthMaking(c: BarsCrop): boolean {
  const removedW = 1 - c.w / c.srcW;
  const removedH = 1 - c.h / c.srcH;
  if (removedW < 0.06 && removedH < 0.06) return false;
  return c.w >= c.srcW * 0.3 && c.h >= c.srcH * 0.3;
}

/** How many audio streams the file carries; null when ffprobe cannot tell. */
async function audioStreamCount(file: string): Promise<number | null> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file,
    ]);
    return stdout.trim() ? stdout.trim().split("\n").length : 0;
  } catch {
    return null;
  }
}

async function probeSize(file: string): Promise<{ w: number; h: number } | null> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
      "-of", "csv=p=0", file,
    ]);
    const [w, h] = stdout.trim().split(",").map(Number);
    return w! > 0 && h! > 0 ? { w: w!, h: h! } : null;
  } catch {
    return null;
  }
}

/** Measure the bars: cropdetect over up to three seconds from 0.3 s in. */
export async function detectEmbeddedBarsCrop(file: string): Promise<BarsCrop | null> {
  const size = await probeSize(file);
  if (!size) return null;
  try {
    const { stderr } = await run(resolveFFmpegBin(), [
      "-hide_banner", "-ss", "0.3", "-i", file, "-t", "3",
      "-vf", "cropdetect=limit=24:round=2:reset=0", "-an", "-f", "null", "-",
    ]);
    const c = parseCropdetect(stderr);
    return c ? { ...c, srcW: size.w, srcH: size.h } : null;
  } catch {
    return null;
  }
}

/**
 * Crop the bars and refill the frame at the file's own size, replacing the file atomically.
 * Returns the crop it made, or null when nothing was changed.
 *
 * RONDE 660 — video 608: this also runs on a whole composed scene (the post-compose black check),
 * and the old `-an` threw that scene's voice-over away; scene 0 went first into the concat list and
 * the whole film came out without a voice. The sound is now copied through untouched, and a result
 * that carries fewer audio streams than the file it would replace is thrown away instead.
 */
export async function cropEmbeddedBarsInPlace(file: string, fps = 25): Promise<BarsCrop | null> {
  const crop = await detectEmbeddedBarsCrop(file);
  if (!crop || !cropIsWorthMaking(crop)) return null;
  return applyBarsCrop(file, crop, fps);
}

/* ═══════════ VIDEO 663 — flat bands of ANY colour baked into the source ═══════════ */

/** The analysis size: small enough to read three frames in one call, large enough for 6% of a side. */
export const BAND_SCAN_W = 64;
export const BAND_SCAN_H = 36;
/** A row or column this flat (per-channel standard deviation, 0–255) is part of a band. */
export const BAND_MAX_STDDEV = 6;
/** A band whose colour moves more than this between frames is picture, not a band. */
export const BAND_MAX_DRIFT = 8;

/**
 * VIDEO 663 — render 72 approved a 4:3 archive clip with black bars AND a purple band baked in
 * (archive 61523): `cropdetect` reads black only, and `hasEmbeddedBlackBars` only black sides. This
 * reads flat bands of any colour on the frame's edges, in three frames: a run of rows (or columns)
 * from an edge that are each one flat colour, the same colour in every frame. A crop is proposed only
 * when BOTH opposite edges carry one (top and bottom, or left and right) — a clear sky at the top
 * of a landscape is not a band, a letterbox is. Pure: `frames` are rgb24 frames of `w`×`h`.
 */
export function uniformBandCrop(
  frames: readonly Buffer[],
  w = BAND_SCAN_W,
  h = BAND_SCAN_H
): { top: number; bottom: number; left: number; right: number } | null {
  if (!frames.length || frames.some((f) => f.length < w * h * 3)) return null;
  const px = (f: Buffer, x: number, y: number) => {
    const i = (y * w + x) * 3;
    return [f[i]!, f[i + 1]!, f[i + 2]!] as const;
  };
  /**
   * One line (row y over columns [lo, hi), or column x over rows [lo, hi)): flat in every frame, and
   * the same colour across frames. The range lets a band inside another be read: render 72's black
   * sides first, then the purple band between them.
   */
  const flatLine = (kind: "row" | "col", at: number, lo: number, hi: number): boolean => {
    const means: number[][] = [];
    const n = hi - lo;
    if (n <= 0) return false;
    for (const f of frames) {
      const sum = [0, 0, 0];
      const sq = [0, 0, 0];
      for (let k = lo; k < hi; k++) {
        const c = kind === "row" ? px(f, k, at) : px(f, at, k);
        for (let ch = 0; ch < 3; ch++) {
          sum[ch]! += c[ch]!;
          sq[ch]! += c[ch]! * c[ch]!;
        }
      }
      const mean = sum.map((v) => v / n);
      const sd = sq.map((v, ch) => Math.sqrt(Math.max(0, v / n - mean[ch]! * mean[ch]!)));
      if (sd.some((d) => d > BAND_MAX_STDDEV)) return false;
      means.push(mean);
    }
    return means.every((m) => m.every((v, ch) => Math.abs(v - means[0]![ch]!) <= BAND_MAX_DRIFT));
  };
  const run = (kind: "row" | "col", from: number, step: number, limit: number, lo: number, hi: number): number => {
    let n = 0;
    for (let at = from; n < limit && flatLine(kind, at, lo, hi); at += step) n++;
    return n;
  };
  /** a band of 4% of a side is plainly visible (render 72's purple band was about 5%) */
  const minRows = Math.max(2, Math.ceil(h * 0.04));
  const minCols = Math.max(2, Math.ceil(w * 0.04));
  /** sides and bands, read twice: each pass within what the other left of the frame */
  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  for (let pass = 0; pass < 2; pass++) {
    const t = run("row", top, 1, Math.floor(h / 2), left, w - right);
    const b = run("row", h - 1 - bottom, -1, Math.floor(h / 2), left, w - right);
    if (t + top >= minRows && b + bottom >= minRows) {
      top += t;
      bottom += b;
    }
    const l = run("col", left, 1, Math.floor(w / 2), top, h - bottom);
    const r = run("col", w - 1 - right, -1, Math.floor(w / 2), top, h - bottom);
    if (l + left >= minCols && r + right >= minCols) {
      left += l;
      right += r;
    }
  }
  const rows = top >= minRows && bottom >= minRows;
  const cols = left >= minCols && right >= minCols;
  if (!rows && !cols) return null;
  /** a whole flat frame is not a framed picture */
  if (top + bottom >= h * 0.7 || left + right >= w * 0.7) return null;
  return { top: rows ? top : 0, bottom: rows ? bottom : 0, left: cols ? left : 0, right: cols ? right : 0 };
}

/** The bands of `uniformBandCrop` measured on the file, as a crop in its own pixels; null when none. */
export async function detectUniformBandsCrop(file: string): Promise<BarsCrop | null> {
  const size = await probeSize(file);
  if (!size) return null;
  const frames: Buffer[] = [];
  for (const t of [0.4, 1.2, 2.4]) {
    try {
      const { stdout } = await run(
        resolveFFmpegBin(),
        ["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `scale=${BAND_SCAN_W}:${BAND_SCAN_H}:flags=area,format=rgb24`, "-f", "rawvideo", "pipe:1"],
        { encoding: "buffer", maxBuffer: 1024 * 1024 } as never
      );
      const buf = stdout as unknown as Buffer;
      if (buf?.length >= BAND_SCAN_W * BAND_SCAN_H * 3) frames.push(buf);
    } catch {
      /* a short file has fewer frames to read */
    }
  }
  if (frames.length < 2) return null;
  const b = uniformBandCrop(frames);
  if (!b) return null;
  /** one scan pixel inward on each cropped side, so a soft band edge never survives */
  const sx = size.w / BAND_SCAN_W;
  const sy = size.h / BAND_SCAN_H;
  const x = b.left ? Math.ceil((b.left + 1) * sx) : 0;
  const y = b.top ? Math.ceil((b.top + 1) * sy) : 0;
  const right = b.right ? Math.ceil((b.right + 1) * sx) : 0;
  const bottom = b.bottom ? Math.ceil((b.bottom + 1) * sy) : 0;
  const even = (n: number) => Math.max(2, n - (n % 2));
  return { x: x - (x % 2), y: y - (y % 2), w: even(size.w - x - right), h: even(size.h - y - bottom), srcW: size.w, srcH: size.h };
}

/** VIDEO 663 — crop flat bands of any colour and refill the frame with the picture itself. Null when nothing changed. */
export async function cropUniformBandsInPlace(file: string, fps = 25): Promise<BarsCrop | null> {
  const crop = await detectUniformBandsCrop(file);
  if (!crop || !cropIsWorthMaking(crop)) return null;
  return applyBarsCrop(file, crop, fps);
}

async function applyBarsCrop(file: string, crop: BarsCrop, fps: number): Promise<BarsCrop | null> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file, path.extname(file))}.bars${path.extname(file) || ".mp4"}`);
  try {
    await run(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error", "-i", file,
      "-vf",
      `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` +
        blurFillChain({ widthPx: crop.srcW, heightPx: crop.srcH, fps }),
      "-map", "0:v:0", "-map", "0:a?", "-c:a", "copy",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      tmp,
    ]);
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) return null;
    const audioBefore = await audioStreamCount(file);
    const audioAfter = await audioStreamCount(tmp);
    if (audioBefore === null || audioAfter === null || audioAfter < audioBefore) {
      console.error(
        `[EmbeddedBars] crop of ${path.basename(file)} discarded — audio streams before=${audioBefore ?? "unknown"} ` +
          `after=${audioAfter ?? "unknown"}; the file is left as it was`
      );
      fs.rmSync(tmp, { force: true });
      return null;
    }
    fs.renameSync(tmp, file);
    return crop;
  } catch {
    fs.rmSync(tmp, { force: true });
    return null;
  }
}
