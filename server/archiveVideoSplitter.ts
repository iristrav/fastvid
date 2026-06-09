/**
 * Split long archive videos into clips at scene/cut boundaries (FFmpeg scene detection).
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

const MIN_CLIP_SEC = 1.2;
const MAX_CLIPS = 50;
const DEFAULT_SCENE_THRESHOLD = 0.32;

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
}

function sceneThreshold(): number {
  const raw = process.env.ARCHIVE_SCENE_THRESHOLD?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.1 && n <= 0.9) return n;
  }
  return DEFAULT_SCENE_THRESHOLD;
}

export async function probeVideoDurationSec(filePath: string): Promise<number> {
  try {
    const { stdout } = await exec(
      `${ffprobeBin()} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
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
  minClipSec = MIN_CLIP_SEC,
  maxClips = MAX_CLIPS
): Array<{ start: number; end: number }> {
  if (totalDuration <= 0) return [];
  const points = [0, ...mergeNearbyCuts(cuts, 0.75), totalDuration];
  let ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end - start >= 0.15) ranges.push({ start, end });
  }

  // Merge short segments into the previous clip.
  let merged: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    if (merged.length === 0) {
      merged.push({ ...r });
      continue;
    }
    const dur = r.end - r.start;
    if (dur < minClipSec) {
      merged[merged.length - 1].end = r.end;
    } else {
      merged.push({ ...r });
    }
  }

  // If still too many clips, merge the shortest neighbor pairs until under cap.
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

  return merged.filter((r) => r.end - r.start >= minClipSec * 0.85);
}

async function detectSceneCutTimes(inputPath: string, totalDur: number): Promise<number[]> {
  const threshold = sceneThreshold();
  const cmd =
    `${ffmpegBin()} -i "${inputPath}" -filter:v "select='gt(scene,${threshold})',showinfo" -f null -`;
  let stderr = "";
  try {
    const result = await exec(cmd, { maxBuffer: 16 * 1024 * 1024 });
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
    if (t > 0.08 && t < totalDur - 0.08) times.push(t);
  }
  return mergeNearbyCuts(times, 0.75);
}

async function extractVideoSegment(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number
): Promise<void> {
  await exec(
    `${ffmpegBin()} -y -ss ${startSec.toFixed(3)} -i "${inputPath}" -t ${durationSec.toFixed(3)} ` +
      `-c:v libx264 -preset veryfast -crf 20 -an -pix_fmt yuv420p -movflags +faststart "${outputPath}"`,
    { maxBuffer: 8 * 1024 * 1024 }
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
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-archive-split-"));
  try {
    const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("quicktime") || mimeType.includes("mov") ? "mov" : "mp4";
    const inputPath = path.join(workDir, `source.${ext}`);
    fs.writeFileSync(inputPath, inputBuffer);

    const totalDur = await probeVideoDurationSec(inputPath);
    if (totalDur < MIN_CLIP_SEC * 2) {
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

    const cuts = await detectSceneCutTimes(inputPath, totalDur);
    const ranges = buildClipRanges(cuts, totalDur);
    console.log(
      `[ArchiveSplit] ${cuts.length} scene cuts → ${ranges.length} clip(s) (${totalDur.toFixed(1)}s source, threshold ${sceneThreshold()})`
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

    const segments: VideoClipSegment[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const { start, end } = ranges[i];
      const dur = end - start;
      const outPath = path.join(workDir, `clip_${String(i).padStart(3, "0")}.mp4`);
      try {
        await extractVideoSegment(inputPath, outPath, start, dur);
        const buf = fs.readFileSync(outPath);
        if (buf.length < 8000) continue;
        segments.push({
          buffer: buf,
          startSec: start,
          endSec: end,
          durationSec: dur,
          index: i,
        });
      } catch (err) {
        console.warn(`[ArchiveSplit] clip ${i} (${formatTimecode(start)}–${formatTimecode(end)}) failed:`, (err as Error).message);
      }
    }

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
