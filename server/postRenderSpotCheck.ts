/**
 * Post-render quality spot-check — ffprobe + 4-frame luma (OpenMontage-style, zero API cost).
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { promisify } from "util";
import { exec as execCb } from "child_process";

const exec = promisify(execCb);

const SAMPLE_FRACTIONS = [0.12, 0.38, 0.62, 0.88];
const BLACK_LUMA_THRESHOLD = 22;

export type PostRenderSpotCheckResult = {
  ok: boolean;
  durationSec: number | null;
  framesChecked: number;
  blackFrameCount: number;
  worstMeanLuma: number | null;
  warnings: string[];
};

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN?.trim() || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN?.trim() || process.env.FFPROBE_PATH?.trim() || "ffprobe";
}

async function probeDurationSec(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await exec(
      `"${ffprobeBin()}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { timeout: 15_000 }
    );
    const n = parseFloat(String(stdout).trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function probeFrameMeanLuma(filePath: string, atSec: number): Promise<number | null> {
  const outPath = path.join(
    path.dirname(filePath),
    `_spot_${path.basename(filePath, path.extname(filePath))}_${Math.round(atSec * 100)}.raw`
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const args = [
        "-y",
        "-ss",
        atSec.toFixed(3),
        "-i",
        filePath,
        "-vframes",
        "1",
        "-vf",
        "scale=64:36,format=gray",
        "-f",
        "rawvideo",
        outPath,
      ];
      const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        reject(new Error("timeout"));
      }, 12_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(outPath)) resolve();
        else reject(new Error(`ffmpeg ${code}`));
      });
      child.on("error", reject);
    });
    const buf = fs.readFileSync(outPath);
    try {
      fs.unlinkSync(outPath);
    } catch {
      /* ignore */
    }
    if (buf.length === 0) return null;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i]!;
    return sum / buf.length;
  } catch {
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** Sample 4 frames across final MP4; warn on black/silent-length issues. */
export async function spotCheckFinalVideo(filePath: string): Promise<PostRenderSpotCheckResult> {
  const warnings: string[] = [];
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 10_000) {
    return {
      ok: false,
      durationSec: null,
      framesChecked: 0,
      blackFrameCount: 0,
      worstMeanLuma: null,
      warnings: ["Final video missing or too small"],
    };
  }

  const durationSec = await probeDurationSec(filePath);
  if (durationSec == null) {
    warnings.push("ffprobe could not read final video duration");
  } else if (durationSec < 8) {
    warnings.push(`Final video very short (${durationSec.toFixed(1)}s)`);
  }

  let blackFrameCount = 0;
  let worstMeanLuma: number | null = null;
  let framesChecked = 0;

  for (const frac of SAMPLE_FRACTIONS) {
    const atSec = durationSec != null ? Math.max(0.1, durationSec * frac) : frac * 30;
    const luma = await probeFrameMeanLuma(filePath, atSec);
    if (luma == null) continue;
    framesChecked++;
    worstMeanLuma = worstMeanLuma == null ? luma : Math.min(worstMeanLuma, luma);
    if (luma < BLACK_LUMA_THRESHOLD) blackFrameCount++;
  }

  if (framesChecked === 0) {
    warnings.push("Could not extract spot-check frames from final video");
  }
  if (blackFrameCount >= 2) {
    warnings.push(
      `${blackFrameCount}/${framesChecked} spot-check frames are nearly black (worst luma ${worstMeanLuma?.toFixed(0) ?? "?"})`
    );
  }

  return {
    ok: warnings.length === 0,
    durationSec,
    framesChecked,
    blackFrameCount,
    worstMeanLuma,
    warnings,
  };
}

export function postRenderSpotCheckEnabled(): boolean {
  return process.env.ENABLE_POST_RENDER_SPOT_CHECK !== "false";
}
