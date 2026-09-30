/**
 * VIDEO 626 — "Er mag nooit een stilstaand beeld in de video komen."
 *
 * A photograph reaches the timeline as a video file, and whether it moves depends on which of
 * several encoders made it: some bake in a slow zoom, the contain-and-centre one bakes in none, an
 * archive photo arrives under a name that says nothing about it. So the file is asked, not its
 * name: its first and its last frame, shrunk to a thumbnail, are compared. A file whose last
 * frame is its first is a still, and the timeline gives it a slow camera move; a file that already
 * moves is left alone, so a photograph is never zoomed twice.
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Thumbnail size the frames are compared at: small enough to ignore noise, large enough to see a zoom. */
const THUMB_W = 32;
const THUMB_H = 18;
/** Mean absolute difference per grey pixel (0–255) below which two frames are the same picture. */
export const STILL_FRAME_DIFF = 1.5;

export type FrameGrabber = (filePath: string, atSec: number) => Promise<Buffer>;

export function ffmpegFrameGrabber(ffmpegBin: string): FrameGrabber {
  return async (filePath, atSec) => {
    const { stdout } = await execFileAsync(
      ffmpegBin,
      [
        "-hide_banner", "-loglevel", "error",
        "-ss", atSec.toFixed(3), "-i", filePath,
        "-frames:v", "1",
        "-vf", `scale=${THUMB_W}:${THUMB_H}:flags=area`,
        "-f", "rawvideo", "-pix_fmt", "gray", "-",
      ],
      { encoding: "buffer", timeout: 15_000, maxBuffer: 1 << 20 }
    );
    return stdout as unknown as Buffer;
  };
}

/** Mean absolute difference between two grey thumbnails; Infinity when they cannot be compared. */
export function frameDifference(a: Buffer, b: Buffer): number {
  if (a.length === 0 || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

/**
 * True when the clip shows the same picture at its start and at its end; false when it moves;
 * null when it could not be read — the caller then falls back to what the file's name says.
 */
export async function clipLooksStill(
  filePath: string,
  durationSec: number | null | undefined,
  grab: FrameGrabber
): Promise<boolean | null> {
  if (!(durationSec != null && durationSec > 0.3)) return null;
  try {
    const first = await grab(filePath, Math.min(0.1, durationSec / 4));
    const last = await grab(filePath, Math.max(0, durationSec - 0.15));
    const diff = frameDifference(first, last);
    if (!Number.isFinite(diff)) return null;
    return diff < STILL_FRAME_DIFF;
  } catch {
    return null;
  }
}
