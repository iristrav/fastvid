/**
 * Post-render quality spot-check — ffprobe + 4-frame luma + FFmpeg blackdetect/freezedetect/silencedetect,
 * and the chapter-card ground read in every frame of the file.
 */
import fs from "fs";
import { envFlagIsNotOff } from "./envFlag";
import path from "path";
import { spawn } from "child_process";
import { promisify } from "util";
import { withForkRetry } from "./_core/execForkRetry";
import { ffmpegSemaphore } from "./_core/semaphore";
import { exec as execCb } from "child_process";

// Routed through ffmpegSemaphore (previously ungated) — postRenderSpotCheckEnabledForVideo()
// defaults ON for the 10-20min target length and runs at the tail of every long render.
const execRaw = promisify(execCb);
const exec = ((cmd: string, opts?: Record<string, unknown>) =>
  ffmpegSemaphore.run(() => withForkRetry(() => execRaw(cmd, opts as never)))) as typeof execRaw;

const SAMPLE_FRACTIONS = [0.12, 0.38, 0.62, 0.88];
const BLACK_LUMA_THRESHOLD = 22;

/**
 * HARD QUALITY GATE — THE BLUE-GREY CHAPTER-CARD GROUND IN THE DELIVERED FILE.
 *
 * Graphics.tsx draws every fullscreen primary graphic — a chapter card, a counter, a chart — on
 * `PRIMARY_GROUND`, a radial gradient from rgb(43,52,66) at the centre to rgb(26,32,41) at the edge.
 *
 * EVERY frame of the delivered file is decoded (one ffmpeg pass, downscaled to 48×27 by area
 * averaging) and read. A frame is the ground when
 *   - at least `PLACEHOLDER_FRAME_FRACTION` of its pixels sit inside the ground's palette (dark, low
 *     saturation, blue above red and green), AND
 *   - its top and bottom bands (`PLACEHOLDER_BAND_ROWS` of the rows each, the full width — where a
 *     title, a number or the glow never reaches) are at least `PLACEHOLDER_BAND_FRACTION` inside the
 *     palette, flat (per-channel standard deviation ≤ `PLACEHOLDER_BAND_MAX_STDDEV`) and of the
 *     ground's own mean colour (`PLACEHOLDER_BAND_MEAN`).
 *
 * Measured, not guessed. Real cards rendered by the project's own Remotion bundle at 1080p — a short
 * title, a title wide enough to reach the frame's sides, the entrance frame, the last frame, a
 * counter, a card without words — read a whole-frame share of 0.818–0.868, bands 1.000, band mean
 * ≈ (34,41,51), band sd ≈ 4–5 (tests/fixtures/video-quality/primary-card-*.png). The whole-frame
 * share alone was not safe: the wide title sat at 0.818 against the earlier 0.8 line. The bands tell a
 * slate from a dark PICTURE: a dark frame with a light or an object near its edge (band share 0.87–0.95,
 * sd 26–59), a vertical blue-grey sky gradient (bands not flat, sd 8–11), a tinted test pattern. What
 * they do not tell apart — by design — is a frame that is, across both bands, the slate itself: a
 * uniformly noisy blue-grey frame that averages to the ground's colour reads as the ground, because
 * on screen it is one. Letterbox padding (0x2a2a2a, neutral grey: b − r = 0) and the light mat
 * (0xCFCFCF) are outside the palette on purpose.
 *
 * Seconds are the frames' own: a placeholder frame counts its presentation time (its pts to the next
 * frame's). `complete` is false when ffmpeg failed or timed out, decoded nothing, decoded fewer
 * seconds than the file holds, its frame count disagrees with its own timing lines, or a planned
 * interval holds no frame — and the DeliveryGate then blocks.
 *
 * A ground frame inside the window of a planned CONTENT graphic (a chart, a counter, a map: a
 * graphic the coverage rule accepts as the sentence's picture) is reported as
 * `contentGraphicGroundSec`, not as placeholder. Every other ground frame — a planned chapter card,
 * a card held past its window, a card nobody planned — is placeholder time, and one is enough.
 */
export const PLACEHOLDER_SCAN_WIDTH = 48;
export const PLACEHOLDER_SCAN_HEIGHT = 27;
export const PLACEHOLDER_FRAME_FRACTION = 0.6;
export const PLACEHOLDER_BAND_ROWS = 0.12;
export const PLACEHOLDER_BAND_FRACTION = 0.95;
export const PLACEHOLDER_BAND_MAX_STDDEV = 8;
export const PLACEHOLDER_BAND_MEAN = { r: [24, 48], g: [30, 56], b: [38, 70], blueOverRed: 10 } as const;

export function isPrimaryGroundPixel(r: number, g: number, b: number): boolean {
  return r >= 14 && r <= 56 && g >= 20 && g <= 64 && b >= 30 && b <= 80 && b - r >= 7 && b - g >= 5 && g - r >= 1 && g - r <= 18;
}

/** The share of an rgb24 buffer that is the chapter-card ground. */
export function primaryGroundFraction(rgb: Buffer): number {
  const px = Math.floor(rgb.length / 3);
  if (px === 0) return 0;
  let hits = 0;
  for (let i = 0; i < px; i++) if (isPrimaryGroundPixel(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!)) hits++;
  return hits / px;
}

export type GroundFrameReading = {
  frameFraction: number;
  bandFraction: number;
  bandMean: [number, number, number];
  bandStddev: [number, number, number];
  ground: boolean;
};

/** One downscaled rgb24 frame, read against the rules above. Pure. */
export function readGroundFrame(rgb: Buffer, width = PLACEHOLDER_SCAN_WIDTH, height = PLACEHOLDER_SCAN_HEIGHT): GroundFrameReading {
  const frameFraction = primaryGroundFraction(rgb);
  const band = Math.max(1, Math.round(height * PLACEHOLDER_BAND_ROWS));
  let n = 0;
  let hits = 0;
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    if (y >= band && y < height - band) continue;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (i + 2 >= rgb.length) break;
      const r = rgb[i]!;
      const g = rgb[i + 1]!;
      const b = rgb[i + 2]!;
      n++;
      if (isPrimaryGroundPixel(r, g, b)) hits++;
      sum[0]! += r; sum[1]! += g; sum[2]! += b;
      sq[0]! += r * r; sq[1]! += g * g; sq[2]! += b * b;
    }
  }
  const mean = (n ? sum.map((v) => v / n) : [0, 0, 0]) as [number, number, number];
  const sd = (n ? sq.map((q, c) => Math.sqrt(Math.max(0, q / n - mean[c]! ** 2))) : [0, 0, 0]) as [number, number, number];
  const bandFraction = n ? hits / n : 0;
  const m = PLACEHOLDER_BAND_MEAN;
  const ground =
    frameFraction >= PLACEHOLDER_FRAME_FRACTION &&
    bandFraction >= PLACEHOLDER_BAND_FRACTION &&
    mean[0] >= m.r[0] && mean[0] <= m.r[1] &&
    mean[1] >= m.g[0] && mean[1] <= m.g[1] &&
    mean[2] >= m.b[0] && mean[2] <= m.b[1] &&
    mean[2] - mean[0] >= m.blueOverRed &&
    Math.max(...sd) <= PLACEHOLDER_BAND_MAX_STDDEV;
  return { frameFraction, bandFraction, bandMean: mean, bandStddev: sd, ground };
}

export type PlaceholderInterval = {
  startSec: number;
  endSec: number;
  id?: string;
  /** A planned chapter card (default) or a planned content graphic, whose ground is not placeholder. */
  kind?: "chapter_card" | "content_graphic";
};
export type PlaceholderIntervalResult = PlaceholderInterval & {
  /** Frames whose presentation midpoint falls inside the interval. */
  frames: number;
  hits: number;
  status: "placeholder" | "partial" | "clear" | "unsampled";
};
export type PlaceholderScan = {
  method: "all_frames";
  complete: boolean;
  /** Every decoded frame of the file. */
  framesSampled: number;
  /** Frames that are the ground outside any planned content graphic. */
  placeholderFrames: number;
  /** Their presentation time, in seconds — the number the gate holds at exactly zero. */
  placeholderSec: number;
  /** Chapter-card time the timeline planned. */
  plannedCardSec: number;
  /** Equal to `placeholderSec`: the measured ground time. Kept by name for the gate, the log and the analyser. */
  confirmedPlaceholderSec: number;
  indicatedPlaceholderSec: number;
  /** Placeholder frames outside every planned chapter card. */
  unplannedPlaceholderFrames: number;
  /** Ground frames inside a planned content graphic: reported, not placeholder. */
  contentGraphicGroundFrames: number;
  contentGraphicGroundSec: number;
  /** Seconds the decode covered, from the frames' own timing. */
  decodedSec: number;
  intervals: PlaceholderIntervalResult[];
  detail?: string;
};

export type PostRenderSpotCheckResult = {
  ok: boolean;
  durationSec: number | null;
  framesChecked: number;
  blackFrameCount: number;
  worstMeanLuma: number | null;
  blackSegments: number;
  freezeSegments: number;
  silentSegments: number;
  warnings: string[];
  /** VIDEO 634 — where the black is and how long, from blackdetect's own lines. Observability only. */
  blackSpans?: Array<{ startSec: number; endSec: number }>;
  blackTotalSec?: number;
  /** HARD QUALITY GATE — the chapter-card ground scan; absent when the file could not be read at all. */
  placeholder?: PlaceholderScan;
};

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN?.trim() || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.FFPROBE_PATH?.trim() || process.env.FFPROBE_BIN?.trim() || "ffprobe";
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
    await ffmpegSemaphore.run(() => withForkRetry(() => new Promise<void>((resolve, reject) => {
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
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
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
        else reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`));
      });
      child.on("error", reject);
    })));
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

/**
 * Every frame of the file through one ffmpeg process: downscaled rgb24 on stdout, `showinfo`'s
 * timing line per frame on stderr. Nothing is kept but each frame's reading and its pts.
 */
async function decodeEveryFrame(
  filePath: string,
  durationSec: number | null
): Promise<{ ok: boolean; readings: boolean[]; ptsSec: number[]; problem?: string }> {
  const frameBytes = PLACEHOLDER_SCAN_WIDTH * PLACEHOLDER_SCAN_HEIGHT * 3;
  const timeoutMs = 120_000 + Math.ceil((durationSec ?? 900) * 1000);
  const readings: boolean[] = [];
  const ptsSec: number[] = [];
  try {
    await ffmpegSemaphore.run(() => withForkRetry(() => new Promise<void>((resolve, reject) => {
      const args = [
        "-hide_banner", "-nostats", "-loglevel", "info",
        "-i", filePath,
        "-an", "-sn", "-dn",
        "-vf", `scale=${PLACEHOLDER_SCAN_WIDTH}:${PLACEHOLDER_SCAN_HEIGHT}:flags=area,format=rgb24,showinfo`,
        "-f", "rawvideo", "pipe:1",
      ];
      const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
      let pending: Buffer = Buffer.alloc(0);
      child.stdout.on("data", (chunk: Buffer) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let off = 0;
        while (pending.length - off >= frameBytes) {
          readings.push(readGroundFrame(pending.subarray(off, off + frameBytes)).ground);
          off += frameBytes;
        }
        pending = off ? Buffer.from(pending.subarray(off)) : pending;
      });
      let errTail = "";
      let line = "";
      child.stderr.on("data", (d: Buffer) => {
        line += d.toString();
        let nl = line.indexOf("\n");
        while (nl >= 0) {
          const one = line.slice(0, nl);
          line = line.slice(nl + 1);
          const m = /showinfo.*\bpts_time:\s*(-?[\d.]+)/.exec(one);
          if (m) ptsSec.push(Number(m[1]));
          else errTail = (errTail + one + "\n").slice(-400);
          nl = line.indexOf("\n");
        }
      });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        reject(new Error(`timeout after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}: ${errTail.replace(/\s+/g, " ").trim().slice(-200)}`));
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    })));
    return { ok: true, readings, ptsSec };
  } catch (err) {
    return { ok: false, readings, ptsSec, problem: (err as Error).message };
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The chapter-card ground scan over EVERY frame of the file, attributed to the planned intervals.
 * Exported for tests; `spotCheckFinalVideo` calls it with the file's duration.
 */
export async function scanForPlaceholderGround(
  filePath: string,
  intervals: readonly PlaceholderInterval[],
  durationSec: number | null
): Promise<PlaceholderScan> {
  const problems: string[] = [];
  let complete = true;
  const decoded = await decodeEveryFrame(filePath, durationSec);
  if (!decoded.ok) {
    complete = false;
    problems.push(`decode failed: ${decoded.problem ?? "unknown"}`);
  }
  const n = Math.min(decoded.readings.length, decoded.ptsSec.length);
  if (decoded.readings.length !== decoded.ptsSec.length) {
    complete = false;
    problems.push(`${decoded.readings.length} frame(s) decoded, ${decoded.ptsSec.length} timing line(s)`);
  }
  if (n === 0) {
    complete = false;
    problems.push("no frame could be decoded");
  }
  /** each frame's presentation time: to the next pts; the last frame takes the median step */
  const steps: number[] = [];
  for (let i = 0; i + 1 < n; i++) steps.push(Math.max(0, decoded.ptsSec[i + 1]! - decoded.ptsSec[i]!));
  const sortedSteps = [...steps].sort((a, b) => a - b);
  const median = sortedSteps.length ? sortedSteps[Math.floor(sortedSteps.length / 2)]! : 0;
  const durations = n ? [...steps, median] : [];
  const decodedSec = n ? r3(decoded.ptsSec[n - 1]! + median) : 0;
  if (durationSec != null && n > 0 && decodedSec < durationSec - 1) {
    complete = false;
    problems.push(`decoded ${decodedSec.toFixed(2)}s of ${durationSec.toFixed(2)}s`);
  }

  const cards = intervals.filter((iv) => (iv.kind ?? "chapter_card") === "chapter_card");
  const contentGraphics = intervals.filter((iv) => iv.kind === "content_graphic");
  const inside = (iv: PlaceholderInterval, t: number) => t >= iv.startSec && t < iv.endSec;
  const counts = intervals.map(() => ({ frames: 0, hits: 0 }));
  let placeholderFrames = 0;
  let placeholderSec = 0;
  let unplanned = 0;
  let contentFrames = 0;
  let contentSec = 0;
  for (let i = 0; i < n; i++) {
    const dur = durations[i]!;
    const mid = decoded.ptsSec[i]! + dur / 2;
    const ground = decoded.readings[i]!;
    intervals.forEach((iv, k) => {
      if (inside(iv, mid)) {
        counts[k]!.frames++;
        if (ground) counts[k]!.hits++;
      }
    });
    if (!ground) continue;
    if (contentGraphics.some((iv) => inside(iv, mid))) {
      contentFrames++;
      contentSec += dur;
      continue;
    }
    placeholderFrames++;
    placeholderSec += dur;
    if (!cards.some((iv) => inside(iv, mid))) unplanned++;
  }
  const results: PlaceholderIntervalResult[] = intervals.map((iv, k) => {
    const { frames, hits } = counts[k]!;
    const status: PlaceholderIntervalResult["status"] = frames === 0 ? "unsampled" : hits === frames ? "placeholder" : hits > 0 ? "partial" : "clear";
    if (frames === 0) {
      complete = false;
      problems.push(`${iv.id ?? `${iv.startSec.toFixed(2)}–${iv.endSec.toFixed(2)}`}: no frame inside the planned interval`);
    }
    return { ...iv, frames, hits, status };
  });
  const sec = (iv: PlaceholderInterval) => Math.max(0, iv.endSec - iv.startSec);
  return {
    method: "all_frames",
    complete,
    framesSampled: n,
    placeholderFrames,
    placeholderSec: r3(placeholderSec),
    plannedCardSec: r3(cards.reduce((s, iv) => s + sec(iv), 0)),
    confirmedPlaceholderSec: r3(placeholderSec),
    indicatedPlaceholderSec: r3(placeholderSec),
    unplannedPlaceholderFrames: unplanned,
    contentGraphicGroundFrames: contentFrames,
    contentGraphicGroundSec: r3(contentSec),
    decodedSec,
    intervals: results,
    ...(problems.length ? { detail: problems.join("; ") } : {}),
  };
}

function countFilterMatches(stderr: string, filterName: string): number {
  const re = new RegExp(`\\[${filterName}[^\\]]*\\]`, "gi");
  return (stderr.match(re) ?? []).length;
}

/** Archive montage QA — never block export (dark scenes, holds, silence gaps). Exceptions: a
 *  missing/too-small file, or every sampled frame coming back essentially pure black (worst
 *  luma < 1) — that's not "legitimately dark archive footage", it's indistinguishable from a
 *  broken encode, so it must block instead of silently completing. Partial darkness (some but
 *  not all frames dark, or a moderate worst-luma) stays informational — deliberately not
 *  touched here. */
export function isInformationalSpotWarning(warning: string): boolean {
  /** HARD QUALITY GATE — the placeholder scan is reported here and judged by the DeliveryGate; it does not change `ok`. */
  if (warning.startsWith("placeholder: ")) return true;
  if (/Final video missing or too small/i.test(warning)) return false;
  if (/Final video appears fully black/i.test(warning)) return false;
  return true;
}

function countFreezeStarts(stderr: string): number {
  return (stderr.match(/lavfi\.freezedetect\.freeze_start/gi) ?? []).length;
}

function countBlackStarts(stderr: string): number {
  return (stderr.match(/lavfi\.blackdetect\.black_start/gi) ?? []).length;
}

/**
 * VIDEO 634 — blackdetect's "black_start:5.78 black_end:11.96 black_duration:6.18" lines, read.
 * The count alone said "3 segments"; ten seconds of black in a 65 s film read the same as three
 * dark frames of night footage.
 */
export function parseBlackSpans(stderr: string): Array<{ startSec: number; endSec: number }> {
  const spans: Array<{ startSec: number; endSec: number }> = [];
  const re = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g;
  for (let m = re.exec(stderr); m; m = re.exec(stderr)) {
    const startSec = Number(m[1]);
    const endSec = Number(m[2]);
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec) spans.push({ startSec, endSec });
  }
  return spans;
}

function countSilentStarts(stderr: string): number {
  return (stderr.match(/silence_start:/gi) ?? []).length;
}

/** Run FFmpeg blackdetect + freezedetect + silencedetect on final MP4. */
async function runFfmpegQualityFilters(filePath: string, durationSec?: number | null): Promise<{
  blackSegments: number;
  freezeSegments: number;
  silentSegments: number;
  stderr: string;
}> {
  const vf =
    "blackdetect=d=0.35:pix_th=0.10:pic_th=0.98," +
    "freezedetect=n=-60dB:d=2.5";
  const af = "silencedetect=n=-50dB:d=1.2";
  // This is a full linear decode of the final video (blackdetect/freezedetect/silencedetect all
  // require reading every frame) — a fixed 90s timeout was fine for ~1min videos but doesn't
  // scale for a 10-20min final render, especially under any CPU contention. Scale against the
  // already-known duration (a few seconds of decode per second of video is a safe, generous
  // multiplier), with the old 90s value as the floor for short videos and a sane ceiling so a
  // pathological file can't hang this QA step indefinitely.
  const timeoutMs = durationSec != null
    ? Math.min(600_000, Math.max(90_000, Math.ceil(durationSec * 1000 * 2.5)))
    : 90_000;
  try {
    const { stderr } = await exec(
      `"${ffmpegBin()}" -hide_banner -nostats -i "${filePath}" -vf "${vf}" -af "${af}" -f null -`,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }
    );
    const out = String(stderr);
    const blackSegments = countBlackStarts(out) || countFilterMatches(out, "blackdetect");
    const freezeSegments = countFreezeStarts(out);
    const silentSegments = countSilentStarts(out);
    return { blackSegments, freezeSegments, silentSegments, stderr: out };
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? "");
    return {
      blackSegments: countBlackStarts(stderr) || countFilterMatches(stderr, "blackdetect"),
      freezeSegments: countFreezeStarts(stderr),
      silentSegments: countSilentStarts(stderr),
      stderr,
    };
  }
}

/** Sample 4 frames + FFmpeg detectors on final MP4. */
export async function spotCheckFinalVideo(
  filePath: string,
  /** HARD QUALITY GATE — where the timeline planned chapter cards and content graphics; every frame is read, these say what it was. */
  opts: { placeholderIntervals?: readonly PlaceholderInterval[] } = {}
): Promise<PostRenderSpotCheckResult> {
  const warnings: string[] = [];
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 10_000) {
    return {
      ok: false,
      durationSec: null,
      framesChecked: 0,
      blackFrameCount: 0,
      worstMeanLuma: null,
      blackSegments: 0,
      freezeSegments: 0,
      silentSegments: 0,
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
  } else if ((worstMeanLuma ?? 255) < 1) {
    warnings.push(
      `Final video appears fully black (worst luma ${worstMeanLuma?.toFixed(0) ?? "?"})`
    );
  } else if (blackFrameCount >= 1 || (worstMeanLuma ?? 255) < 18) {
    warnings.push(
      `${blackFrameCount}/${framesChecked} spot-check frames are dark (worst luma ${worstMeanLuma?.toFixed(0) ?? "?"} — expected for dark archive footage)`
    );
  }

  let blackSegments = 0;
  let freezeSegments = 0;
  let silentSegments = 0;
  let blackSpans: Array<{ startSec: number; endSec: number }> = [];
  if (envFlagIsNotOff("ENABLE_POST_RENDER_FFMPEG_DETECT")) {
    const det = await runFfmpegQualityFilters(filePath, durationSec);
    blackSegments = det.blackSegments;
    freezeSegments = det.freezeSegments;
    silentSegments = det.silentSegments;
    blackSpans = parseBlackSpans(det.stderr);
    if (blackSegments > 0) {
      /** VIDEO 634 — where and how long; still informational, the render is never refused on it. */
      const total = blackSpans.reduce((sum, b) => sum + (b.endSec - b.startSec), 0);
      const where = blackSpans.length
        ? ` (total ${total.toFixed(2)}s: ${blackSpans.map((b) => `${b.startSec.toFixed(2)}–${b.endSec.toFixed(2)}`).join(", ")})`
        : "";
      warnings.push(
        `blackdetect: ${blackSegments} dark/black segment(s)${where} in final video (expected for dark archive scenes)`
      );
    }
    if (freezeSegments > 0) {
      warnings.push(
        `freezedetect: ${freezeSegments} frozen segment(s) in final video (expected for archive montage holds)`
      );
    }
    if (silentSegments > 2 && durationSec != null && durationSec > 20) {
      warnings.push(`silencedetect: ${silentSegments} silent gap(s) in audio track`);
    }
  }

  /** HARD QUALITY GATE — the chapter-card ground, in EVERY frame of the file. Reported; the gate decides. */
  const placeholder = await scanForPlaceholderGround(filePath, opts.placeholderIntervals ?? [], durationSec);
  if (placeholder.placeholderFrames > 0) {
    warnings.push(
      `placeholder: ${placeholder.placeholderFrames}/${placeholder.framesSampled} frame(s) (${placeholder.placeholderSec.toFixed(2)}s) show the blue-grey chapter-card ground ` +
        `(planned cards ${placeholder.plannedCardSec.toFixed(2)}s)`
    );
  }

  const blockingWarnings = warnings.filter((w) => !isInformationalSpotWarning(w));

  return {
    ok: blockingWarnings.length === 0,
    durationSec,
    framesChecked,
    blackFrameCount,
    worstMeanLuma,
    blackSegments,
    freezeSegments,
    silentSegments,
    warnings,
    blackSpans,
    blackTotalSec: Number(blackSpans.reduce((sum, b) => sum + (b.endSec - b.startSec), 0).toFixed(3)),
    placeholder,
  };
}

export function postRenderSpotCheckEnabled(): boolean {
  return envFlagIsNotOff("ENABLE_POST_RENDER_SPOT_CHECK");
}

