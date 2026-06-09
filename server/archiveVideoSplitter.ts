/**
 * Split archive videos at real shot/scene boundaries — NOT on fixed time intervals.
 * Uses FFmpeg scdet (shot-change) + scene filter (visual diff) on every downscaled frame.
 */
import { exec as execCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const exec = promisify(execCb);

export type VideoClipSegment = {
  buffer: Buffer;
  startSec: number;
  endSec: number;
  durationSec: number;
  index: number;
};

/** Drop only sub-frame detection noise — never merge real shots for being "too short". */
const MIN_SCENE_SEC = 0.12;
const MAX_CLIPS = 120;
const DEFAULT_SCENE_THRESHOLD = 0.28;
const DEFAULT_SCDET_THRESHOLD = 8;
const DEFAULT_CUT_MERGE_GAP_SEC = 0.22;
const DEFAULT_SPLIT_BUDGET_MS = 540_000;
const DEFAULT_MAX_SOURCE_SEC = 20 * 60;
const DEFAULT_MAX_UPLOAD_MB = 600;

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
}

export function sceneThreshold(): number {
  const raw = process.env.ARCHIVE_SCENE_THRESHOLD?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.08 && n <= 0.9) return n;
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

/** @deprecated kept for env compat — no longer merges short shots together */
export function minClipSec(): number {
  const raw = process.env.ARCHIVE_MIN_CLIP_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.1 && n <= 5) return n;
  }
  return MIN_SCENE_SEC;
}

export function cutMergeGapSec(): number {
  const raw = process.env.ARCHIVE_CUT_MERGE_GAP?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.1 && n <= 1) return n;
  }
  return DEFAULT_CUT_MERGE_GAP_SEC;
}

export function splitBudgetMs(): number {
  const raw = process.env.ARCHIVE_SPLIT_BUDGET_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 120_000 && n <= 600_000) return n;
  }
  return DEFAULT_SPLIT_BUDGET_MS;
}

export function maxArchiveVideoDurationSec(): number {
  const raw = process.env.ARCHIVE_MAX_VIDEO_DURATION_SEC?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 60 && n <= 3600) return n;
  }
  return DEFAULT_MAX_SOURCE_SEC;
}

export function maxArchiveUploadBytes(): number {
  const raw = process.env.ARCHIVE_MAX_UPLOAD_MB?.trim();
  if (raw) {
    const mb = parseInt(raw, 10);
    if (!isNaN(mb) && mb >= 50 && mb <= 2048) return mb * 1024 * 1024;
  }
  return DEFAULT_MAX_UPLOAD_MB * 1024 * 1024;
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
  return mergeNearbyCuts(cutLists.flat(), cutMergeGapSec());
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
  maxClips = MAX_CLIPS,
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

  // Cap clip count by merging the shortest adjacent pair (least content lost).
  while (ranges.length > maxClips) {
    let mergeIdx = 0;
    let shortest = ranges[0].end - ranges[0].start;
    for (let i = 1; i < ranges.length; i++) {
      const d = ranges[i].end - ranges[i].start;
      if (d < shortest) {
        shortest = d;
        mergeIdx = i;
      }
    }
    if (mergeIdx === 0) {
      ranges[0].end = ranges[1].end;
      ranges.splice(1, 1);
    } else {
      ranges[mergeIdx - 1].end = ranges[mergeIdx].end;
      ranges.splice(mergeIdx, 1);
    }
  }

  return ranges;
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

/** scdet — purpose-built shot/scene boundary detector (every frame, downscaled). */
async function detectScdetCutTimes(
  inputPath: string,
  totalDur: number,
  threshold: number,
  timeoutMs: number
): Promise<number[]> {
  const cmd =
    `${ffmpegBin()} -i "${inputPath}" -an ` +
    `-vf "scale=480:-1,scdet=threshold=${threshold}:sc_pass=1,showinfo" -f null -`;
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
  const cmd =
    `${ffmpegBin()} -i "${inputPath}" -an ` +
    `-vf "scale=480:-1,select='gt(scene,${threshold})',showinfo" -f null -`;
  const stderr = await runFfmpegDetect(cmd, timeoutMs);
  return mergeNearbyCuts(parsePtsTimesFromFfmpeg(stderr, totalDur), cutMergeGapSec());
}

async function detectSceneCutTimes(inputPath: string, totalDur: number, deadlineMs: number): Promise<number[]> {
  const detectTimeout = Math.min(300_000, Math.max(60_000, deadlineMs - Date.now()));
  const scdetBudget = Math.floor(detectTimeout * 0.5);
  const sceneBudget = Math.floor(detectTimeout * 0.5);

  const scdetCuts = await detectScdetCutTimes(inputPath, totalDur, scdetThreshold(), scdetBudget);
  const sceneCuts = await detectSceneFilterCutTimes(inputPath, totalDur, sceneThreshold(), sceneBudget);
  let cuts = combineShotCutTimes([scdetCuts, sceneCuts]);

  console.log(
    `[ArchiveSplit] shot detect: scdet=${scdetCuts.length} scene=${sceneCuts.length} combined=${cuts.length}`
  );

  // If almost no shots found on a long video, retry both detectors more sensitively.
  if (cuts.length < 2 && totalDur > 15) {
    const scdet2 = await detectScdetCutTimes(
      inputPath,
      totalDur,
      Math.max(3, scdetThreshold() * 0.6),
      Math.floor(sceneBudget * 0.5)
    );
    const scene2 = await detectSceneFilterCutTimes(
      inputPath,
      totalDur,
      Math.max(0.1, sceneThreshold() * 0.55),
      Math.floor(sceneBudget * 0.5)
    );
    const retry = combineShotCutTimes([scdet2, scene2]);
    if (retry.length > cuts.length) {
      console.log(`[ArchiveSplit] sensitive shot retry: ${retry.length} cuts (was ${cuts.length})`);
      cuts = retry;
    }
  }

  return cuts;
}

async function extractVideoSegment(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number
): Promise<void> {
  const perClipTimeout = Math.max(30_000, Math.min(120_000, durationSec * 4000));
  await exec(
    `${ffmpegBin()} -y -ss ${startSec.toFixed(3)} -i "${inputPath}" -t ${durationSec.toFixed(3)} ` +
      `-c:v libx264 -preset ultrafast -crf 23 -an -pix_fmt yuv420p -movflags +faststart -threads 2 "${outputPath}"`,
    { maxBuffer: 8 * 1024 * 1024, timeout: perClipTimeout }
  );
}

function formatTimecode(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Detect shot/scene changes and return one buffer per clip.
 * Never splits on fixed time intervals — only on detected visual cuts.
 */
export async function splitVideoBySceneChanges(
  inputBuffer: Buffer,
  mimeType: string
): Promise<VideoClipSegment[]> {
  const startedAt = Date.now();
  const deadline = startedAt + splitBudgetMs();
  const hasBudget = () => Date.now() < deadline;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-archive-split-"));
  try {
    const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("quicktime") || mimeType.includes("mov") ? "mov" : "mp4";
    const inputPath = path.join(workDir, `source.${ext}`);
    fs.writeFileSync(inputPath, inputBuffer);

    const totalDur = await probeVideoDurationSec(inputPath);
    const maxDur = maxArchiveVideoDurationSec();
    if (totalDur > maxDur) {
      throw new Error(`Video too long (${Math.ceil(totalDur / 60)} min, max ${Math.floor(maxDur / 60)} min)`);
    }

    if (totalDur < MIN_SCENE_SEC * 2) {
      return [{
        buffer: inputBuffer,
        startSec: 0,
        endSec: totalDur || 0,
        durationSec: totalDur || 0,
        index: 0,
      }];
    }

    const cuts = await detectSceneCutTimes(inputPath, totalDur, deadline);
    const ranges = buildClipRanges(cuts, totalDur);
    console.log(
      `[ArchiveSplit] ${cuts.length} shot cuts → ${ranges.length} clip(s) (${totalDur.toFixed(1)}s, ` +
        `scdet=${scdetThreshold()} scene=${sceneThreshold()})`
    );

    if (ranges.length <= 1) {
      console.log("[ArchiveSplit] no shot boundaries detected — keeping whole video as one clip");
      return [{
        buffer: inputBuffer,
        startSec: 0,
        endSec: totalDur,
        durationSec: totalDur,
        index: 0,
      }];
    }

    if (!hasBudget()) {
      console.warn("[ArchiveSplit] budget exhausted after shot detect — storing whole video");
      return [{
        buffer: inputBuffer,
        startSec: 0,
        endSec: totalDur,
        durationSec: totalDur,
        index: 0,
      }];
    }

    const extractResults = await mapPool(
      ranges,
      extractConcurrency(),
      async (range, i) => {
        const { start, end } = range;
        const dur = end - start;
        const outPath = path.join(workDir, `clip_${String(i).padStart(3, "0")}.mp4`);
        try {
          await extractVideoSegment(inputPath, outPath, start, dur);
          const buf = fs.readFileSync(outPath);
          if (buf.length < 8000) return null;
          return {
            buffer: buf,
            startSec: start,
            endSec: end,
            durationSec: dur,
            index: i,
          } satisfies VideoClipSegment;
        } catch (err) {
          console.warn(
            `[ArchiveSplit] clip ${i} (${formatTimecode(start)}–${formatTimecode(end)}) failed:`,
            (err as Error).message
          );
          return null;
        }
      },
      hasBudget
    );

    const segments = extractResults.filter((s): s is VideoClipSegment => s != null);
    console.log(`[ArchiveSplit] extracted ${segments.length}/${ranges.length} shot clips in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

    if (segments.length === 0) {
      return [{
        buffer: inputBuffer,
        startSec: 0,
        endSec: totalDur,
        durationSec: totalDur,
        index: 0,
      }];
    }

    return segments;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export { formatTimecode };
