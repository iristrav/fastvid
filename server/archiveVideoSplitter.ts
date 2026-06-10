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

export class ArchiveSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveSplitError";
  }
}

const MIN_SPLIT_VIDEO_SEC = 4;

/** Drop only sub-frame detection noise — never merge real shots for being "too short". */
const MIN_SCENE_SEC = 0.12;
const DEFAULT_MAX_CLIPS = 300;
/** Only merge adjacent clips when capping count if one side is a sub-second flash/glitch. */
const DEFAULT_FLASH_MERGE_MAX_SEC = 0.45;
const INTERNAL_RESCAN_MIN_SEC = 1.4;
const INTERNAL_RESCAN_MAX_RANGES = 48;
const DEFAULT_SCENE_THRESHOLD = 0.22;
const DEFAULT_SCDET_THRESHOLD = 6;
const DEFAULT_CUT_MERGE_GAP_SEC = 0.18;
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

export async function assertFfmpegAvailable(): Promise<void> {
  try {
    await exec(`${ffmpegBin()} -version`, { timeout: 8_000, maxBuffer: 256 * 1024 });
  } catch {
    throw new ArchiveSplitError(
      "FFmpeg is niet beschikbaar op de server — automatisch knippen kan niet. Controleer de Railway-deploy (nixpacks ffmpeg)."
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
        `[ArchiveSplit] ${result.length} shots exceeds max ${maxClips} — keeping separate clips (no multi-shot merge)`
      );
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
  deadlineMs: number
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
      if (Date.now() >= deadlineMs) return null;

      const [scdet, scene] = await Promise.all([
        detectScdetCutTimesInWindow(
          inputPath,
          range.start,
          range.end,
          Math.max(3, scdetThreshold() * 0.75),
          perRangeTimeout
        ),
        detectSceneFilterCutTimesInWindow(
          inputPath,
          range.start,
          range.end,
          Math.max(0.12, sceneThreshold() * 0.75),
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
    () => Date.now() < deadlineMs
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
  const scdetBudget = Math.floor(detectTimeout * 0.45);
  const sceneBudget = Math.floor(detectTimeout * 0.45);
  const keyframeBudget = Math.floor(detectTimeout * 0.1);

  const scdetCuts = await detectScdetCutTimes(inputPath, totalDur, scdetThreshold(), scdetBudget);
  const sceneCuts = await detectSceneFilterCutTimes(inputPath, totalDur, sceneThreshold(), sceneBudget);
  const keyframeCuts = await detectKeyframeCutTimes(inputPath, totalDur);
  let cuts = combineShotCutTimes([scdetCuts, sceneCuts, keyframeCuts]);

  console.log(
    `[ArchiveSplit] shot detect: scdet=${scdetCuts.length} scene=${sceneCuts.length} keyframes=${keyframeCuts.length} combined=${cuts.length}`
  );

  // If almost no shots found on a long video, retry both detectors more sensitively.
  if (cuts.length < 2 && totalDur > MIN_SPLIT_VIDEO_SEC) {
    const scdet2 = await detectScdetCutTimes(
      inputPath,
      totalDur,
      Math.max(2, scdetThreshold() * 0.5),
      Math.floor(scdetBudget * 0.6)
    );
    const scene2 = await detectSceneFilterCutTimes(
      inputPath,
      totalDur,
      Math.max(0.08, sceneThreshold() * 0.45),
      Math.floor(sceneBudget * 0.6)
    );
    const retry = combineShotCutTimes([scdet2, scene2, keyframeCuts]);
    if (retry.length > cuts.length) {
      console.log(`[ArchiveSplit] sensitive shot retry: ${retry.length} cuts (was ${cuts.length})`);
      cuts = retry;
    }
  }

  // Last resort for archive/edited footage: lower-res pass picks up subtle hard cuts.
  if (cuts.length < 2 && totalDur > MIN_SPLIT_VIDEO_SEC && Date.now() < deadlineMs - 15_000) {
    const lowRes = await detectSceneFilterCutTimesLowRes(inputPath, totalDur, 0.1, keyframeBudget);
    const merged = combineShotCutTimes([cuts, lowRes]);
    if (merged.length > cuts.length) {
      console.log(`[ArchiveSplit] low-res scene retry: ${merged.length} cuts (was ${cuts.length})`);
      cuts = merged;
    }
  }

  return cuts;
}

/** Extra pass at 240px — faster and more sensitive on B&W / grainy archive video. */
async function detectSceneFilterCutTimesLowRes(
  inputPath: string,
  totalDur: number,
  threshold: number,
  timeoutMs: number
): Promise<number[]> {
  const cmd =
    `${ffmpegBin()} -i "${inputPath}" -an ` +
    `-vf "scale=240:-1,select='gt(scene,${threshold})',showinfo" -f null -`;
  const stderr = await runFfmpegDetect(cmd, timeoutMs);
  return mergeNearbyCuts(parsePtsTimesFromFfmpeg(stderr, totalDur), cutMergeGapSec());
}

async function extractVideoSegment(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number
): Promise<void> {
  const durationSec = endSec - startSec;
  const perClipTimeout = Math.max(30_000, Math.min(120_000, durationSec * 4000));
  // -ss after -i for frame-accurate cuts (avoids bleeding the next/previous shot).
  await exec(
    `${ffmpegBin()} -y -i "${inputPath}" -ss ${startSec.toFixed(3)} -to ${endSec.toFixed(3)} ` +
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

  await assertFfmpegAvailable();

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-archive-split-"));
  try {
    const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("quicktime") || mimeType.includes("mov") ? "mov" : "mp4";
    const inputPath = path.join(workDir, `source.${ext}`);
    fs.writeFileSync(inputPath, inputBuffer);

    const totalDur = await probeVideoDurationSec(inputPath);
    if (totalDur <= 0) {
      throw new ArchiveSplitError("Kon videoduur niet bepalen (ffprobe). Bestand corrupt of formaat niet ondersteund.");
    }

    const maxDur = maxArchiveVideoDurationSec();
    if (totalDur > maxDur) {
      throw new ArchiveSplitError(`Video too long (${Math.ceil(totalDur / 60)} min, max ${Math.floor(maxDur / 60)} min)`);
    }

    if (totalDur < MIN_SCENE_SEC * 2) {
      return [{
        buffer: inputBuffer,
        startSec: 0,
        endSec: totalDur,
        durationSec: totalDur,
        index: 0,
      }];
    }

    const cuts = await detectSceneCutTimes(inputPath, totalDur, deadline);
    let ranges = buildClipRanges(cuts, totalDur);
    if (ranges.length > 1 && hasBudget()) {
      ranges = await rescanRangesForInteriorCuts(inputPath, ranges, deadline);
    }
    console.log(
      `[ArchiveSplit] ${cuts.length} shot cuts → ${ranges.length} clip(s) (${totalDur.toFixed(1)}s, ` +
        `scdet=${scdetThreshold()} scene=${sceneThreshold()})`
    );

    if (ranges.length <= 1) {
      const msg =
        `[ArchiveSplit] no shot boundaries detected in ${totalDur.toFixed(1)}s video`;
      console.warn(msg);
      if (totalDur > MIN_SPLIT_VIDEO_SEC) {
        throw new ArchiveSplitError(
          "Geen shot/scène-wisselingen gedetecteerd. Zorg dat FFmpeg beschikbaar is en het bestand echte beeldcuts bevat."
        );
      }
      return [{
        buffer: inputBuffer,
        startSec: 0,
        endSec: totalDur,
        durationSec: totalDur,
        index: 0,
      }];
    }

    if (!hasBudget()) {
      throw new ArchiveSplitError(
        "Knippen duurde te lang (timeout). Probeer een kortere video of zet AI-tags tijdelijk uit."
      );
    }

    const extractResults = await mapPool(
      ranges,
      extractConcurrency(),
      async (range, i) => {
        const { start, end } = range;
        const dur = end - start;
        const outPath = path.join(workDir, `clip_${String(i).padStart(3, "0")}.mp4`);
        try {
          await extractVideoSegment(inputPath, outPath, start, end);
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
      throw new ArchiveSplitError("Shot-detectie vond cuts maar extractie van clips mislukt (FFmpeg).");
    }

    if (segments.length <= 1 && totalDur > MIN_SPLIT_VIDEO_SEC) {
      throw new ArchiveSplitError(
        "Slechts 1 clip geëxtraheerd terwijl er meerdere shots verwacht werden. Probeer opnieuw te uploaden."
      );
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
