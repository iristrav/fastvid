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
