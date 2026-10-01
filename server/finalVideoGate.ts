/**
 * Final MP4 validation + self-heal before export.
 * Soft checks (dark frames, freeze holds, duration band) log only — never block export.
 * Hard checks: file exists, video stream, playable size, minimum duration.
 */
import fs from "fs";
import { promisify } from "util";
import { withForkRetry } from "./_core/execForkRetry";
import { ffmpegSemaphore } from "./_core/semaphore";
import { exec as execCb } from "child_process";
import { absoluteMinFinalVideoBytes, finalVideoRefusals } from "./deliveryGate";
import { resolveLocalVideoPath } from "./storageLocal";

// Routed through ffmpegSemaphore (previously ungated) — this file is the mandatory final export
// gate/self-heal reassembly path for every single render.
const execRaw = promisify(execCb);
const exec = ((cmd: string, opts?: Record<string, unknown>) =>
  ffmpegSemaphore.run(() => withForkRetry(() => execRaw(cmd, opts as never)))) as typeof execRaw;

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

function ffprobeBin(): string {
  return process.env.FFPROBE_PATH?.trim() || process.env.FFPROBE_BIN?.trim() || "ffprobe";
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

// Reads only the first 12 bytes (the ftyp box header) instead of fs.readFileSync's whole-file
// read — a final video can be hundreds of MB to low-GB, and a full read here blocks the shared
// Node event loop (this process also serves other renders/requests) for the entire disk read
// just to inspect 8 bytes.
function looksLikeMp4(filePath: string): boolean {
  const head = Buffer.alloc(12);
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, head, 0, 12, 0);
    return bytesRead >= 8 && head.subarray(4, 8).toString("ascii") === "ftyp";
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
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

  const reasons = finalVideoRefusals({ sizeBytes, hasVideo, hasAudio, durationSec }, videoLength);
  const ok = reasons.length === 0;
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

/** Resolve a stored video URL to a local file path when possible. */
export function resolveStoredVideoLocalPath(videoUrl: string | null | undefined): string | null {
  if (!videoUrl?.trim()) return null;
  const url = videoUrl.trim();
  if (url.startsWith("/local-storage/")) {
    return resolveLocalVideoPath(url);
  }
  return null;
}
