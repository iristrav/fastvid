/**
 * Final MP4 validation + self-heal before export — video is only "ready" when this passes.
 */
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { exec as execCb } from "child_process";
import { normalizeVideoLength, targetVideoDurationMinutes } from "@shared/videoLengths";
import { spotCheckFinalVideo } from "./postRenderSpotCheck";

const exec = promisify(execCb);

export type FinalVideoValidation = {
  ok: boolean;
  durationSec: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  sizeBytes: number;
  spotOk: boolean;
  reasons: string[];
};

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN?.trim() || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.FFPROBE_PATH?.trim() || process.env.FFPROBE_BIN?.trim() || "ffprobe";
}

/** Expected finished duration window (seconds) per video length bucket. */
export function expectedDurationBoundsSec(videoLength?: string | null): { min: number; max: number } {
  switch (normalizeVideoLength(videoLength)) {
    case "1":
      return { min: 42, max: 95 };
    case "8-10":
      return { min: 360, max: 720 };
    case "10-15":
      return { min: 480, max: 1020 };
    case "15-20":
      return { min: 720, max: 1320 };
    default:
      return { min: 360, max: 720 };
  }
}

function minFinalVideoBytes(videoLength?: string | null): number {
  const mins = targetVideoDurationMinutes(videoLength);
  if (mins <= 1) return 400_000;
  return Math.max(1_500_000, Math.round(mins * 60 * 35_000));
}

async function probeStreamExists(filePath: string, stream: "v" | "a"): Promise<boolean> {
  try {
    const { stdout } = await exec(
      `"${ffprobeBin()}" -v error -select_streams ${stream}:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { timeout: 15_000 }
    );
    const line = String(stdout).trim().toLowerCase();
    return stream === "v" ? line.includes("video") : line.includes("audio");
  } catch {
    return false;
  }
}

/** Validate final MP4 before upload / marking completed. */
export async function validateFinalVideoForExport(
  filePath: string,
  videoLength?: string | null
): Promise<FinalVideoValidation> {
  const reasons: string[] = [];
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      ok: false,
      durationSec: null,
      hasAudio: false,
      hasVideo: false,
      sizeBytes: 0,
      spotOk: false,
      reasons: ["Final video file missing"],
    };
  }

  const sizeBytes = fs.statSync(filePath).size;
  const minBytes = minFinalVideoBytes(videoLength);
  if (sizeBytes < minBytes) {
    reasons.push(`Final video too small (${Math.round(sizeBytes / 1024)}KB, need ≥${Math.round(minBytes / 1024)}KB)`);
  }

  const hasVideo = await probeStreamExists(filePath, "v");
  if (!hasVideo) reasons.push("Final video has no video stream");

  const hasAudio = await probeStreamExists(filePath, "a");
  if (!hasAudio) reasons.push("Final video has no audio stream");

  const spot = await spotCheckFinalVideo(filePath);
  if (!spot.ok) {
    reasons.push(...spot.warnings);
  }

  const bounds = expectedDurationBoundsSec(videoLength);
  if (spot.durationSec == null) {
    reasons.push("Could not read final video duration");
  } else if (spot.durationSec < bounds.min) {
    reasons.push(`Final video too short (${spot.durationSec.toFixed(1)}s, need ≥${bounds.min}s)`);
  } else if (spot.durationSec > bounds.max) {
    reasons.push(`Final video too long (${spot.durationSec.toFixed(1)}s, max ${bounds.max}s)`);
  }

  const spotOk = spot.ok && spot.durationSec != null;
  const ok =
    reasons.length === 0 &&
    hasVideo &&
    hasAudio &&
    sizeBytes >= minBytes &&
    spotOk;

  return {
    ok,
    durationSec: spot.durationSec,
    hasAudio,
    hasVideo,
    sizeBytes,
    spotOk,
    reasons,
  };
}

async function remuxFaststart(inputPath: string, workDir: string, videoId: number): Promise<string | null> {
  const out = path.join(workDir, `fastvid_${videoId}_remux.mp4`);
  try {
    if (fs.existsSync(out)) fs.unlinkSync(out);
    await exec(
      `"${ffmpegBin()}" -y -i "${inputPath}" -c copy -movflags +faststart "${out}"`,
      { timeout: 120_000 }
    );
    return fs.existsSync(out) && fs.statSync(out).size > 1000 ? out : null;
  } catch {
    return null;
  }
}

async function trimTrailingBlack(inputPath: string, workDir: string, videoId: number): Promise<string | null> {
  const out = path.join(workDir, `fastvid_${videoId}_trimheal.mp4`);
  try {
    const { stderr } = await exec(
      `"${ffmpegBin()}" -y -i "${inputPath}" -vf "blackdetect=d=0.04:pix_th=0.12" -an -f null -`,
      { timeout: 90_000 }
    );
    const text = String(stderr);
    const starts = [...text.matchAll(/black_start:([\d.]+)/g)].map((m) => parseFloat(m[1]!));
    const probed = await probeDuration(inputPath);
    if (!probed || starts.length === 0) return null;
    const lastStart = starts[starts.length - 1]!;
    if (lastStart < probed * 0.65 || lastStart >= probed - 0.2) return null;
    const trimTo = Math.max(1, lastStart - 0.02);
    await exec(
      `"${ffmpegBin()}" -y -i "${inputPath}" -t ${trimTo.toFixed(3)} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -movflags +faststart "${out}"`,
      { timeout: 180_000 }
    );
    return fs.existsSync(out) && fs.statSync(out).size > 1000 ? out : null;
  } catch {
    return null;
  }
}

async function probeDuration(filePath: string): Promise<number | null> {
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

/** Try to fix a failing final render (remux, trim black). Returns new path or null. */
export async function healFinalVideoForExport(
  filePath: string,
  workDir: string,
  videoId: number,
  validation: FinalVideoValidation
): Promise<string | null> {
  const needsTrim =
    validation.reasons.some((r) => /black|nearly black|blackdetect/i.test(r)) ||
    validation.spotOk === false;
  if (needsTrim) {
    const trimmed = await trimTrailingBlack(filePath, workDir, videoId);
    if (trimmed) {
      console.log(`[FinalVideo] Video ${videoId}: trimmed trailing black → ${path.basename(trimmed)}`);
      return trimmed;
    }
  }
  const remuxed = await remuxFaststart(filePath, workDir, videoId);
  if (remuxed) {
    console.log(`[FinalVideo] Video ${videoId}: remuxed with faststart`);
    return remuxed;
  }
  return null;
}

export type EnsureFinalVideoOpts = {
  filePath: string;
  workDir: string;
  videoId: number;
  videoLength: string;
  /** Re-build from composed scene MP4s when validation still fails. */
  reassemble?: () => Promise<string | null>;
};

/** Validate → heal → optional reassemble until export-ready or attempts exhausted. */
export async function ensureFinalVideoExportReady(
  opts: EnsureFinalVideoOpts
): Promise<{ path: string; validation: FinalVideoValidation }> {
  let current = opts.filePath;
  let validation = await validateFinalVideoForExport(current, opts.videoLength);

  for (let attempt = 0; attempt < 4 && !validation.ok; attempt++) {
    console.warn(
      `[FinalVideo] Video ${opts.videoId}: export check failed (attempt ${attempt + 1}): ${validation.reasons.slice(0, 3).join("; ")}`
    );
    let next: string | null = null;
    if (attempt >= 2 && opts.reassemble) {
      next = await opts.reassemble();
      if (next) console.log(`[FinalVideo] Video ${opts.videoId}: reassembled from scene outputs`);
    } else {
      next = await healFinalVideoForExport(current, opts.workDir, opts.videoId, validation);
    }
    if (next) current = next;
    validation = await validateFinalVideoForExport(current, opts.videoLength);
  }

  if (validation.ok) {
    console.log(
      `[FinalVideo] Video ${opts.videoId}: export-ready (${validation.durationSec?.toFixed(1)}s, ${Math.round(validation.sizeBytes / 1024 / 1024)}MB)`
    );
  } else {
    console.warn(
      `[FinalVideo] Video ${opts.videoId}: export check still failing after heal — ${validation.reasons.join("; ")}`
    );
  }
  return { path: current, validation };
}

/** Resolve a stored video URL to a local file path when possible. */
export function resolveStoredVideoLocalPath(videoUrl: string | null | undefined): string | null {
  if (!videoUrl?.trim()) return null;
  const url = videoUrl.trim();
  if (url.startsWith("/local-storage/")) {
    const rel = url.slice("/local-storage/".length);
    const uploadsDir = process.env.UPLOADS_DIR?.trim() || path.join(process.cwd(), "uploads");
    const local = path.join(uploadsDir, rel);
    return fs.existsSync(local) ? local : null;
  }
  return null;
}
