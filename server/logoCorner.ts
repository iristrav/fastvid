/**
 * VIDEO 663 — WHERE THE CHANNEL LOGO SITS, MEASURED, SO IT CAN LEAVE THE FRAME.
 *
 * The on-screen-text check passes a small logo over real footage (`textCheck: "overlay"`), and a
 * fixed 15% punch-in left half of a corner logo on screen in the local test film. A logo is the one
 * thing in a moving shot that does not move: across frames spread over the clip, its pixels keep
 * their value while the picture under and around it changes. This finds that block in a corner and
 * says how far to zoom so it leaves the frame — or, when that would cost too much of the picture,
 * where to wipe it (`delogo`).
 *
 * It decides nothing on a still shot (a tripod, a photograph): when most of the picture does not
 * move, a static corner is not evidence of a logo. Pure analysis on grey frames; the reading of the
 * file is `detectCornerLogo`.
 */
import { execFile } from "child_process";
import { promisify } from "util";

import { resolveFFmpegBin } from "./ffmpegBinary";

const run = promisify(execFile);

export const LOGO_SCAN_W = 160;
export const LOGO_SCAN_H = 90;
const LOGO_SCAN_FRAMES = 8;
/** A pixel this steady (grey-level standard deviation) across the frames does not move. */
const STEADY_SD = 3;
/** A pixel this lively moves; below this share of moving pixels the shot is too still to tell. */
const MOVING_SD = 10;
const MIN_MOVING_SHARE = 0.35;
/** The corners searched: a quarter of the width, a third of the height. */
const CORNER_W = 0.25;
const CORNER_H = 0.33;
/** The most a clip is enlarged to push a logo out; past it the logo is wiped instead. */
export const MAX_LOGO_ZOOM = 1.35;

export type LogoBox = { x: number; y: number; w: number; h: number };

/** The steady block in one corner of a moving shot, in scan pixels, or null. */
export function cornerLogoBox(frames: readonly Buffer[], w = LOGO_SCAN_W, h = LOGO_SCAN_H): LogoBox | null {
  const n = frames.length;
  if (n < 4 || frames.some((f) => f.length < w * h)) return null;
  const sd = new Float32Array(w * h);
  let moving = 0;
  for (let i = 0; i < w * h; i++) {
    let s = 0;
    let q = 0;
    for (const f of frames) {
      s += f[i]!;
      q += f[i]! * f[i]!;
    }
    const m = s / n;
    sd[i] = Math.sqrt(Math.max(0, q / n - m * m));
    if (sd[i]! > MOVING_SD) moving++;
  }
  if (moving / (w * h) < MIN_MOVING_SHARE) return null;
  const cw = Math.round(w * CORNER_W);
  const ch = Math.round(h * CORNER_H);
  let best: (LogoBox & { pixels: number }) | null = null;
  const steady = (x: number, y: number) => sd[y * w + x]! < STEADY_SD;
  for (const [x0, y0] of [[0, 0], [w - cw, 0], [0, h - ch], [w - cw, h - ch]] as const) {
    const area = cw * ch;
    /** the corner's steady pixels, as connected blocks: the largest one is the logo candidate */
    const seen = new Uint8Array(area);
    let corner: (LogoBox & { pixels: number }) | null = null;
    let steadyTotal = 0;
    for (let y = y0; y < y0 + ch; y++) {
      for (let x = x0; x < x0 + cw; x++) {
        if (!steady(x, y)) continue;
        steadyTotal++;
        const k = (y - y0) * cw + (x - x0);
        if (seen[k]) continue;
        seen[k] = 1;
        const stack = [[x, y]];
        let pixels = 0;
        let minX = x;
        let minY = y;
        let maxX = x;
        let maxY = y;
        while (stack.length) {
          const [px, py] = stack.pop()!;
          pixels++;
          minX = Math.min(minX, px!);
          minY = Math.min(minY, py!);
          maxX = Math.max(maxX, px!);
          maxY = Math.max(maxY, py!);
          for (const [nx, ny] of [[px! + 1, py!], [px! - 1, py!], [px!, py! + 1], [px!, py! - 1]] as const) {
            if (nx < x0 || nx >= x0 + cw || ny < y0 || ny >= y0 + ch) continue;
            const nk = (ny - y0) * cw + (nx - x0);
            if (seen[nk] || !steady(nx, ny)) continue;
            seen[nk] = 1;
            stack.push([nx, ny]);
          }
        }
        if (!corner || pixels > corner.pixels) corner = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, pixels };
      }
    }
    /** a whole steady corner is a band or a still picture, not a logo */
    if (!corner || steadyTotal > area * 0.6) continue;
    /** a logo is a block: a few pixels are noise; most of its bounding box steady */
    if (corner.pixels < area * 0.02 || corner.pixels < corner.w * corner.h * 0.5) continue;
    if (!best || corner.pixels > best.pixels) best = corner;
  }
  return best ? { x: best.x, y: best.y, w: best.w, h: best.h } : null;
}

/**
 * How much larger the clip must be played, centred, for the box (as fractions of the frame) to leave
 * it — out through the nearer side, horizontally or vertically. 1 when it already sits outside.
 */
export function zoomToLoseBox(box: { x0: number; y0: number; x1: number; y1: number }): number {
  const need = (lo: number, hi: number): number => {
    if (lo >= 0.5) return 0.5 / Math.max(1e-3, lo - 0.5); // the box's near edge must leave the right/bottom side
    if (hi <= 0.5) return 0.5 / Math.max(1e-3, 0.5 - hi); // or the left/top side
    return Infinity; // it crosses the centre line: zooming never removes it
  };
  return Math.max(1, Math.min(need(box.x0, box.x1), need(box.y0, box.y1)));
}

/** The corner logo of a file, in its own pixels, with the zoom that removes it; null when none is found. */
export async function detectCornerLogo(
  file: string,
  durationSec: number
): Promise<{ box: LogoBox; zoom: number; srcW: number; srcH: number } | null> {
  if (!(durationSec > 0.6)) return null;
  try {
    const rate = Math.max(0.5, (LOGO_SCAN_FRAMES - 1) / Math.max(0.5, durationSec - 0.4));
    const { stdout } = await run(
      resolveFFmpegBin(),
      ["-hide_banner", "-loglevel", "error", "-ss", "0.2", "-i", file, "-vf", `fps=${rate.toFixed(4)},scale=${LOGO_SCAN_W}:${LOGO_SCAN_H}:flags=area,format=gray`, "-frames:v", String(LOGO_SCAN_FRAMES), "-f", "rawvideo", "pipe:1"],
      { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 } as never
    );
    const buf = stdout as unknown as Buffer;
    const size = LOGO_SCAN_W * LOGO_SCAN_H;
    const frames: Buffer[] = [];
    for (let o = 0; o + size <= buf.length; o += size) frames.push(buf.subarray(o, o + size));
    const box = cornerLogoBox(frames);
    if (!box) return null;
    const { stdout: probe } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
    const [srcW, srcH] = String(probe).trim().split(",").map(Number);
    if (!(srcW! > 0 && srcH! > 0)) return null;
    /** one scan pixel of margin around the block */
    const fx0 = Math.max(0, (box.x - 1) / LOGO_SCAN_W);
    const fy0 = Math.max(0, (box.y - 1) / LOGO_SCAN_H);
    const fx1 = Math.min(1, (box.x + box.w + 1) / LOGO_SCAN_W);
    const fy1 = Math.min(1, (box.y + box.h + 1) / LOGO_SCAN_H);
    const zoom = zoomToLoseBox({ x0: fx0, y0: fy0, x1: fx1, y1: fy1 });
    const px = (f: number, d: number) => Math.round(f * d);
    return {
      box: { x: px(fx0, srcW!), y: px(fy0, srcH!), w: px(fx1 - fx0, srcW!), h: px(fy1 - fy0, srcH!) },
      zoom,
      srcW: srcW!,
      srcH: srcH!,
    };
  } catch {
    return null;
  }
}

/** `delogo` for a box, kept one pixel inside the frame (the filter refuses a box on the edge). */
export function delogoFilter(box: LogoBox, srcW: number, srcH: number): string {
  const x = Math.max(1, Math.min(box.x, srcW - 3));
  const y = Math.max(1, Math.min(box.y, srcH - 3));
  const w = Math.max(2, Math.min(box.w, srcW - 1 - x));
  const h = Math.max(2, Math.min(box.h, srcH - 1 - y));
  return `delogo=x=${x}:y=${y}:w=${w}:h=${h}`;
}
