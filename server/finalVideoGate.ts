/**
 * Final MP4 validation + self-heal before export.
 * Soft checks (dark frames, freeze holds, duration band) log only — never block export.
 * Hard checks: file exists, video stream, playable size, minimum duration.
 */
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { exec as execCb } from "child_process";
import { normalizeVideoLength, targetVideoDurationMinutes } from "@shared/videoLengths";
import { spotCheckFinalVideo, isInformationalSpotWarning } from "./postRenderSpotCheck";

const exec = promisify(execCb);

export type FinalVideoValidation = {
  ok: boolean;
  durationSec: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  sizeBytes: number;
  spotOk: boolean;
  /** Hard failures only when ok=false after full heal. */
  reasons: string[];
  /** Soft QA notes (logged, not blocking). */
  softWarnings: string[];
};

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN?.trim() || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.FFPROBE_PATH?.trim() || process.env.FFPROBE_BIN?.trim() || "ffprobe";
}

/** Target duration window for QA logging (not export blocking). */
export function expectedDurationBoundsSec(videoLength?: string | null): { min: number; max: number } {
  switch (normalizeVideoLength(videoLength)) {
    case "1":
      return { min: 35, max: 100 };
    case "8-10":
      return { min: 300, max: 780 };
    case "10-15":
      return { min: 420, max: 1080 };
    case "15-20":
      return { min: 600, max: 1380 };
    default:
      return { min: 300, max: 780 };
  }
}

/** Absolute minimum playable file size — below this we heal/reassemble. */
export function absoluteMinFinalVideoBytes(videoLength?: string | null): number {
  const mins = targetVideoDurationMinutes(videoLength);
  if (mins <= 1) return 80_000;
  return Math.max(400_000, Math.round(mins * 60 * 8_000));
}

/** Minimum duration (seconds) for a finished video to be considered playable. */
export function absoluteMinDurationSec(videoLength?: string | null): number {
  switch (normalizeVideoLength(videoLength)) {
    case "1":
      return 28;
    case "8-10":
      return 240;
    case "10-15":
      return 360;
    case "15-20":
      return 540;
    default:
      return 240;
  }
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

function looksLikeMp4(filePath: string): boolean {
  try {
    const head = fs.readFileSync(filePath).subarray(0, 12);
    return head.length >= 8 && head.subarray(4, 8).toString("ascii") === "ftyp";
  } catch {
    return false;
  }
}

function splitExportReasons(
  allReasons: string[],
  durationSec: number | null,
  videoLength?: string | null
): { hard: string[]; soft: string[] } {
  const hard: string[] = [];
  const soft: string[] = [];
  const bounds = expectedDurationBoundsSec(videoLength);
  for (const r of allReasons) {
    if (isInformationalSpotWarning(r)) {
      soft.push(r);
      continue;
    }
    if (/too short.*need/i.test(r) && durationSec != null && durationSec >= absoluteMinDurationSec(videoLength)) {
      soft.push(r);
      continue;
    }
    if (/too long/i.test(r)) {
      soft.push(r);
      continue;
    }
    if (/too small.*need/i.test(r)) {
      soft.push(r);
      continue;
    }
    if (/ffprobe could not read/i.test(r) && durationSec != null) {
      soft.push(r);
      continue;
    }
    if (/appears fully black/i.test(r)) {
      soft.push(r);
      continue;
    }
    if (durationSec != null && durationSec >= bounds.min * 0.85 && /too short/i.test(r)) {
      soft.push(r);
      continue;
    }
    hard.push(r);
  }
  return { hard, soft };
}

/** Hard playable check — used as last resort accept after self-heal. */
export async function validateFinalVideoPlayable(
  filePath: string,
  videoLength?: string | null
): Promise<FinalVideoValidation> {
  const softWarnings: string[] = [];
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      ok: false,
      durationSec: null,
      hasAudio: false,
      hasVideo: false,
      sizeBytes: 0,
      spotOk: false,
      reasons: ["Final video file missing"],
      softWarnings,
    };
  }

  const sizeBytes = fs.statSync(filePath).size;
  const minBytes = absoluteMinFinalVideoBytes(videoLength);
  const durationSec = (await probeDuration(filePath)) ?? null;
  let hasVideo = await probeStreamExists(filePath, "v");
  if (!hasVideo && looksLikeMp4(filePath) && sizeBytes > minBytes) hasVideo = true;
  const hasAudio = await probeStreamExists(filePath, "a");

  const reasons: string[] = [];
  if (sizeBytes < minBytes) {
    reasons.push(`Final video too small (${Math.round(sizeBytes / 1024)}KB, need ≥${Math.round(minBytes / 1024)}KB)`);
  }
  if (!hasVideo) reasons.push("Final video has no video stream");
  if (!hasAudio) reasons.push("Final video has no audio stream");
  if (durationSec == null) {
    reasons.push("Could not read final video duration");
  } else if (durationSec < absoluteMinDurationSec(videoLength)) {
    reasons.push(
      `Final video too short (${durationSec.toFixed(1)}s, need ≥${absoluteMinDurationSec(videoLength)}s)`
    );
  }

  const ok = reasons.length === 0 && hasVideo && sizeBytes >= minBytes;
  return {
    ok,
    durationSec,
    hasAudio,
    hasVideo,
    sizeBytes,
    spotOk: true,
    reasons,
    softWarnings,
  };
}

/** Full QA validation — soft issues never set ok=false. */
export async function validateFinalVideoForExport(
  filePath: string,
  videoLength?: string | null
): Promise<FinalVideoValidation> {
  const softWarnings: string[] = [];
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      ok: false,
      durationSec: null,
      hasAudio: false,
      hasVideo: false,
      sizeBytes: 0,
      spotOk: false,
      reasons: ["Final video file missing"],
      softWarnings,
    };
  }

  const sizeBytes = fs.statSync(filePath).size;
  const minBytes = absoluteMinFinalVideoBytes(videoLength);
  let hasVideo = await probeStreamExists(filePath, "v");
  if (!hasVideo && looksLikeMp4(filePath) && sizeBytes > 50_000) hasVideo = true;
  let hasAudio = await probeStreamExists(filePath, "a");

  const spot = await spotCheckFinalVideo(filePath);
  const allWarnings = [...spot.warnings];
  const bounds = expectedDurationBoundsSec(videoLength);

  if (spot.durationSec != null) {
    if (spot.durationSec < bounds.min) {
      allWarnings.push(`Duration below target (${spot.durationSec.toFixed(1)}s, ideal ≥${bounds.min}s)`);
    } else if (spot.durationSec > bounds.max) {
      allWarnings.push(`Duration above target (${spot.durationSec.toFixed(1)}s, ideal ≤${bounds.max}s)`);
    }
  }
  if (sizeBytes < minBytes) {
    allWarnings.push(`File smaller than ideal (${Math.round(sizeBytes / 1024)}KB, ideal ≥${Math.round(minBytes / 1024)}KB)`);
  }
  if (!hasVideo) allWarnings.push("Final video has no video stream");
  if (!hasAudio) allWarnings.push("Final video has no audio stream");

  for (const w of allWarnings) {
    if (isInformationalSpotWarning(w)) softWarnings.push(w);
  }

  const { hard, soft } = splitExportReasons(allWarnings, spot.durationSec, videoLength);
  softWarnings.push(...soft);

  const playable = await validateFinalVideoPlayable(filePath, videoLength);
  const ok = playable.ok;

  return {
    ok,
    durationSec: spot.durationSec ?? playable.durationSec,
    hasAudio: playable.hasAudio || hasAudio,
    hasVideo: playable.hasVideo || hasVideo,
    sizeBytes,
    spotOk: spot.warnings.filter((w) => !isInformationalSpotWarning(w)).length === 0,
    reasons: playable.ok ? [] : [...playable.reasons, ...hard],
    softWarnings,
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

async function injectSilentAudio(
  inputPath: string,
  workDir: string,
  videoId: number,
  durationSec: number
): Promise<string | null> {
  const out = path.join(workDir, `fastvid_${videoId}_audiofix.mp4`);
  const dur = Math.max(3, durationSec);
  try {
    await exec(
      `"${ffmpegBin()}" -y -i "${inputPath}" -f lavfi -i anullsrc=r=44100:cl=stereo -t ${dur.toFixed(3)} ` +
        `-c:v copy -c:a aac -b:a 128k -shortest -movflags +faststart "${out}"`,
      { timeout: 120_000 }
    );
    return fs.existsSync(out) && fs.statSync(out).size > 1000 ? out : null;
  } catch {
    return null;
  }
}

/** Try to fix a failing final render (remux, trim black, inject audio). */
export async function healFinalVideoForExport(
  filePath: string,
  workDir: string,
  videoId: number,
  validation: FinalVideoValidation
): Promise<string | null> {
  if (validation.reasons.some((r) => /no audio stream/i.test(r))) {
    const dur = validation.durationSec ?? (await probeDuration(filePath)) ?? 60;
    const withAudio = await injectSilentAudio(filePath, workDir, videoId, dur);
    if (withAudio) {
      console.log(`[FinalVideo] Video ${videoId}: injected silent audio track`);
      return withAudio;
    }
  }
  if (validation.reasons.some((r) => /appears fully black|trailing black|too small|no video stream/i.test(r))) {
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
  reassemble?: () => Promise<string | null>;
  /** Plain concat without music — last-resort heal. */
  reassemblePlain?: () => Promise<string | null>;
};

/** Validate → heal → reassemble until playable or attempts exhausted. */
export async function ensureFinalVideoExportReady(
  opts: EnsureFinalVideoOpts
): Promise<{ path: string; validation: FinalVideoValidation }> {
  let current = opts.filePath;
  let validation = await validateFinalVideoForExport(current, opts.videoLength);

  for (let attempt = 0; attempt < 6 && !validation.ok; attempt++) {
    console.warn(
      `[FinalVideo] Video ${opts.videoId}: export check (attempt ${attempt + 1}): ${validation.reasons.slice(0, 3).join("; ") || validation.softWarnings.slice(0, 2).join("; ")}`
    );
    let next: string | null = null;
    if (attempt >= 4 && opts.reassemblePlain) {
      next = await opts.reassemblePlain();
      if (next) console.log(`[FinalVideo] Video ${opts.videoId}: plain concat fallback`);
    } else if (attempt >= 1 && opts.reassemble) {
      next = await opts.reassemble();
      if (next) console.log(`[FinalVideo] Video ${opts.videoId}: reassembled from scene outputs`);
    } else {
      next = await healFinalVideoForExport(current, opts.workDir, opts.videoId, validation);
    }
    if (next) current = next;
    validation = await validateFinalVideoForExport(current, opts.videoLength);
  }

  if (!validation.ok) {
    const playable = await validateFinalVideoPlayable(current, opts.videoLength);
    if (playable.ok) {
      validation = { ...playable, softWarnings: [...validation.softWarnings, ...playable.softWarnings] };
    }
  }

  if (validation.ok) {
    console.log(
      `[FinalVideo] Video ${opts.videoId}: export-ready (${validation.durationSec?.toFixed(1)}s, ${Math.round(validation.sizeBytes / 1024 / 1024)}MB)` +
        (validation.softWarnings.length ? ` [${validation.softWarnings.length} soft QA note(s)]` : "")
    );
  } else {
    console.warn(
      `[FinalVideo] Video ${opts.videoId}: not playable after heal — ${validation.reasons.join("; ")}`
    );
  }
  return { path: current, validation };
}

/** Plain concat (no music) — last-resort when mixed final fails QA. */
export async function plainConcatSceneVideos(
  scenePaths: string[],
  workDir: string,
  videoId: number
): Promise<string | null> {
  const valid = scenePaths.filter((p) => p && fs.existsSync(p) && fs.statSync(p).size > 1_000);
  if (valid.length === 0) return null;
  const listFile = path.join(workDir, `fastvid_${videoId}_plain_list.txt`);
  const out = path.join(workDir, `fastvid_${videoId}_plain_final.mp4`);
  const escaped = valid.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(listFile, escaped, "utf-8");
  try {
    await exec(
      `"${ffmpegBin()}" -y -f concat -safe 0 -i "${listFile}" -c copy -movflags +faststart "${out}"`,
      { timeout: 600_000 }
    );
    return fs.existsSync(out) && fs.statSync(out).size > 1_000 ? out : null;
  } catch {
    return null;
  }
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
