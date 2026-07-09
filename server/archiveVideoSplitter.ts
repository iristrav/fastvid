/**
 * Split archive videos at real shot/scene boundaries — NOT on fixed time intervals.
 * Uses FFmpeg scdet + scene filter (keyframes excluded — they follow GOP intervals, not shots).
 */
import { exec as execCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { ArchiveSubjectContext } from "./archiveClipRelevance";
import {
  ARCHIVE_MAX_UPLOAD_BYTES,
  ARCHIVE_MAX_VIDEO_DURATION_SEC,
  ARCHIVE_MIN_SAVED_CLIP_SEC,
} from "@shared/const";

const execPromise = promisify(execCb);

// Under heavy concurrent ffmpeg/ffprobe load (compose + archive splitting running at the
// same time) spawns can transiently fail with EAGAIN/"Cannot fork" — retry with backoff
// instead of hard-failing the split.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isForkPressureError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EAGAIN") return true;
  // ffmpeg's own filter-graph errors ("Resource temporarily unavailable" from inside the
  // process, not just at spawn time) land in stderr, not necessarily err.message.
  const msg = `${(err as Error)?.message || ""} ${(err as { stderr?: string })?.stderr || ""}`;
  return /resource temporarily unavailable/i.test(msg) || /cannot fork/i.test(msg);
};
const exec = (async (cmd: string, opts?: Record<string, unknown>) => {
  let retriesLeft = 3;
  while (true) {
    try {
      return await execPromise(cmd, opts as never);
    } catch (err) {
      if (retriesLeft > 0 && isForkPressureError(err)) {
        retriesLeft--;
        await sleep(1500 * (4 - retriesLeft));
        continue;
      }
      throw err;
    }
  }
}) as typeof execPromise;

export type VideoClipSegment = {
  buffer: Buffer;
  /** Path to extracted clip file on disk — set when using lazy-load mode to avoid holding all buffers in memory. */
  localPath?: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  index: number;
  /** True when produced by time-based fallback (no hard cuts detected). Skip subject filter at save time. */
  timeFallback?: boolean;
};

export type ArchiveSplitProgress = {
  stage: "split_ffmpeg" | "split_probe" | "split_detect" | "split_rescan" | "split_filter" | "split_extract";
  message: string;
  percent: number;
  clipIndex?: number;
  clipTotal?: number;
};

export type ArchiveSplitProgressFn = (progress: ArchiveSplitProgress) => void;

export class ArchiveSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveSplitError";
  }
}

export const MIN_SPLIT_VIDEO_SEC = 4;
const MIN_SCENE_SEC = 0.12;
const DEFAULT_MAX_CLIPS = 99999; // no practical limit — video length determines clip count
/** Minimum seconds between distinct shot cuts (filters grain/flicker false positives). */
const DEFAULT_MIN_SHOT_CUT_GAP_SEC = 0.55;
/** Legacy min clip length for env override — only sub-flash glitches are merged, not full shots. */
const DEFAULT_MIN_OUTPUT_CLIP_SEC = 2.0;
/** Never merge shots — sub-1s clips are simply dropped, not glued to neighbours. */
const DEFAULT_FLASH_MERGE_MAX_SEC = 0.0;
const INTERNAL_RESCAN_MIN_SEC = 0.85;
const INTERNAL_RESCAN_MAX_RANGES = 300;
const INTERNAL_RESCAN_PASSES = 0;
const SINGLE_SCENE_VALIDATE_MAX_DEPTH = 4;
const DEFAULT_SCENE_THRESHOLD = 0.03;
const DEFAULT_SCDET_THRESHOLD = 1;
/** Split any clip longer than this into fixed intervals — catches scenes without hard cuts. */
const DEFAULT_MAX_CLIP_DURATION_SEC = 8;
const DEFAULT_CUT_MERGE_GAP_SEC = 0.18;
const DEFAULT_SPLIT_BUDGET_MS = 3_600_000;
const DEFAULT_MAX_SOURCE_SEC = ARCHIVE_MAX_VIDEO_DURATION_SEC;
const DEFAULT_MAX_UPLOAD_MB = ARCHIVE_MAX_UPLOAD_BYTES / (1024 * 1024);

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
}

function isH264Codec(codec: string | null): boolean {
  if (!codec) return false;
  const c = codec.toLowerCase();
  return c === "h264" || c === "avc1" || c.includes("avc");
}

/** Downscale + limit fps for shot detect on long/high-fps sources (60fps × 30min is too heavy). */
function shotDetectScaleFilter(totalDur: number): string {
  if (totalDur > 900) return "fps=2,scale=480:-1";
  if (totalDur > 300) return "fps=3,scale=480:-1";
  return "scale=480:-1";
}

/** Small proxy file for analysis when codecs confuse detectors — not a full re-encode. */
function analysisProxyScaleFilter(totalDur: number): string {
  if (totalDur > 900) return "fps=2,scale=480:-2";
  if (totalDur > 300) return "fps=3,scale=640:-2";
  return "fps=5,scale=640:-2";
}

export function sceneThreshold(): number {
  const raw = process.env.ARCHIVE_SCENE_THRESHOLD?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.01 && n <= 0.9) return n;
  }
  return DEFAULT_SCENE_THRESHOLD;
}

export function scdetThreshold(): number {
  const raw = process.env.ARCHIVE_SCDET_THRESHOLD?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 1 && n <= 50) return n;
  }
  return DEFAULT_SCDET_THRESHOLD;
}

/** Minimum duration saved to archive / shown in admin (default 3s). */
export function minSavedArchiveClipSec(): number {
  const raw = process.env.ARCHIVE_MIN_SAVED_CLIP_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 1 && n <= 30) return n;
  }
  return ARCHIVE_MIN_SAVED_CLIP_SEC;
}

/** Drop shot ranges shorter than minSec — keeps one scene per clip (no merging across cuts). */
export function filterClipRangesBelowMinDuration(
  ranges: Array<{ start: number; end: number }>,
  minSec = minSavedArchiveClipSec()
): Array<{ start: number; end: number }> {
  if (minSec <= MIN_SCENE_SEC) return ranges;
  const kept = ranges.filter((r) => r.end - r.start >= minSec - 0.02);
  const dropped = ranges.length - kept.length;
  if (dropped > 0) {
    console.log(
      `[ArchiveSplit] dropped ${dropped} clip(s) shorter than ${minSec}s (one scene per remaining clip)`
    );
  }
  return kept;
}

/** Round duration for DB storage — clips shorter than 1s are rejected, shorter than stored min get stored as min. */
export function archiveStoredDurationSec(actualSec: number): number {
  if (actualSec < 1.0 - 0.05) return 0;
  return Math.round(actualSec * 10) / 10;
}

/** Minimum duration per saved clip (merges shorter adjacent ranges). */
export function minClipSec(): number {
  const raw = process.env.ARCHIVE_MIN_CLIP_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.35 && n <= 15) return n;
  }
  return DEFAULT_MIN_OUTPUT_CLIP_SEC;
}

export function minShotCutGapSec(): number {
  const raw = process.env.ARCHIVE_MIN_SHOT_CUT_GAP?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.3 && n <= 5) return n;
  }
  return DEFAULT_MIN_SHOT_CUT_GAP_SEC;
}

export function cutMergeGapSec(): number {
  const raw = process.env.ARCHIVE_CUT_MERGE_GAP?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.05 && n <= 1) return n;
  }
  return DEFAULT_CUT_MERGE_GAP_SEC;
}

export function maxArchiveClips(): number {
  const raw = process.env.ARCHIVE_MAX_CLIPS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 40 && n <= 600) return n;
  }
  return DEFAULT_MAX_CLIPS;
}

export function flashMergeMaxSec(): number {
  const raw = process.env.ARCHIVE_FLASH_MERGE_MAX_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.1 && n <= 1.5) return n;
  }
  return DEFAULT_FLASH_MERGE_MAX_SEC;
}

export function maxClipDurationSec(): number {
  const raw = process.env.ARCHIVE_MAX_CLIP_DURATION_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 3 && n <= 120) return n;
  }
  return DEFAULT_MAX_CLIP_DURATION_SEC;
}

/** Split any range exceeding maxDur into equal sub-intervals. */
export function splitLongRanges(
  ranges: Array<{ start: number; end: number }>,
  maxDur = maxClipDurationSec()
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const dur = range.end - range.start;
    if (dur <= maxDur + 0.1) {
      out.push(range);
      continue;
    }
    const parts = Math.ceil(dur / maxDur);
    const partDur = dur / parts;
    for (let i = 0; i < parts; i++) {
      out.push({
        start: range.start + i * partDur,
        end: i === parts - 1 ? range.end : range.start + (i + 1) * partDur,
      });
    }
  }
  return out;
}

export function splitBudgetMs(): number {
  const raw = process.env.ARCHIVE_SPLIT_BUDGET_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 120_000 && n <= 7_200_000) return n;
  }
  return DEFAULT_SPLIT_BUDGET_MS;
}

export function maxArchiveVideoDurationSec(): number {
  const raw = process.env.ARCHIVE_MAX_VIDEO_DURATION_SEC?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 60 && n <= 7_200) return n;
  }
  return DEFAULT_MAX_SOURCE_SEC;
}

export function maxArchiveUploadBytes(): number {
  const raw = process.env.ARCHIVE_MAX_UPLOAD_MB?.trim();
  if (raw) {
    const mb = parseInt(raw, 10);
    if (!isNaN(mb) && mb >= 50 && mb <= 4096) return mb * 1024 * 1024;
  }
  return DEFAULT_MAX_UPLOAD_MB * 1024 * 1024;
}

/** HTTP socket timeout for archive upload + scene split (must exceed split budget). */
export function archiveUploadRequestTimeoutMs(): number {
  return splitBudgetMs() + 900_000;
}

function extractConcurrency(): number {
  const raw = process.env.ARCHIVE_SPLIT_CONCURRENCY?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 8) return n;
  }
  return Math.min(4, os.cpus().length || 2);
}

export async function probeVideoDurationSec(filePath: string): Promise<number> {
  try {
    const { stdout } = await exec(
      `${ffprobeBin()} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { timeout: 30_000 }
    );
    const dur = parseFloat(String(stdout).trim());
    return !isNaN(dur) && dur > 0 ? dur : 0;
  } catch {
    return 0;
  }
}

/**
 * Find the last timestamp at which actual decodable video frames exist.
 * Returns `declaredDur` when the file appears complete; returns a smaller value
 * when the video data is truncated (container declares more than it contains).
 *
 * Method: binary search with ffprobe frame decode checks. Each probe attempt decodes
 * one frame at the given position; no frames → no data at that position.
 * Typically completes in 5–15 probes (~10–30s total for a large truncated file).
 */
async function probeActualVideoDuration(filePath: string, declaredDur: number): Promise<number> {
  const hasFrameAt = async (posSec: number): Promise<boolean> => {
    try {
      const ffprobe = ffprobeBin();
      const { stdout } = await execPromise(
        `${ffprobe} -v error -ss ${posSec.toFixed(2)} -i "${filePath}" ` +
          `-select_streams v:0 -frames:v 1 -show_entries frame=pts_time -of json`,
        { timeout: 12_000 }
      );
      const data = JSON.parse(String(stdout)) as { frames?: unknown[] };
      return (data.frames?.length ?? 0) > 0;
    } catch {
      return false;
    }
  };

  // Quick check: does data exist at 90% of the declared duration?
  const checkPoint = declaredDur * 0.9;
  if (await hasFrameAt(checkPoint)) {
    return declaredDur; // File looks complete — trust the container duration.
  }

  // Data is missing near the end. Binary-search for the actual endpoint.
  let lo = 0;
  let hi = checkPoint;
  let iterations = 0;
  while (hi - lo > 5 && iterations < 10) {
    const mid = (lo + hi) / 2;
    if (await hasFrameAt(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
    iterations++;
  }

  // lo is the last confirmed good position. Add a small buffer and round down.
  const actualEnd = Math.max(0, lo + 5);
  return Math.min(actualEnd, declaredDur);
}

export async function assertFfmpegAvailable(): Promise<void> {
  try {
    await exec(`${ffmpegBin()} -version`, { timeout: 8_000, maxBuffer: 256 * 1024 });
  } catch {
    throw new ArchiveSplitError(
      "FFmpeg is not available on the server — automatic splitting cannot run. Check the deploy includes ffmpeg (nixpacks ffmpeg)."
    );
  }
}

/** Normalize cut times from a trimmed ffmpeg window (may be 0-based or absolute). */
export function normalizeWindowCutTimes(
  times: number[],
  windowStart: number,
  windowEnd: number
): number[] {
  const windowDur = windowEnd - windowStart;
  const relative = times.length > 0 && times.every((t) => t <= windowDur + 0.5);
  return mergeNearbyCuts(
    times
      .map((t) => (relative ? t + windowStart : t))
      .filter((t) => t > windowStart + MIN_SCENE_SEC && t < windowEnd - MIN_SCENE_SEC),
    cutMergeGapSec()
  );
}

/** I-frame timestamps often align with hard cuts in edited/archive footage. */
export async function detectKeyframeCutTimes(inputPath: string, totalDur: number): Promise<number[]> {
  try {
    const { stdout } = await exec(
      `${ffprobeBin()} -v error -skip_frame nokey -show_frames -show_entries frame=best_effort_timestamp_time -of csv=p=0 "${inputPath}"`,
      { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }
    );
    const times = String(stdout)
      .split(/\r?\n/)
      .map((s) => parseFloat(s.trim()))
      .filter((t) => !isNaN(t) && t > MIN_SCENE_SEC && t < totalDur - MIN_SCENE_SEC);
    return mergeNearbyCuts(times, cutMergeGapSec());
  } catch (err) {
    console.warn("[ArchiveSplit] keyframe detect failed:", (err as Error).message?.slice(0, 120));
    return [];
  }
}

/** Merge duplicate detections of the same cut (not separate shots). */
export function mergeNearbyCuts(cuts: number[], minGapSec: number): number[] {
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) {
    if (out.length === 0 || t - out[out.length - 1] >= minGapSec) out.push(t);
  }
  return out;
}

/** Combine cut lists from scdet + scene detectors. */
export function combineShotCutTimes(cutLists: number[][]): number[] {
  return mergeNearbyCuts(cutLists.flat(), minShotCutGapSec());
}

/** Parse FFmpeg showinfo pts_time lines. */
export function parsePtsTimesFromFfmpeg(stderr: string, totalDur: number): number[] {
  const times: number[] = [];
  const re = /pts_time:([0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const t = parseFloat(m[1]);
    if (t > MIN_SCENE_SEC && t < totalDur - MIN_SCENE_SEC) times.push(t);
  }
  return times;
}

/** Parse scdet metadata lines (lavfi.scd.time). */
export function parseScdetTimesFromFfmpeg(stderr: string, totalDur: number): number[] {
  const times: number[] = [];
  const re = /lavfi\.scd\.time[=:\s"]+([0-9.]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const t = parseFloat(m[1]);
    if (t > MIN_SCENE_SEC && t < totalDur - MIN_SCENE_SEC) times.push(t);
  }
  return times;
}

/**
 * Build clip ranges from detected cut times only — one clip per shot, no fixed intervals.
 */
export function buildClipRanges(
  cuts: number[],
  totalDuration: number,
  maxClips = maxArchiveClips(),
  mergeGap = cutMergeGapSec()
): Array<{ start: number; end: number }> {
  if (totalDuration <= 0) return [];
  const cutPoints = mergeNearbyCuts(cuts, mergeGap);
  const points = [0, ...cutPoints, totalDuration];

  let ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end - start >= MIN_SCENE_SEC) ranges.push({ start, end });
  }

  return capClipRanges(ranges, maxClips);
}

/** Merge only sub-second flash/glitches — never combine distinct shots into one clip. */
export function mergeFlashFragmentsOnly(
  ranges: Array<{ start: number; end: number }>,
  flashMaxSec = flashMergeMaxSec()
): Array<{ start: number; end: number }> {
  return enforceMinClipDuration(ranges, flashMaxSec);
}

/** Detect interior shot boundaries inside an already-extracted clip file. */
export async function detectInteriorCutTimesInFile(
  inputPath: string,
  totalDur: number,
  timeoutMs = 28_000
): Promise<number[]> {
  if (totalDur < MIN_SCENE_SEC * 2) return [];
  const scdetT = Math.max(2, scdetThreshold() * 0.55);
  const sceneT = Math.max(0.08, sceneThreshold() * 0.55);
  const half = Math.floor(timeoutMs / 2);
  const [scdetCuts, sceneCuts] = await Promise.all([
    detectScdetCutTimes(inputPath, totalDur, scdetT, half),
    detectSceneFilterCutTimes(inputPath, totalDur, sceneT, half),
  ]);
  return combineShotCutTimes([scdetCuts, sceneCuts]).filter(
    (t) => t > MIN_SCENE_SEC && t < totalDur - MIN_SCENE_SEC
  );
}

/** Merge clips shorter than minSec with an adjacent range (used for flash glitches only in archive split). */
export function enforceMinClipDuration(
  ranges: Array<{ start: number; end: number }>,
  minSec = minClipSec()
): Array<{ start: number; end: number }> {
  if (ranges.length <= 1 || minSec <= MIN_SCENE_SEC) return ranges;

  let result = ranges.map((r) => ({ ...r }));
  let changed = true;
  while (changed && result.length > 1) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      const dur = result[i].end - result[i].start;
      if (dur >= minSec) continue;

      if (i === 0) {
        result[0].end = result[1].end;
        result.splice(1, 1);
      } else if (i === result.length - 1) {
        result[i - 1].end = result[i].end;
        result.splice(i, 1);
      } else {
        const prevDur = result[i - 1].end - result[i - 1].start;
        const nextDur = result[i + 1].end - result[i + 1].start;
        if (prevDur <= nextDur) {
          result[i - 1].end = result[i].end;
          result.splice(i, 1);
        } else {
          result[i].end = result[i + 1].end;
          result.splice(i + 1, 1);
        }
      }
      changed = true;
      break;
    }
  }
  return result;
}

/** Cap clip count without merging two full shots into one clip. */
export function capClipRanges(
  ranges: Array<{ start: number; end: number }>,
  maxClips: number,
  flashMaxSec = flashMergeMaxSec()
): Array<{ start: number; end: number }> {
  let result = ranges.map((r) => ({ ...r }));
  const flashOnly = () => {
    let bestIdx = -1;
    let bestScore = Infinity;
    for (let i = 0; i < result.length - 1; i++) {
      const d0 = result[i].end - result[i].start;
      const d1 = result[i + 1].end - result[i + 1].start;
      if (Math.min(d0, d1) > flashMaxSec) continue;
      const score = d0 + d1;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  };

  while (result.length > maxClips) {
    const mergeIdx = flashOnly();
    if (mergeIdx === -1) {
      console.warn(
        `[ArchiveSplit] ${result.length} shots exceeds max ${maxClips} — evenly sampling ${maxClips} clips`
      );
      const step = result.length / maxClips;
      const sampled: Array<{ start: number; end: number }> = [];
      for (let i = 0; i < maxClips; i++) {
        sampled.push(result[Math.floor(i * step)]!);
      }
      result = sampled.sort((a, b) => a.start - b.start);
      break;
    }
    result[mergeIdx].end = result[mergeIdx + 1].end;
    result.splice(mergeIdx + 1, 1);
  }

  return result;
}

/** Split any range that still contains an undetected interior cut. */
export function splitRangeAtInteriorCuts(
  range: { start: number; end: number },
  interiorCuts: number[]
): Array<{ start: number; end: number }> {
  const dur = range.end - range.start;
  if (interiorCuts.length === 0 || dur < MIN_SCENE_SEC * 2) return [range];

  const points = [
    range.start,
    ...mergeNearbyCuts(
      interiorCuts.filter((t) => t > range.start + MIN_SCENE_SEC && t < range.end - MIN_SCENE_SEC),
      cutMergeGapSec()
    ),
    range.end,
  ];

  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end - start >= MIN_SCENE_SEC) out.push({ start, end });
  }
  return out.length > 0 ? out : [range];
}

export function refineClipRangesWithInteriorCuts(
  ranges: Array<{ start: number; end: number }>,
  interiorCutsByRange: number[][]
): Array<{ start: number; end: number }> {
  const refined: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < ranges.length; i++) {
    refined.push(...splitRangeAtInteriorCuts(ranges[i], interiorCutsByRange[i] ?? []));
  }
  return capClipRanges(refined, maxArchiveClips());
}

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R | null>,
  shouldContinue?: () => boolean
): Promise<(R | null)[]> {
  if (items.length === 0) return [];
  const out: (R | null)[] = new Array(items.length).fill(null);
  let nextIdx = 0;

  async function worker() {
    while (true) {
      if (shouldContinue && !shouldContinue()) return;
      const i = nextIdx;
      nextIdx += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }

  const workers = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

async function runFfmpegDetect(cmd: string, timeoutMs: number): Promise<string> {
  try {
    const result = await exec(cmd, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
    return String(result.stderr ?? "");
  } catch (err: unknown) {
    return String((err as { stderr?: string }).stderr ?? "");
  }
}

async function detectScdetCutTimesInWindow(
  inputPath: string,
  windowStart: number,
  windowEnd: number,
  threshold: number,
  timeoutMs: number
): Promise<number[]> {
  const windowDur = windowEnd - windowStart;
  if (windowDur < MIN_SCENE_SEC * 2) return [];

  const cmd =
    `${ffmpegBin()} -i "${inputPath}" -ss ${windowStart.toFixed(3)} -to ${windowEnd.toFixed(3)} -an ` +
    `-vf "scale=480:-1,scdet=threshold=${threshold}:sc_pass=1,showinfo" -f null -`;
  const stderr = await runFfmpegDetect(cmd, timeoutMs);
  const fromMeta = parseScdetTimesFromFfmpeg(stderr, windowEnd);
  const pts = fromMeta.length > 0 ? fromMeta : parsePtsTimesFromFfmpeg(stderr, windowEnd);
  return normalizeWindowCutTimes(pts, windowStart, windowEnd);
}

async function detectSceneFilterCutTimesInWindow(
  inputPath: string,
  windowStart: number,
  windowEnd: number,
  threshold: number,
  timeoutMs: number
): Promise<number[]> {
  const windowDur = windowEnd - windowStart;
  if (windowDur < MIN_SCENE_SEC * 2) return [];

  const cmd =
    `${ffmpegBin()} -i "${inputPath}" -ss ${windowStart.toFixed(3)} -to ${windowEnd.toFixed(3)} -an ` +
    `-vf "scale=480:-1,select='gt(scene,${threshold})',showinfo" -f null -`;
  const stderr = await runFfmpegDetect(cmd, timeoutMs);
  return normalizeWindowCutTimes(parsePtsTimesFromFfmpeg(stderr, windowEnd), windowStart, windowEnd);
}

/** Re-scan long segments for missed interior cuts (fixes clips with 2 shots in 1 file). */
async function rescanRangesForInteriorCuts(
  inputPath: string,
  ranges: Array<{ start: number; end: number }>,
  deadlineMs: number,
  shouldContinue?: () => boolean
): Promise<Array<{ start: number; end: number }>> {
  const interiorCutsByRange: number[][] = ranges.map(() => []);

  const candidates = ranges
    .map((range, idx) => ({ range, idx, dur: range.end - range.start }))
    .filter(({ dur }) => dur >= INTERNAL_RESCAN_MIN_SEC)
    .sort((a, b) => b.dur - a.dur)
    .slice(0, INTERNAL_RESCAN_MAX_RANGES);

  const perRangeTimeout = Math.max(
    6_000,
    Math.min(20_000, Math.floor((deadlineMs - Date.now()) / Math.max(1, candidates.length * 2)) || 6_000)
  );

  await mapPool(
    candidates,
    3,
    async ({ range, idx }) => {
      if (Date.now() >= deadlineMs || (shouldContinue && !shouldContinue())) return null;

      const [scdet, scene] = await Promise.all([
        detectScdetCutTimesInWindow(
          inputPath,
          range.start,
          range.end,
          Math.max(2, scdetThreshold() * 0.55),
          perRangeTimeout
        ),
        detectSceneFilterCutTimesInWindow(
          inputPath,
          range.start,
          range.end,
          Math.max(0.1, sceneThreshold() * 0.55),
          perRangeTimeout
        ),
      ]);

      const interior = combineShotCutTimes([scdet, scene]).filter(
        (t) => t > range.start + MIN_SCENE_SEC && t < range.end - MIN_SCENE_SEC
      );
      if (interior.length > 0) {
        console.log(
          `[ArchiveSplit] interior rescan ${formatTimecode(range.start)}–${formatTimecode(range.end)}: ` +
            `${interior.length} missed cut(s)`
        );
      }
      interiorCutsByRange[idx] = interior;
      return null;
    },
    () => Date.now() < deadlineMs && (shouldContinue?.() ?? true)
  );

  const refined = refineClipRangesWithInteriorCuts(ranges, interiorCutsByRange);
  if (refined.length !== ranges.length) {
    console.log(`[ArchiveSplit] interior rescan: ${ranges.length} → ${refined.length} clip range(s)`);
  }
  return refined;
}

/** scdet — purpose-built shot/scene boundary detector (every frame, downscaled). */
async function detectScdetCutTimes(
  inputPath: string,
  totalDur: number,
  threshold: number,
  timeoutMs: number
): Promise<number[]> {
  const scale = shotDetectScaleFilter(totalDur);
  const cmd =
    `${ffmpegBin()} -i "${inputPath}" -an ` +
    `-vf "${scale},scdet=threshold=${threshold}:sc_pass=1,showinfo" -f null -`;
  const stderr = await runFfmpegDetect(cmd, timeoutMs);
  const fromMeta = parseScdetTimesFromFfmpeg(stderr, totalDur);
  if (fromMeta.length > 0) return mergeNearbyCuts(fromMeta, cutMergeGapSec());
  return mergeNearbyCuts(parsePtsTimesFromFfmpeg(stderr, totalDur), cutMergeGapSec());
}

/** scene filter — visual frame diff (every frame, downscaled; no fps= interval sampling). */
async function detectSceneFilterCutTimes(
  inputPath: string,
  totalDur: number,
  threshold: number,
  timeoutMs: number
): Promise<number[]> {
  const scale = shotDetectScaleFilter(totalDur);
  const cmd =
    `${ffmpegBin()} -i "${inputPath}" -an ` +
    `-vf "${scale},select='gt(scene,${threshold})',showinfo" -f null -`;
  const stderr = await runFfmpegDetect(cmd, timeoutMs);
  return mergeNearbyCuts(parsePtsTimesFromFfmpeg(stderr, totalDur), cutMergeGapSec());
}

async function detectSceneCutTimes(inputPath: string, totalDur: number, deadlineMs: number): Promise<number[]> {
  const remaining = Math.max(60_000, deadlineMs - Date.now());
  const scaled = Math.max(120_000, Math.min(Math.floor(totalDur * 400), 3_600_000));
  // V2: reserve time budget for audio transition detection
  const v2AudioBudget = process.env.ARCHIVE_INGESTION_V2_ENABLED !== "false" ? 25_000 : 0;
  const detectTimeout = Math.min(remaining - v2AudioBudget, scaled);
  const scdetBudget = Math.floor(detectTimeout * 0.5);
  const sceneBudget = Math.floor(detectTimeout * 0.5);

  const [scdetCuts, sceneCuts] = await Promise.all([
    detectScdetCutTimes(inputPath, totalDur, scdetThreshold(), scdetBudget),
    detectSceneFilterCutTimes(inputPath, totalDur, sceneThreshold(), sceneBudget),
  ]);
  let cuts = combineShotCutTimes([scdetCuts, sceneCuts]);

  console.log(
    `[ArchiveSplit] shot detect: scdet=${scdetCuts.length} scene=${sceneCuts.length} combined=${cuts.length}`
  );

  // Retry both detectors more sensitively when almost no boundaries found.
  if (cuts.length < 2 && totalDur > MIN_SPLIT_VIDEO_SEC && Date.now() < deadlineMs - 15_000) {
    const [scdet2, scene2] = await Promise.all([
      detectScdetCutTimes(
        inputPath,
        totalDur,
        Math.max(2, scdetThreshold() * 0.55),
        Math.floor(scdetBudget * 0.5)
      ),
      detectSceneFilterCutTimes(
        inputPath,
        totalDur,
        Math.max(0.1, sceneThreshold() * 0.55),
        Math.floor(sceneBudget * 0.5)
      ),
    ]);
    const retry = combineShotCutTimes([scdet2, scene2]);
    if (retry.length > cuts.length) {
      console.log(`[ArchiveSplit] sensitive shot retry: ${retry.length} cuts (was ${cuts.length})`);
      cuts = retry;
    }
  }

  // V2: add audio-transition-based cut candidates (silence gaps)
  // Only when the source file has an audio track and V2 is enabled.
  if (process.env.ARCHIVE_INGESTION_V2_ENABLED !== "false" && Date.now() < deadlineMs - 5_000) {
    try {
      const { detectAudioTransitionCuts } = await import("./archiveIngestionV2");
      const audioCuts = await detectAudioTransitionCuts(inputPath, totalDur, v2AudioBudget);
      if (audioCuts.length > 0) {
        const merged = combineShotCutTimes([cuts, audioCuts]);
        if (merged.length > cuts.length) {
          console.log(`[ArchiveSplit] V2 audio transitions: +${merged.length - cuts.length} cut(s)`);
          cuts = merged;
        }
      }
    } catch {
      // audio detection is optional — never fail the split
    }
  }

  return cuts;
}

async function extractVideoSegment(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
  preferStreamCopy = false
): Promise<void> {
  const durationSec = Math.max(0.05, endSec - startSec);
  const perClipTimeout = Math.round(
    Math.max(20_000, Math.min(120_000, durationSec * 4000 + 15_000))
  );
  const start = startSec.toFixed(3);
  const dur = durationSec.toFixed(3);

  // Always re-encode so the clip starts on a fresh I-frame — stream copy risks clips that
  // start mid-GOP, which browsers cannot decode and show as corrupt/no-preview.
  const _ = preferStreamCopy; // reserved for future use
  const strategies: string[] = [
    `${ffmpegBin()} -y -ss ${start} -i "${inputPath}" -t ${dur} ` +
      `-c:v libx264 -preset ultrafast -crf 23 -an -pix_fmt yuv420p -movflags +faststart ` +
      `-avoid_negative_ts make_zero -reset_timestamps 1 -threads 2 "${outputPath}"`,
    `${ffmpegBin()} -y -i "${inputPath}" -ss ${start} -t ${dur} ` +
      `-c:v libx264 -preset ultrafast -crf 23 -an -pix_fmt yuv420p -movflags +faststart ` +
      `-avoid_negative_ts make_zero -reset_timestamps 1 -threads 2 "${outputPath}"`,
  ];

  let lastErr = "extract failed";
  for (const cmd of strategies) {
    try {
      const { stderr: ffstderr } = await exec(cmd, { maxBuffer: 8 * 1024 * 1024, timeout: perClipTimeout });
      const fileSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
      if (fileSize >= 8000) return;
      // FFmpeg exited 0 but produced no usable output — log stderr so we can diagnose.
      const stderrSnip = (ffstderr ?? "").slice(-400).replace(/\n/g, " ").trim();
      console.warn(`[ArchiveSplit] ffmpeg exit0 empty output (ss=${start} size=${fileSize}B): ${stderrSnip.slice(0, 350)}`);
      try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
    } catch (err) {
      const errMsg = (err as Error).message ?? "";
      const stderr = (err as { stderr?: string }).stderr ?? "";
      const stderrTail = stderr.length > 400 ? stderr.slice(-500) : stderr;
      console.warn(`[ArchiveSplit] ffmpeg error (ss=${start}): ${errMsg.slice(0, 120)} | ${stderrTail.replace(/\n/g, " ").trim().slice(0, 350)}`);
      lastErr = errMsg.slice(0, 160) || lastErr;
      try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
    }
  }
  throw new Error(lastErr);
}

async function splitSegmentBufferAtInteriorCuts(
  seg: VideoClipSegment,
  workDir: string,
  label: string,
  depth: number,
  deadlineMs: number,
  shouldContinue?: () => boolean
): Promise<VideoClipSegment[]> {
  if (depth >= SINGLE_SCENE_VALIDATE_MAX_DEPTH || Date.now() >= deadlineMs) return [seg];
  if (shouldContinue && !shouldContinue()) return [seg];
  if (seg.durationSec < MIN_SCENE_SEC * 2) return [seg];

  const clipPath = path.join(workDir, `${label}_scene_check.mp4`);
  fs.writeFileSync(clipPath, seg.buffer);
  const interior = await detectInteriorCutTimesInFile(clipPath, seg.durationSec);

  if (interior.length === 0) {
    try {
      fs.unlinkSync(clipPath);
    } catch {
      /* ignore */
    }
    return [seg];
  }

  const subRanges = buildClipRanges(interior, seg.durationSec, maxArchiveClips(), cutMergeGapSec());
  if (subRanges.length <= 1) {
    try {
      fs.unlinkSync(clipPath);
    } catch {
      /* ignore */
    }
    return [seg];
  }

  console.log(
    `[ArchiveSplit] clip ${formatTimecode(seg.startSec)}–${formatTimecode(seg.endSec)} still has ` +
      `${interior.length} interior cut(s) → splitting into ${subRanges.length} scene(s)`
  );

  const refined: VideoClipSegment[] = [];
  for (let i = 0; i < subRanges.length; i++) {
    if (Date.now() >= deadlineMs || (shouldContinue && !shouldContinue())) break;
    const { start, end } = subRanges[i];
    const outPath = path.join(workDir, `${label}_part_${i}.mp4`);
    try {
      await extractVideoSegment(clipPath, outPath, start, end);
    } catch (err) {
      console.warn(`[ArchiveSplit] single-scene sub-extract failed:`, (err as Error).message?.slice(0, 80));
      continue;
    }
    if (!fs.existsSync(outPath)) continue;
    const buf = fs.readFileSync(outPath);
    if (buf.length < 8000) continue;
    const subSeg: VideoClipSegment = {
      buffer: buf,
      startSec: seg.startSec + start,
      endSec: seg.startSec + end,
      durationSec: end - start,
      index: seg.index,
    };
    const nested = await splitSegmentBufferAtInteriorCuts(
      subSeg,
      workDir,
      `${label}_p${i}`,
      depth + 1,
      deadlineMs,
      shouldContinue
    );
    refined.push(...nested);
    if (refined.length >= maxArchiveClips()) break;
  }

  try {
    fs.unlinkSync(clipPath);
  } catch {
    /* ignore */
  }

  return refined.length > 0 ? refined : [seg];
}

/** Re-split any extracted clip that still contains multiple shots. */
async function enforceSingleSceneClipSegments(
  segments: VideoClipSegment[],
  workDir: string,
  deadlineMs: number,
  shouldContinue?: () => boolean
): Promise<VideoClipSegment[]> {
  const out: VideoClipSegment[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (Date.now() >= deadlineMs || (shouldContinue && !shouldContinue())) {
      out.push(...segments.slice(i));
      break;
    }
    const parts = await splitSegmentBufferAtInteriorCuts(
      segments[i],
      workDir,
      `seg${String(i).padStart(3, "0")}`,
      0,
      deadlineMs,
      shouldContinue
    );
    out.push(...parts);
    if (out.length >= maxArchiveClips()) {
      console.warn(`[ArchiveSplit] single-scene cap ${maxArchiveClips()} reached — remaining clips skipped`);
      break;
    }
  }
  return out
    .sort((a, b) => a.startSec - b.startSec)
    .slice(0, maxArchiveClips())
    .map((seg, index) => ({ ...seg, index }));
}

/** Low-res analysis proxy when codecs/containers confuse shot detectors (not a full re-encode). */
async function normalizeSourceForAnalysis(
  inputPath: string,
  workDir: string,
  totalDur: number,
  onProgress?: ArchiveSplitProgressFn
): Promise<string> {
  const outPath = path.join(workDir, "analysis_normalized.mp4");
  onProgress?.({
    stage: "split_probe",
    message: `Building analysis proxy for shot detection (${Math.round(totalDur / 60)} min)…`,
    percent: 15,
  });

  const vf = analysisProxyScaleFilter(totalDur);
  const timeoutMs = Math.round(Math.min(900_000, Math.max(90_000, totalDur * 80)));
  try {
    await exec(
      `${ffmpegBin()} -y -i "${inputPath}" -an -vf "${vf}" ` +
        `-c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -movflags +faststart -threads 2 "${outPath}"`,
      { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs }
    );
  } catch (err) {
    const hint = (err as { killed?: boolean }).killed
      ? "Server ran out of time or memory"
      : ((err as Error).message?.slice(0, 120) ?? "FFmpeg failed");
    throw new ArchiveSplitError(
      `Could not prepare this video for shot detection (${Math.round(totalDur / 60)} min). ` +
        `${hint}. Try a shorter clip, export at 30fps, or turn off auto-split.`
    );
  }

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 8000) {
    throw new ArchiveSplitError("Video analysis proxy failed — check that the file is playable.");
  }
  return outPath;
}

async function probeVideoCodec(inputPath: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      `${ffprobeBin()} -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
      { timeout: 20_000 }
    );
    const codec = String(stdout).trim().toLowerCase();
    return codec || null;
  } catch {
    return null;
  }
}

/** Pick the file to scan — prefer H.264 MP4 sources, otherwise normalize once. */
async function prepareAnalysisVideo(
  inputPath: string,
  workDir: string,
  totalDur: number,
  onProgress?: ArchiveSplitProgressFn
): Promise<string> {
  const ext = path.extname(inputPath).toLowerCase();
  const codec = await probeVideoCodec(inputPath);
  const isH264 = isH264Codec(codec);
  if (ext === ".mp4" && (isH264 || !codec)) {
    return inputPath;
  }
  console.log(
    `[ArchiveSplit] normalizing ${ext || "unknown"} (${codec ?? "unknown codec"}) → H.264 MP4 for shot detect`
  );
  return normalizeSourceForAnalysis(inputPath, workDir, totalDur, onProgress);
}

function formatTimecode(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Extract all clips in a SINGLE ffmpeg pass using the segment muxer.
 *
 * Why: individual `-ss seek` calls require ffmpeg to decode from the nearest keyframe.
 * With sparse keyframes (e.g. every 5 minutes) this means decoding minutes of video per
 * clip and hitting the per-clip timeout. One linear pass avoids all seeking entirely.
 */
async function extractAllClipsSinglePass(
  inputPath: string,
  clipDir: string,
  ranges: Array<{ start: number; end: number }>,
  skipRangeSubjectFilter: boolean,
  onProgress: ((p: ArchiveSplitProgress) => void) | undefined,
  onSegment: ArchiveSplitOptions["onSegment"],
  shouldContinue: (() => boolean) | undefined
): Promise<{ segments: VideoClipSegment[]; successCount: number; failedCount: number }> {
  if (ranges.length === 0) return { segments: [], successCount: 0, failedCount: 0 };

  // Build sorted unique cut points from ALL range boundaries so gaps are preserved.
  const cutSet = new Set<number>();
  for (const r of ranges) {
    cutSet.add(r.start);
    cutSet.add(r.end);
  }
  const sortedCuts = Array.from(cutSet).sort((a, b) => a - b);

  // Start reading from first range start, stop at last range end.
  const passStart = sortedCuts[0];
  const passEnd = sortedCuts[sortedCuts.length - 1];
  const passDuration = passEnd - passStart;

  // segment_times must be relative to the output start (passStart), because -reset_timestamps 1
  // resets output PTS to 0. Internal cuts = absolute_time - passStart.
  const segmentTimes = sortedCuts
    .slice(1, -1)
    .map((t) => (t - passStart).toFixed(3))
    .join(",");

  // Match output file index → desired range. Output file i covers sortedCuts[i]–sortedCuts[i+1].
  const segmentCount = sortedCuts.length - 1;
  type SegmentSlot = { rangeIndex: number; start: number; end: number } | null;
  const slotMap: SegmentSlot[] = Array.from({ length: segmentCount }, (_, si) => {
    const segStart = sortedCuts[si];
    const segEnd = sortedCuts[si + 1];
    const ri = ranges.findIndex(
      (r) => Math.abs(r.start - segStart) < 0.05 && Math.abs(r.end - segEnd) < 0.05
    );
    return ri >= 0 ? { rangeIndex: ri, start: segStart, end: segEnd } : null;
  });

  const outputPattern = path.join(clipDir, "singlepass_%04d.mp4");

  // Timeout: 5× real-time + 60s base. Under server load ultrafast encode can run at ~1.5–2× real-time,
  // so 1× was not enough. Cap at 2 hours for very long sources.
  const timeoutMs = Math.round(Math.max(300_000, passDuration * 5000 + 60_000));

  // Use slow-seek (-ss AFTER -i) so ffmpeg decodes linearly — no keyframe hunting.
  const ssArgs = passStart > 0.5 ? `-ss ${passStart.toFixed(3)}` : "";
  const cmd = [
    `${ffmpegBin()} -y -i "${inputPath}"`,
    ssArgs,
    `-t ${passDuration.toFixed(3)}`,
    `-c:v libx264 -preset ultrafast -crf 23 -an -pix_fmt yuv420p`,
    `-movflags +faststart -avoid_negative_ts make_zero -reset_timestamps 1 -threads 2`,
    `-f segment`,
    segmentTimes ? `-segment_times "${segmentTimes}"` : "",
    `-segment_start_number 0`,
    `"${outputPattern}"`,
  ]
    .filter(Boolean)
    .join(" ");

  console.log(
    `[ArchiveSplit] single-pass: ${ranges.length} clips, span=${passDuration.toFixed(1)}s, ` +
      `segments=${segmentCount}, timeout=${(timeoutMs / 1000).toFixed(0)}s`
  );

  try {
    await exec(cmd, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    console.warn(
      `[ArchiveSplit] single-pass ffmpeg finished with error (partial output may exist): ` +
        `${(err as Error).message?.slice(0, 120)} | stderr_tail=${stderr.slice(-300).replace(/\n/g, " ").trim()}`
    );
  }

  // Collect output files, match to ranges, call onSegment in order.
  const segments: VideoClipSegment[] = [];
  let successCount = 0;
  let failedCount = 0;

  for (let si = 0; si < segmentCount; si++) {
    if (shouldContinue && !shouldContinue()) break;

    const slot = slotMap[si];
    const filePath = path.join(clipDir, `singlepass_${String(si).padStart(4, "0")}.mp4`);

    if (!fs.existsSync(filePath)) {
      if (slot) failedCount++;
      continue;
    }
    const fileSize = fs.statSync(filePath).size;

    if (!slot) {
      // Gap segment (not a desired range) — delete it.
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      continue;
    }

    if (fileSize < 8000) {
      if (si < 5 || si % 50 === 0) {
        console.warn(
          `[ArchiveSplit] single-pass clip ${si} (${formatTimecode(slot.start)}–${formatTimecode(slot.end)}) empty (${fileSize}B)`
        );
      }
      failedCount++;
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      continue;
    }

    const meta: Omit<VideoClipSegment, "buffer" | "localPath"> = {
      startSec: slot.start,
      endSec: slot.end,
      durationSec: slot.end - slot.start,
      index: slot.rangeIndex,
      timeFallback: skipRangeSubjectFilter || undefined,
    };

    onProgress?.({
      stage: "split_extract",
      message: `Saving clip ${successCount + 1}/${ranges.length}: ${formatTimecode(slot.start)}–${formatTimecode(slot.end)}`,
      percent: 52 + Math.round(((successCount + 1) / ranges.length) * 33),
      clipIndex: successCount + 1,
      clipTotal: ranges.length,
    });

    if (onSegment) {
      try { await onSegment(filePath, meta); }
      finally { try { fs.unlinkSync(filePath); } catch { /* ignore */ } }
      segments.push({ buffer: Buffer.alloc(0), ...meta });
    } else {
      segments.push({ buffer: Buffer.alloc(0), localPath: filePath, ...meta });
    }
    successCount++;
  }

  return { segments, successCount, failedCount };
}

export type ArchiveSplitOptions = {
  subjectContext?: ArchiveSubjectContext;
  /**
   * Called immediately after each clip is extracted and ready on disk.
   * The file at localPath is deleted by the splitter right after this callback returns.
   * Use this to upload each clip to S3 before the next clip is written to disk,
   * keeping disk usage bounded to extractConcurrency × clipSize at any time.
   */
  onSegment?: (localPath: string, meta: Omit<VideoClipSegment, "buffer" | "localPath">) => Promise<void>;
};

export type SplitVideoResult = {
  segments: VideoClipSegment[];
  /** Call after all segments have been read/uploaded to free temp disk space. */
  cleanup: () => void;
};

/**
 * Detect shot/scene changes and return one file path per clip (lazy-load).
 * Caller must invoke result.cleanup() after consuming all segments.
 */
export async function splitVideoBySceneChanges(
  inputBuffer: Buffer,
  mimeType: string,
  onProgress?: ArchiveSplitProgressFn,
  shouldContinue?: () => boolean,
  options?: ArchiveSplitOptions
): Promise<SplitVideoResult> {
  const startedAt = Date.now();
  const deadline = startedAt + splitBudgetMs();
  const hasBudget = () => Date.now() < deadline;
  const canContinue = () => hasBudget() && (shouldContinue?.() ?? true);
  const throwIfCancelled = () => {
    if (shouldContinue && !shouldContinue()) {
      throw new ArchiveSplitError("Upload cancelled");
    }
  };

  const report = (progress: ArchiveSplitProgress) => onProgress?.(progress);

  throwIfCancelled();

  report({ stage: "split_ffmpeg", message: "Checking FFmpeg availability…", percent: 8 });
  await assertFfmpegAvailable();

  // The source file is already in RAM as inputBuffer — write it to /tmp (tmpfs) so it never
  // consumes space on the Railway volume. Clip output files (max 4 at a time × ~5MB each = ~20MB)
  // go to the volume so they survive the heavier I/O without touching RAM-backed storage.
  const sourceBase = os.tmpdir(); // /tmp — source file stays in RAM (same as inputBuffer)
  const clipBase =
    (process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() && fs.existsSync(process.env.RAILWAY_VOLUME_MOUNT_PATH.trim()))
      ? process.env.RAILWAY_VOLUME_MOUNT_PATH.trim()
      : fs.existsSync("/data") ? "/data" : os.tmpdir();

  // Clean up stale clip temp dirs from previous killed/crashed uploads.
  if (clipBase !== sourceBase) {
    try {
      const staleMs = 2 * 60 * 60 * 1000; // 2 hours
      let cleaned = 0;
      for (const entry of fs.readdirSync(clipBase)) {
        if (!entry.startsWith("fastvid-archive-split-")) continue;
        const full = path.join(clipBase, entry);
        try {
          if (Date.now() - fs.statSync(full).mtimeMs > staleMs) {
            fs.rmSync(full, { recursive: true, force: true });
            cleaned++;
          }
        } catch { /* ignore */ }
      }
      if (cleaned > 0) console.log(`[ArchiveSplit] cleaned ${cleaned} stale temp dir(s) from ${clipBase}`);
    } catch { /* ignore */ }
  }

  // Log disk space on both paths.
  try {
    const { stdout: dfOut } = await execPromise(`df -h "${clipBase}" 2>/dev/null | tail -1`, { timeout: 5000 });
    console.log(`[ArchiveSplit] disk (${clipBase}): ${dfOut.trim()}`);
  } catch { /* ignore */ }

  // workDir holds only the source file; clips go to a separate dir on the volume.
  const workDir = fs.mkdtempSync(path.join(sourceBase, "fastvid-archive-split-src-"));
  const clipDir = fs.mkdtempSync(path.join(clipBase, "fastvid-archive-split-"));
  try {
    const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("quicktime") || mimeType.includes("mov") ? "mov" : "mp4";
    const inputPath = path.join(workDir, `source.${ext}`);
    console.log(`[ArchiveSplit] writing ${(inputBuffer.length / (1024 * 1024)).toFixed(1)}MB source → ${inputPath}`);
    fs.writeFileSync(inputPath, inputBuffer);
    const writtenBytes = fs.statSync(inputPath).size;
    if (writtenBytes !== inputBuffer.length) {
      throw new ArchiveSplitError(
        `Source file truncated (${writtenBytes}/${inputBuffer.length} bytes) — /tmp may be full`
      );
    }
    console.log(`[ArchiveSplit] source written ok (${writtenBytes} bytes)`);



    report({ stage: "split_probe", message: "Measuring video duration (ffprobe)…", percent: 12 });
    const totalDur = await probeVideoDurationSec(inputPath);
    // Diagnose source file to catch truncated uploads or weird container issues.
    try {
      const ffprobe = process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
      const { stdout: probeOut } = await execPromise(
        `${ffprobe} -v error -select_streams v:0 -show_entries stream=codec_name,nb_frames,duration,bit_rate -show_entries format=size,duration -of json "${inputPath}"`,
        { timeout: 15_000 }
      );
      const probe = JSON.parse(probeOut) as { streams?: Array<{ codec_name?: string; nb_frames?: string; duration?: string; bit_rate?: string }>; format?: { size?: string; duration?: string } };
      const stream = probe.streams?.[0];
      console.log(
        `[ArchiveSplit] source probe: bufSize=${(inputBuffer.length / (1024 * 1024)).toFixed(1)}MB ` +
        `fileSize=${probe.format?.size ?? "?"} ` +
        `format_dur=${probe.format?.duration ?? "?"} ` +
        `stream_dur=${stream?.duration ?? "?"} ` +
        `codec=${stream?.codec_name ?? "?"} ` +
        `nb_frames=${stream?.nb_frames ?? "?"} ` +
        `bitrate=${stream?.bit_rate ?? "?"}`
      );
    } catch (probeErr) {
      console.warn(`[ArchiveSplit] source probe failed:`, (probeErr as Error).message?.slice(0, 100));
    }
    if (totalDur <= 0) {
      throw new ArchiveSplitError("Could not determine video duration (ffprobe). File may be corrupt or unsupported.");
    }

    // No duration limit — all videos are accepted regardless of length.

    // Trust the container-reported duration. Fast-seek probing (probeActualVideoDuration) was
    // unreliable for files with sparse keyframes — ffprobe timed out at 90% of duration and the
    // binary search converged to ~10s, falsely truncating all processing to a tiny window.
    const effectiveDur = totalDur;

    if (effectiveDur < MIN_SCENE_SEC * 2) {
      if (effectiveDur < minSavedArchiveClipSec() - 0.05) {
        throw new ArchiveSplitError(
          `Video too short (${effectiveDur.toFixed(1)}s). Each archive clip must be at least ${minSavedArchiveClipSec()} seconds.`
        );
      }
      const cleanup = () => {
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(clipDir, { recursive: true, force: true }); } catch { /* ignore */ }
      };
      return { segments: [{ buffer: inputBuffer, startSec: 0, endSec: effectiveDur, durationSec: effectiveDur, index: 0 }], cleanup };
    }

    report({
      stage: "split_detect",
      message: `Starting shot detection (${Math.round(effectiveDur)}s video)…`,
      percent: 18,
    });

    let analysisPath = await prepareAnalysisVideo(inputPath, workDir, effectiveDur, report);
    let cuts = await detectSceneCutTimes(analysisPath, effectiveDur, deadline);

    // Retry on normalized video when exotic codecs/containers hid cuts on the first pass.
    if (cuts.length < 2 && effectiveDur > MIN_SPLIT_VIDEO_SEC && analysisPath === inputPath) {
      analysisPath = await normalizeSourceForAnalysis(inputPath, workDir, effectiveDur, report);
      cuts = await detectSceneCutTimes(analysisPath, effectiveDur, deadline);
      console.log(`[ArchiveSplit] retry after normalize: ${cuts.length} cut(s)`);
    }

    let ranges = buildClipRanges(cuts, effectiveDur);
    ranges = mergeFlashFragmentsOnly(ranges);
    ranges = filterClipRangesBelowMinDuration(ranges, 2.0);
    if (ranges.length > 1 && hasBudget()) {
      for (let pass = 0; pass < INTERNAL_RESCAN_PASSES && hasBudget(); pass++) {
        throwIfCancelled();
        const before = ranges.length;
        report({
          stage: "split_rescan",
          message: `Rescanning for missed cuts — pass ${pass + 1}/${INTERNAL_RESCAN_PASSES} (${ranges.length} segments)…`,
          percent: 38 + pass * 4,
        });
        ranges = await rescanRangesForInteriorCuts(analysisPath, ranges, deadline, shouldContinue);
        ranges = mergeFlashFragmentsOnly(ranges);
        ranges = filterClipRangesBelowMinDuration(ranges, 2.0);
        if (ranges.length === before) break;
      }
    }
    ranges = capClipRanges(ranges, maxArchiveClips());

    const skipRangeSubjectFilter = false;
    if (ranges.length <= 1) {
      console.warn(`[ArchiveSplit] no shot boundaries detected in ${effectiveDur.toFixed(1)}s video — will split on max duration`);
    }

    // Always split any range longer than maxClipDurationSec into equal sub-intervals.
    // This catches shots without hard cuts (dissolves, fades, long uncut scenes).
    const beforeMaxDur = ranges.length;
    ranges = splitLongRanges(ranges);
    ranges = filterClipRangesBelowMinDuration(ranges, 2.0);
    ranges = capClipRanges(ranges, maxArchiveClips());
    if (ranges.length !== beforeMaxDur) {
      console.log(
        `[ArchiveSplit] max-duration split: ${beforeMaxDur} → ${ranges.length} clip(s) (max ${maxClipDurationSec()}s each)`
      );
    }

    console.log(
      `[ArchiveSplit] ${cuts.length} shot cuts → ${ranges.length} clip(s) (effectiveDur=${effectiveDur.toFixed(1)}s, ` +
        `scdet=${scdetThreshold()} scene=${sceneThreshold()} maxDur=${maxClipDurationSec()}s)`
    );

    throwIfCancelled();

    // Pre-extraction readability check: probe 1 frame at 1/3 and 2/3 of the container duration
    // using slow-seek (ss after -i) so keyframe gaps don't cause false misses.
    // This diagnoses genuinely truncated files without affecting extraction.
    {
      const ffp = ffprobeBin();
      for (const frac of [1 / 3, 2 / 3]) {
        const pos = (totalDur * frac).toFixed(1);
        try {
          const { stdout } = await execPromise(
            `${ffp} -v error -i "${inputPath}" -ss ${pos} -select_streams v:0 -frames:v 1 -show_entries frame=pts_time -of json`,
            { timeout: 60_000 }
          );
          const d = JSON.parse(String(stdout)) as { frames?: Array<{ pts_time?: string }> };
          const frames = d.frames ?? [];
          console.log(
            `[ArchiveSplit] readability check at ${pos}s/${totalDur.toFixed(0)}s: ${frames.length > 0 ? `OK (pts=${frames[0]?.pts_time ?? "?"})` : "NO FRAMES — source may be truncated here"}`
          );
        } catch (e) {
          console.warn(`[ArchiveSplit] readability check at ${pos}s failed: ${(e as Error).message?.slice(0, 80)}`);
        }
      }
    }

    const onSegment = options?.onSegment;

    // Clamp all ranges to the probed video duration and drop sub-1s clips up front.
    const MIN_EXTRACT_SEC = 1.0;
    const clampedRanges = ranges.map((r) => ({
      start: r.start,
      end: Math.min(r.end, totalDur),
    }));
    const skippedEndOfVideo = clampedRanges.filter((r) => r.end - r.start < MIN_EXTRACT_SEC).length;
    const extractRanges = clampedRanges.filter((r) => r.end - r.start >= MIN_EXTRACT_SEC);

    console.log(
      `[ArchiveSplit] extraction plan: duration=${totalDur.toFixed(2)}s ` +
        `expected=${ranges.length} after_clamp=${extractRanges.length} skipped_short=${skippedEndOfVideo}`
    );

    report({
      stage: "split_extract",
      message: `Extracting ${extractRanges.length} clips…`,
      percent: 52,
      clipTotal: extractRanges.length,
      clipIndex: 0,
    });

    // Primary strategy: per-clip parallel extraction using fast-seek.
    // Fast-seek (-ss before -i) snaps to the nearest keyframe and re-encodes,
    // which is reliable for any container/codec and handles sparse keyframes correctly.
    // The segment muxer was the previous primary but produced empty files for clips
    // that didn't align with keyframe boundaries.
    let successCount = 0;
    let failedCount = 0;
    const streamCopyExtract = false; // always re-encode for correctness

    const perClipResults = await mapPool(
      extractRanges,
      extractConcurrency(),
      async (range, i) => {
        const { start, end } = range;
        const outPath = path.join(clipDir, `clip_${String(i).padStart(3, "0")}.mp4`);
        report({
          stage: "split_extract",
          message: `Clip ${i + 1}/${extractRanges.length}: ${formatTimecode(start)}–${formatTimecode(end)}`,
          percent: 52 + Math.round(((i + 1) / extractRanges.length) * 33),
          clipIndex: i + 1,
          clipTotal: extractRanges.length,
        });
        try {
          await extractVideoSegment(inputPath, outPath, start, end, streamCopyExtract);
          const fileSize = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
          if (fileSize < 8000) {
            if (i < 5 || i % 50 === 0) {
              console.warn(`[ArchiveSplit] clip ${i} (${formatTimecode(start)}–${formatTimecode(end)}) empty (${fileSize}B)`);
            }
            failedCount++;
            try { fs.unlinkSync(outPath); } catch { /* ignore */ }
            return null;
          }
          const meta: Omit<VideoClipSegment, "buffer" | "localPath"> = {
            startSec: start, endSec: end, durationSec: end - start, index: i,
            timeFallback: skipRangeSubjectFilter || undefined,
          };
          if (onSegment) {
            try { await onSegment(outPath, meta); }
            finally { try { fs.unlinkSync(outPath); } catch { /* ignore */ } }
            successCount++;
            return { buffer: Buffer.alloc(0), ...meta } satisfies VideoClipSegment;
          }
          successCount++;
          return { buffer: Buffer.alloc(0), localPath: outPath, ...meta } satisfies VideoClipSegment;
        } catch (err) {
          failedCount++;
          console.warn(`[ArchiveSplit] clip ${i} failed:`, (err as Error).message?.slice(0, 100));
          try { fs.unlinkSync(outPath); } catch { /* ignore */ }
          return null;
        }
      },
      canContinue
    );
    let segments = (perClipResults.filter((s) => s != null) as VideoClipSegment[]);

    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[ArchiveSplit] extraction complete: duration=${totalDur.toFixed(2)}s ` +
        `expected=${extractRanges.length} success=${successCount} ` +
        `skipped_end_of_video=${skippedEndOfVideo} failed_ffmpeg=${failedCount} elapsed=${elapsedS}s`
    );

    segments = segments
      .filter((s) => s.durationSec >= 2.0 - 0.05)
      .sort((a, b) => a.startSec - b.startSec)
      .map((seg, index) => ({ ...seg, index } as VideoClipSegment));

    throwIfCancelled();

    if (segments.length === 0) {
      // Single-pass produced nothing (exotic codec / container issue).
      // Re-encode to plain h264, rebuild ranges from the same cuts, and retry extraction.
      console.warn(`[ArchiveSplit] extraction produced 0 clips — re-encoding source and retrying`);
      try {
        const reencPath = path.join(workDir, "reenc.mp4");
        const reencTimeout = Math.round(Math.max(120_000, totalDur * 5000 + 60_000));
        await exec(
          `${ffmpegBin()} -y -i "${inputPath}" -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p -an -movflags +faststart -threads 2 "${reencPath}"`,
          { maxBuffer: 8 * 1024 * 1024, timeout: reencTimeout }
        );
        const retryResults = await mapPool(
          extractRanges,
          extractConcurrency(),
          async (range, i) => {
            const { start, end } = range;
            const outPath = path.join(clipDir, `reenc_clip_${String(i).padStart(3, "0")}.mp4`);
            try {
              await extractVideoSegment(reencPath, outPath, start, end, false);
              const fileSize = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
              if (fileSize < 8000) { try { fs.unlinkSync(outPath); } catch { /* ignore */ } return null; }
              const meta: Omit<VideoClipSegment, "buffer" | "localPath"> = {
                startSec: start, endSec: end, durationSec: end - start, index: i,
                timeFallback: skipRangeSubjectFilter || undefined,
              };
              if (onSegment) {
                try { await onSegment(outPath, meta); } finally { try { fs.unlinkSync(outPath); } catch { /* ignore */ } }
                return { buffer: Buffer.alloc(0), ...meta } satisfies VideoClipSegment;
              }
              return { buffer: Buffer.alloc(0), localPath: outPath, ...meta } satisfies VideoClipSegment;
            } catch { try { fs.unlinkSync(outPath); } catch { /* ignore */ } return null; }
          },
          canContinue
        );
        const retrySegments = retryResults.filter((s) => s != null) as VideoClipSegment[];
        if (retrySegments.length > 0) {
          segments = retrySegments.filter((s) => s.durationSec >= 2.0 - 0.05);
          successCount = segments.length;
          failedCount = extractRanges.length - successCount;
          console.log(`[ArchiveSplit] re-encode retry: ${segments.length} clips recovered`);
        }
      } catch (reencErr) {
        console.warn(`[ArchiveSplit] re-encode retry failed: ${(reencErr as Error).message?.slice(0, 120)}`);
      }
    }
    if (segments.length < extractRanges.length * 0.05 && extractRanges.length > 10) {
      console.warn(
        `[ArchiveSplit] WARNING: only ${segments.length}/${extractRanges.length} clips extracted ` +
          `(${Math.round((segments.length / extractRanges.length) * 100)}%). ` +
          `Source may be truncated — data ends around ${formatTimecode(segments[segments.length - 1]?.endSec ?? 0)}.`
      );
    }
    if (segments.length < extractRanges.length) {
      console.warn(`[ArchiveSplit] partial extract: ${segments.length}/${extractRanges.length} clips — continuing`);
    }

    // enforceSingleSceneClipSegments disabled — with low thresholds + splitLongRanges,
    // clips are already ≤10s and re-scanning creates false-positive sub-3s fragments.
    console.log(`[ArchiveSplit] returning ${segments.length} clip(s)`);

    const cleanup = () => {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(clipDir, { recursive: true, force: true }); } catch { /* ignore */ }
    };
    return { segments, cleanup };
  } catch (err) {
    // On error, clean up immediately since no segments are returned.
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(clipDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
}

export { formatTimecode };
