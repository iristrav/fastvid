import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { TextOverlay, TextOverlayStyle, SceneTextPlan } from "./types";

const execAsync = promisify(exec);
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";
const FFMPEG_TIMEOUT_MS = 60_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`FFmpeg timeout after ${ms}ms`)), ms)
    ),
  ]);
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const LABEL_BG       = "0x00000099";        // rgba(0,0,0,0.60) — FFmpeg hex + alpha
const LABEL_TEXT     = "white";
const LABEL_ACCENT   = "0xFFD54F";          // #FFD54F warm gold
const LABEL_PAD_W    = 36;                  // horizontal padding px (each side)
const LABEL_PAD_H    = 22;                  // vertical padding px (each side)
const LABEL_MARGIN_X = 48;                  // from left edge
const LABEL_MARGIN_Y = 52;                  // from bottom edge
const FONT_HEADLINE  = 88;                  // 1080p headline size
const FONT_YEAR      = 72;
const FONT_LABEL     = 44;
const FONT_SUBTITLE  = 30;
const FADE_DUR       = 0.45;               // seconds
const TYPEWRITER_MS  = 50;                 // ms per character

// FFmpeg drawtext escaping: \ : ' must be escaped
function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:");
}

// Enable expression: visible between startTime and endTime with fade
function enableExpr(start: number, end: number, fadeDur = FADE_DUR): string {
  const alphaIn  = `if(lt(t,${start.toFixed(3)}),0,if(lt(t,${(start + fadeDur).toFixed(3)}),` +
                   `(t-${start.toFixed(3)})/${fadeDur.toFixed(3)},1))`;
  const alphaOut = `if(gt(t,${end.toFixed(3)}),0,if(gt(t,${(end - fadeDur).toFixed(3)}),` +
                   `(${end.toFixed(3)}-t)/${fadeDur.toFixed(3)},1))`;
  return `between(t,${start.toFixed(3)},${end.toFixed(3)})`;
}

// Alpha fade expression for drawtext alpha param
function alphaExpr(start: number, end: number, fadeDur = FADE_DUR): string {
  const fadeIn  = `if(lt(t,${start.toFixed(3)}),0,` +
                  `if(lt(t,${(start+fadeDur).toFixed(3)}),(t-${start.toFixed(3)})/${fadeDur.toFixed(3)},1))`;
  const fadeOut = `if(gt(t,${(end-fadeDur).toFixed(3)}),(${end.toFixed(3)}-t)/${fadeDur.toFixed(3)},${fadeIn})`;
  return `if(gt(t,${end.toFixed(3)}),0,${fadeOut})`;
}

// ── Drawtext filter builders ──────────────────────────────────────────────────

function buildHeadlineFilter(overlay: TextOverlay, _videoDur: number): string[] {
  const { text, subtitle, startTime, endTime } = overlay;
  const alpha = alphaExpr(startTime, endTime);
  const filters: string[] = [];

  // Main headline — centred
  filters.push(
    `drawtext=text='${esc(text)}':fontcolor=white:fontsize=${FONT_HEADLINE}:` +
    `x=(w-text_w)/2:y=(h-text_h)/2-${subtitle ? 40 : 0}:` +
    `alpha='${alpha}':` +
    `shadowcolor=black:shadowx=3:shadowy=3`
  );

  // Optional subtitle (year / second line)
  if (subtitle) {
    filters.push(
      `drawtext=text='${esc(subtitle)}':fontcolor=${LABEL_ACCENT}:fontsize=${FONT_YEAR}:` +
      `x=(w-text_w)/2:y=(h+text_h)/2+8:` +
      `alpha='${alpha}':` +
      `shadowcolor=black:shadowx=2:shadowy=2`
    );
  }

  return filters;
}

function buildLabelFilter(overlay: TextOverlay, _videoDur: number): string[] {
  const { text, subtitle, startTime, endTime } = overlay;
  const alpha = alphaExpr(startTime, endTime);
  const enable = enableExpr(startTime, endTime);
  const filters: string[] = [];

  // Box background — drawbox
  const boxH = subtitle ? FONT_LABEL + FONT_SUBTITLE + LABEL_PAD_H * 2 + 8 : FONT_LABEL + LABEL_PAD_H * 2;
  // We approximate text width; FFmpeg can't compute it ahead of time so we use a generous fixed width
  // 20px per char is a rough upper bound for the label font
  const approxTextW = Math.max(text.length * 26, (subtitle?.length ?? 0) * 18, 220);
  const boxW = approxTextW + LABEL_PAD_W * 2;
  const boxX = LABEL_MARGIN_X;
  const boxY = `h-${LABEL_MARGIN_Y + boxH}`;

  filters.push(
    `drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:` +
    `color=${LABEL_BG}:t=fill:` +
    `enable='${enable}'`
  );

  // Primary label text
  filters.push(
    `drawtext=text='${esc(text)}':fontcolor=white:fontsize=${FONT_LABEL}:` +
    `x=${boxX + LABEL_PAD_W}:y=h-${LABEL_MARGIN_Y + boxH - LABEL_PAD_H}:` +
    `alpha='${alpha}'`
  );

  // Subtitle text
  if (subtitle) {
    filters.push(
      `drawtext=text='${esc(subtitle)}':fontcolor=${LABEL_ACCENT}:fontsize=${FONT_SUBTITLE}:` +
      `x=${boxX + LABEL_PAD_W}:y=h-${LABEL_MARGIN_Y + FONT_SUBTITLE + LABEL_PAD_H - 4}:` +
      `alpha='${alpha}'`
    );
  }

  return filters;
}

function buildYearFilter(overlay: TextOverlay): string[] {
  const { text, startTime, endTime } = overlay;
  const alpha = alphaExpr(startTime, endTime);
  return [
    `drawtext=text='${esc(text)}':fontcolor=white:fontsize=${FONT_YEAR}:` +
    `x=(w-text_w)/2:y=(h-text_h)/2:` +
    `alpha='${alpha}':` +
    `shadowcolor=black:shadowx=3:shadowy=3`
  ];
}

// ── Typewriter: render PNG frames via Node canvas or fallback to fade ─────────

async function hasCanvas(): Promise<boolean> {
  try {
    require("canvas");
    return true;
  } catch { return false; }
}

async function renderTypewriterOverlay(
  overlay: TextOverlay,
  workDir: string,
  sceneIndex: number,
  overlayIndex: number
): Promise<string | null> {
  if (!(await hasCanvas())) return null;

  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
  const { createCanvas } = require("canvas") as any;
  const chars = overlay.text.split("");
  const frameDir = path.join(workDir, `tw_s${sceneIndex}_o${overlayIndex}`);
  fs.mkdirSync(frameDir, { recursive: true });

  const W = 1920, H = 1080;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const frameMs = TYPEWRITER_MS;
  const startMs = Math.round(overlay.startTime * 1000);

  for (let i = 0; i <= chars.length; i++) {
    const partial = chars.slice(0, i).join("");
    ctx.clearRect(0, 0, W, H);

    if (partial.length > 0) {
      ctx.font = `bold ${FONT_HEADLINE}px Arial`;
      ctx.fillStyle = "white";
      ctx.shadowColor = "rgba(0,0,0,0.8)";
      ctx.shadowBlur = 12;
      ctx.shadowOffsetX = 3;
      ctx.shadowOffsetY = 3;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(partial, W / 2, H / 2);
    }

    const frameTimeSec = (startMs + i * frameMs) / 1000;
    const framePath = path.join(frameDir, `frame_${String(i).padStart(4, "0")}.png`);
    fs.writeFileSync(framePath, canvas.toBuffer("image/png"));
  }

  // Also write hold frames for the rest of the overlay duration
  const holdStart = chars.length;
  const holdEnd = Math.ceil((overlay.endTime - overlay.startTime) * 1000 / frameMs);
  for (let j = holdStart; j <= holdEnd; j++) {
    const src = path.join(frameDir, `frame_${String(holdStart).padStart(4, "0")}.png`);
    const dst = path.join(frameDir, `frame_${String(j).padStart(4, "0")}.png`);
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }

  return frameDir;
}

// ── FFmpeg overlay filter using pre-rendered PNG frames ──────────────────────

function buildTypewriterFFmpegOverlay(
  frameDir: string,
  startTime: number,
  endTime: number,
  inputIdx: number // index of the image2 input
): { inputArgs: string; filterSegment: string } {
  return {
    inputArgs: `-framerate ${Math.round(1000 / TYPEWRITER_MS)} -i "${path.join(frameDir, "frame_%04d.png")}"`,
    filterSegment:
      `[${inputIdx}:v]setpts=PTS+${startTime.toFixed(3)}/TB[tw${inputIdx}];` +
      `[prev][tw${inputIdx}]overlay=0:0:enable='between(t,${startTime.toFixed(3)},${endTime.toFixed(3)})'`
  };
}

// ── Main render function ──────────────────────────────────────────────────────

export async function applyTextOverlays(
  videoPath: string,
  plan: SceneTextPlan,
  workDir: string,
  outputPath: string
): Promise<string> {
  if (!plan.overlays.length) return videoPath;
  if (!fs.existsSync(videoPath)) return videoPath;

  // Probe video duration
  let videoDur = 30;
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
    );
    videoDur = parseFloat(stdout.trim()) || videoDur;
  } catch { /* use default */ }

  // Build drawtext filter chain (all non-typewriter overlays)
  const drawtextFilters: string[] = [];
  const typewriterOverlays: Array<{ overlay: TextOverlay; idx: number }> = [];

  for (let i = 0; i < plan.overlays.length; i++) {
    const o = plan.overlays[i];
    // Clamp to video duration
    const start = Math.max(0, Math.min(o.startTime, videoDur - 0.5));
    const end   = Math.max(start + 0.5, Math.min(o.endTime, videoDur - 0.1));
    const clamped: TextOverlay = { ...o, startTime: start, endTime: end };

    if (o.animation === "typewriter") {
      typewriterOverlays.push({ overlay: clamped, idx: i });
    } else if (o.position === "center") {
      if (o.type === "year") {
        drawtextFilters.push(...buildYearFilter(clamped));
      } else {
        drawtextFilters.push(...buildHeadlineFilter(clamped, videoDur));
      }
    } else {
      drawtextFilters.push(...buildLabelFilter(clamped, videoDur));
    }
  }

  // ── Path A: only drawtext (most common) ──────────────────────────────────
  if (typewriterOverlays.length === 0) {
    if (drawtextFilters.length === 0) return videoPath;
    const vf = drawtextFilters.join(",");
    try {
      await withTimeout(execAsync(
        `${FFMPEG_BIN} -y -i "${videoPath}" -vf "${vf}" ` +
        `-c:v libx264 -preset fast -crf 18 -c:a copy "${outputPath}"`
      ), FFMPEG_TIMEOUT_MS);
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10_000) {
        console.log(`[TextOverlay] s${plan.sceneIndex}: ${plan.overlays.length} overlay(s) applied via drawtext`);
        return outputPath;
      }
    } catch (err) {
      console.warn(`[TextOverlay] drawtext failed on scene ${plan.sceneIndex}:`, (err as Error).message?.slice(0, 120));
    }
    return videoPath;
  }

  // ── Path B: typewriter overlays (needs canvas) ───────────────────────────
  const frameDirs: Array<{ dir: string; overlay: TextOverlay; idx: number }> = [];
  for (const { overlay, idx } of typewriterOverlays) {
    const dir = await renderTypewriterOverlay(overlay, workDir, plan.sceneIndex, idx);
    if (dir) {
      frameDirs.push({ dir, overlay, idx });
    } else {
      // canvas not available → fall back to fade headline
      drawtextFilters.push(...buildHeadlineFilter({ ...overlay, animation: "fade" }, videoDur));
    }
  }

  if (frameDirs.length === 0) {
    // All typewriter fell back to drawtext
    if (drawtextFilters.length === 0) return videoPath;
    const vf = drawtextFilters.join(",");
    try {
      await withTimeout(execAsync(
        `${FFMPEG_BIN} -y -i "${videoPath}" -vf "${vf}" ` +
        `-c:v libx264 -preset fast -crf 18 -c:a copy "${outputPath}"`
      ), FFMPEG_TIMEOUT_MS);
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10_000) return outputPath;
    } catch { /* fall through */ }
    return videoPath;
  }

  // Build complex filter with PNG frame overlays + drawtext
  const extraInputs = frameDirs
    .map(({ dir, overlay }) =>
      `-framerate ${Math.round(1000 / TYPEWRITER_MS)} ` +
      `-start_number 0 -i "${path.join(dir, "frame_%04d.png")}"`
    )
    .join(" ");

  let filterComplex = `[0:v]${drawtextFilters.length ? drawtextFilters.join(",") + "[vdt]" : "copy[vdt]"};`;
  let prevLabel = "vdt";

  for (let j = 0; j < frameDirs.length; j++) {
    const { overlay } = frameDirs[j];
    const inputIdx = j + 1;
    const outLabel = j === frameDirs.length - 1 ? "vout" : `vtw${j}`;
    filterComplex +=
      `[${inputIdx}:v]setpts=PTS+${overlay.startTime.toFixed(3)}/TB[tw${j}];` +
      `[${prevLabel}][tw${j}]overlay=0:0:enable='between(t,${overlay.startTime.toFixed(3)},${overlay.endTime.toFixed(3)})'[${outLabel}];`;
    prevLabel = outLabel;
  }

  try {
    await withTimeout(execAsync(
      `${FFMPEG_BIN} -y -i "${videoPath}" ${extraInputs} ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[vout]" -map "0:a?" ` +
      `-c:v libx264 -preset fast -crf 18 -c:a copy "${outputPath}"`
    ), FFMPEG_TIMEOUT_MS);
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10_000) {
      console.log(`[TextOverlay] s${plan.sceneIndex}: typewriter overlay applied`);
      // Cleanup frame dirs
      for (const { dir } of frameDirs) {
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
      }
      return outputPath;
    }
  } catch (err) {
    console.warn(`[TextOverlay] typewriter overlay failed on scene ${plan.sceneIndex}:`, (err as Error).message?.slice(0, 120));
  }

  return videoPath;
}

export async function applyTextOverlaysToScenes(
  scenePaths: string[],
  scenePlans: SceneTextPlan[],
  workDir: string
): Promise<string[]> {
  const results: string[] = [];
  for (let i = 0; i < scenePaths.length; i++) {
    const plan = scenePlans[i];
    const src = scenePaths[i];
    if (!plan || !plan.overlays.length) {
      results.push(src);
      continue;
    }
    const outPath = path.join(workDir, `scene_overlay_s${i}.mp4`);
    const result = await applyTextOverlays(src, plan, workDir, outPath);
    results.push(result);
  }
  return results;
}
