/**
 * Split long archive videos into clips at scene/cut boundaries (FFmpeg scene detection).
 * Tuned for up to 20-minute sources within a ~9-minute processing budget.
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

const MIN_CLIP_SEC = 0.45;
const MAX_CLIPS = 120;
const DEFAULT_SCENE_THRESHOLD = 0.22;
const DEFAULT_CUT_MERGE_GAP_SEC = 0.35;
const DEFAULT_DETECT_FPS = 6;
const DEFAULT_SPLIT_BUDGET_MS = 540_000; // 9 min — fits in 10 min HTTP timeout
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

export function minClipSec(): number {
  const raw = process.env.ARCHIVE_MIN_CLIP_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.25 && n <= 5) return n;
  }
  return MIN_CLIP_SEC;
}

export function cutMergeGapSec(): number {
  const raw = process.env.ARCHIVE_CUT_MERGE_GAP?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.15 && n <= 2) return n;
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

/** Merge cut points closer than minGapSec (same hard cut detected twice). */
export function mergeNearbyCuts(cuts: number[], minGapSec: number): number[] {
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) {
    if (out.length === 0 || t - out[out.length - 1] >= minGapSec) out.push(t);
  }
  return out;
}

/** Build [start,end) ranges from cut list; merge segments shorter than minClipSec. */
export function buildClipRanges(
  cuts: number[],
  totalDuration: number,
  minClip = minClipSec(),
  maxClips = MAX_CLIPS,
  mergeGap = cutMergeGapSec()
): Array<{ start: number; end: number }> {
  if (totalDuration <= 0) return [];
  const points = [0, ...mergeNearbyCuts(cuts, mergeGap), totalDuration];
  let ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end - start >= 0.15) ranges.push({ start, end });
  }

  let merged: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    if (merged.length === 0) {
      merged.push({ ...r });
      continue;
    }
    const dur = r.end - r.start;
    if (dur < minClip) {
      merged[merged.length - 1].end = r.end;
    } else {
      merged.push({ ...r });
    }
  }

  while (merged.length > maxClips) {
    let shortestIdx = 0;
    let shortest = merged[0].end - merged[0].start;
    for (let i = 1; i < merged.length; i++) {
      const d = merged[i].end - merged[i].start;
      if (d < shortest) {
        shortest = d;
        shortestIdx = i;
      }
    }
    if (shortestIdx === 0) {
      merged[0].end = merged[1].end;
      merged.splice(1, 1);
    } else {
      merged[shortestIdx - 1].end = merged[shortestIdx].end;
      merged.splice(shortestIdx, 1);
    }
  }

  return merged.filter((r) => r.end - r.start >= minClip * 0.85);
}

/** Run async tasks with bounded concurrency; preserves result order. */
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

async function runSceneDetectPass(
  inputPath: string,
  totalDur: number,
  threshold: number,
  fps: number,
  timeoutMs: number
): Promise<number[]> {
  const cmd =
    `${ffmpegBin()} -i "${inputPath}" -an ` +
    `-vf "fps=${fps},scale=480:-1,select='gt(scene,${threshold})',showinfo" -f null -`;
  let stderr = "";
  try {
    const result = await exec(cmd, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs });
    stderr = String(result.stderr ?? "");
  } catch (err: unknown) {
    stderr = String((err as { stderr?: string }).stderr ?? "");
    if (!stderr.includes("pts_time")) {
      console.warn("[ArchiveSplit] scene detect failed:", (err as Error).message?.slice(0, 200));
      return [];
    }
  }

  const times: number[] = [];
  const re = /pts_time:([0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const t = parseFloat(m[1]);
    if (t > 0.05 && t < totalDur - 0.05) times.push(t);
  }
  return mergeNearbyCuts(times, cutMergeGapSec());
}

async function detectSceneCutTimes(inputPath: string, totalDur: number, deadlineMs: number): Promise<number[]> {
  const threshold = sceneThreshold();
  const detectTimeout = Math.min(240_000, Math.max(60_000, deadlineMs - Date.now()));
  const perPassTimeout = Math.floor(detectTimeout * 0.55);

  let cuts = await runSceneDetectPass(inputPath, totalDur, threshold, DEFAULT_DETECT_FPS, perPassTimeout);

  // Slideshow / per-image videos: retry with higher sensitivity when almost no cuts found.
  if (cuts.length < 2 && totalDur > 20) {
    const sensitive = Math.max(0.1, threshold * 0.55);
    const retry = await runSceneDetectPass(
      inputPath,
      totalDur,
      sensitive,
      Math.min(10, DEFAULT_DETECT_FPS + 2),
      Math.floor(detectTimeout * 0.45)
    );
    if (retry.length > cuts.length) {
      console.log(`[ArchiveSplit] sensitive pass found ${retry.length} cuts (was ${cuts.length})`);
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
 * Detect visual scene changes and return one buffer per clip.
 * Falls back to a single segment when no cuts are found.
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

    if (totalDur < minClipSec() * 2) {
      return [
        {
          buffer: inputBuffer,
          startSec: 0,
          endSec: totalDur || 0,
          durationSec: totalDur || 0,
          index: 0,
        },
      ];
    }

    const cuts = await detectSceneCutTimes(inputPath, totalDur, deadline);
    const ranges = buildClipRanges(cuts, totalDur);
    console.log(
      `[ArchiveSplit] ${cuts.length} scene cuts → ${ranges.length} clip(s) (${totalDur.toFixed(1)}s source, ` +
        `threshold ${sceneThreshold()}, budget ${splitBudgetMs() / 1000}s, concurrency ${extractConcurrency()})`
    );

    if (ranges.length <= 1) {
      return [
        {
          buffer: inputBuffer,
          startSec: 0,
          endSec: totalDur,
          durationSec: totalDur,
          index: 0,
        },
      ];
    }

    if (!hasBudget()) {
      console.warn("[ArchiveSplit] budget exhausted after scene detect — storing whole video");
      return [
        {
          buffer: inputBuffer,
          startSec: 0,
          endSec: totalDur,
          durationSec: totalDur,
          index: 0,
        },
      ];
    }

    const concurrency = extractConcurrency();
    const extractResults = await mapPool(
      ranges,
      concurrency,
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
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[ArchiveSplit] extracted ${segments.length}/${ranges.length} clips in ${elapsed}s`);

    if (segments.length === 0) {
      return [
        {
          buffer: inputBuffer,
          startSec: 0,
          endSec: totalDur,
          durationSec: totalDur,
          index: 0,
        },
      ];
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
