/**
 * Editorial Overlay Engine — FFmpeg renderer.
 *
 * Key improvements over the old textOverlay renderer:
 * 1. Two-line headlines: two stacked drawtext filters instead of one, so long
 *    titles like "WHY HITLER WANTED TOTAL CONTROL" never overflow the frame.
 * 2. Reduced font size (64px headline vs 88px old) — fits ~29 chars per line.
 * 3. Cleaner lower-third design with pill background.
 * 4. Type-specific visual treatment (headline vs label vs closing).
 */

import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { BeatOverlay, SceneOverlayPlan } from "./types";

const execAsync = promisify(exec);
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";
const FFMPEG_TIMEOUT_MS = 90_000;

// ── Design tokens ─────────────────────────────────────────────────────────────

const WHITE        = "white";
const GOLD         = "0xFFD54F";        // warm gold accent
const DARK_SEMI    = "0x00000099";      // rgba(0,0,0,0.60) label background
const FONT_H1      = 64;               // primary headline (fits ~29 chars at 1920px)
const FONT_H2      = 46;               // secondary headline / subtitle line
const FONT_LABEL   = 40;               // lower-third primary text
const FONT_SUB     = 28;               // lower-third subtitle
const SHADOW_X     = 2;
const SHADOW_Y     = 2;
const FADE_DUR     = 0.4;
const LABEL_PAD_W  = 32;
const LABEL_PAD_H  = 18;
const LABEL_MARGIN_X = 48;
const LABEL_MARGIN_Y = 56;

// ── Escaping ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

// ── Timing expressions ────────────────────────────────────────────────────────

function alphaExpr(start: number, end: number): string {
  const s = start.toFixed(3);
  const e = end.toFixed(3);
  const fin = (start + FADE_DUR).toFixed(3);
  const fout = (end - FADE_DUR).toFixed(3);
  return (
    `if(gt(t,${e}),0,` +
    `if(gt(t,${fout}),(${e}-t)/${FADE_DUR.toFixed(3)},` +
    `if(lt(t,${s}),0,` +
    `if(lt(t,${fin}),(t-${s})/${FADE_DUR.toFixed(3)},` +
    `1))))`
  );
}

function enableExpr(start: number, end: number): string {
  return `between(t,${start.toFixed(3)},${end.toFixed(3)})`;
}

// ── Filter builders ───────────────────────────────────────────────────────────

/**
 * Centered headline (chapter_title, historical_event, closing_statement, date_era, quote, statistic).
 * Two-line layout when line2 is present.
 */
function buildCenteredFilters(overlay: BeatOverlay): string[] {
  const { line1, line2, startSec, endSec } = overlay;
  const alpha = alphaExpr(startSec, endSec);
  const filters: string[] = [];

  if (line2) {
    // Two-line stacked layout
    // line1 at center - half lineHeight, line2 at center + half lineHeight
    const lineGap = FONT_H1 + 10;
    filters.push(
      `drawtext=text='${esc(line1)}':fontcolor=${WHITE}:fontsize=${FONT_H1}:` +
      `x=(w-text_w)/2:y=(h-text_h)/2-${Math.round(lineGap / 2)}:` +
      `alpha='${alpha}':shadowcolor=black:shadowx=${SHADOW_X}:shadowy=${SHADOW_Y}`
    );
    filters.push(
      `drawtext=text='${esc(line2)}':fontcolor=${WHITE}:fontsize=${FONT_H1}:` +
      `x=(w-text_w)/2:y=(h+text_h)/2+${Math.round(lineGap / 2) - FONT_H1}:` +
      `alpha='${alpha}':shadowcolor=black:shadowx=${SHADOW_X}:shadowy=${SHADOW_Y}`
    );
  } else {
    filters.push(
      `drawtext=text='${esc(line1)}':fontcolor=${WHITE}:fontsize=${FONT_H1}:` +
      `x=(w-text_w)/2:y=(h-text_h)/2:` +
      `alpha='${alpha}':shadowcolor=black:shadowx=${SHADOW_X}:shadowy=${SHADOW_Y}`
    );
  }

  return filters;
}

/**
 * Chapter title — same as centered but with gold accent line below.
 */
function buildChapterTitleFilters(overlay: BeatOverlay): string[] {
  const { line1, line2, startSec, endSec } = overlay;
  const alpha = alphaExpr(startSec, endSec);
  const enable = enableExpr(startSec, endSec);
  const filters: string[] = [];

  if (line2) {
    const lineGap = FONT_H1 + 10;
    filters.push(
      `drawtext=text='${esc(line1)}':fontcolor=${WHITE}:fontsize=${FONT_H1}:` +
      `x=(w-text_w)/2:y=(h-text_h)/2-${Math.round(lineGap / 2)}:` +
      `alpha='${alpha}':shadowcolor=black:shadowx=${SHADOW_X}:shadowy=${SHADOW_Y}`
    );
    filters.push(
      `drawtext=text='${esc(line2)}':fontcolor=${WHITE}:fontsize=${FONT_H1}:` +
      `x=(w-text_w)/2:y=(h+text_h)/2+${Math.round(lineGap / 2) - FONT_H1}:` +
      `alpha='${alpha}':shadowcolor=black:shadowx=${SHADOW_X}:shadowy=${SHADOW_Y}`
    );
  } else {
    filters.push(
      `drawtext=text='${esc(line1)}':fontcolor=${WHITE}:fontsize=${FONT_H1}:` +
      `x=(w-text_w)/2:y=(h-text_h)/2:` +
      `alpha='${alpha}':shadowcolor=black:shadowx=${SHADOW_X}:shadowy=${SHADOW_Y}`
    );
    // Gold accent line under single-line chapter title
    if (line1.length < 25) {
      // Approximate width: fontsize * 0.55 per char
      const approxW = Math.min(line1.length * Math.round(FONT_H1 * 0.55), 900);
      filters.push(
        `drawbox=x=(w-${approxW})/2:y=h/2+${Math.round(FONT_H1 / 2) + 8}:` +
        `w=${approxW}:h=3:color=${GOLD}:t=fill:enable='${enable}'`
      );
    }
  }

  return filters;
}

/**
 * Person introduction / location → lower-third label with background pill.
 */
function buildLowerThirdFilters(overlay: BeatOverlay): string[] {
  const { line1, line2, startSec, endSec } = overlay;
  const alpha = alphaExpr(startSec, endSec);
  const enable = enableExpr(startSec, endSec);
  const filters: string[] = [];

  const boxH = line2
    ? FONT_LABEL + FONT_SUB + LABEL_PAD_H * 2 + 6
    : FONT_LABEL + LABEL_PAD_H * 2;

  // Approximate box width
  const approxW = Math.max(
    line1.length * Math.round(FONT_LABEL * 0.6),
    (line2?.length ?? 0) * Math.round(FONT_SUB * 0.58),
    200
  ) + LABEL_PAD_W * 2;

  const boxX = LABEL_MARGIN_X;
  const boxY = `h-${LABEL_MARGIN_Y + boxH}`;

  // Background
  filters.push(
    `drawbox=x=${boxX}:y=${boxY}:w=${approxW}:h=${boxH}:` +
    `color=${DARK_SEMI}:t=fill:enable='${enable}'`
  );

  // Gold accent left bar
  filters.push(
    `drawbox=x=${boxX}:y=${boxY}:w=4:h=${boxH}:color=${GOLD}:t=fill:enable='${enable}'`
  );

  // Primary text
  filters.push(
    `drawtext=text='${esc(line1)}':fontcolor=${WHITE}:fontsize=${FONT_LABEL}:` +
    `x=${boxX + LABEL_PAD_W + 4}:y=h-${LABEL_MARGIN_Y + boxH - LABEL_PAD_H}:` +
    `alpha='${alpha}'`
  );

  // Subtitle (role, year, etc.)
  if (line2) {
    filters.push(
      `drawtext=text='${esc(line2)}':fontcolor=${GOLD}:fontsize=${FONT_SUB}:` +
      `x=${boxX + LABEL_PAD_W + 4}:y=h-${LABEL_MARGIN_Y + FONT_SUB + LABEL_PAD_H - 4}:` +
      `alpha='${alpha}'`
    );
  }

  return filters;
}

/**
 * Date/era — centered, smaller font, gold colour.
 */
function buildDateEraFilters(overlay: BeatOverlay): string[] {
  const { line1, startSec, endSec } = overlay;
  const alpha = alphaExpr(startSec, endSec);
  return [
    `drawtext=text='${esc(line1)}':fontcolor=${GOLD}:fontsize=${FONT_H2}:` +
    `x=(w-text_w)/2:y=(h-text_h)/2:` +
    `alpha='${alpha}':shadowcolor=black:shadowx=${SHADOW_X}:shadowy=${SHADOW_Y}`
  ];
}

function overlayToFilters(overlay: BeatOverlay): string[] {
  switch (overlay.type) {
    case "chapter_title":
      return buildChapterTitleFilters(overlay);
    case "person_introduction":
    case "location":
    case "context_label":
      return buildLowerThirdFilters(overlay);
    case "date_era":
      return buildDateEraFilters(overlay);
    case "historical_event":
    case "closing_statement":
    case "quote":
    case "statistic":
      return buildCenteredFilters(overlay);
    default:
      return buildCenteredFilters(overlay);
  }
}

// ── Per-scene apply ───────────────────────────────────────────────────────────

export async function applyEditorialOverlays(
  videoPath: string,
  plan: SceneOverlayPlan,
  workDir: string,
  outputPath: string
): Promise<string> {
  if (!plan.overlays.length) return videoPath;
  if (!fs.existsSync(videoPath)) return videoPath;

  // Probe duration
  let videoDur = 30;
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
    );
    videoDur = parseFloat(stdout.trim()) || videoDur;
  } catch { /* use default */ }

  const filters: string[] = [];
  for (const overlay of plan.overlays) {
    // Clamp to video duration
    const clamped: BeatOverlay = {
      ...overlay,
      startSec: Math.max(0.1, Math.min(overlay.startSec, videoDur - 1.0)),
      endSec: Math.max(overlay.startSec + 0.5, Math.min(overlay.endSec, videoDur - 0.1)),
    };
    filters.push(...overlayToFilters(clamped));
  }

  if (!filters.length) return videoPath;

  const vf = filters.join(",");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("FFmpeg timeout")), FFMPEG_TIMEOUT_MS);
      execAsync(
        `${FFMPEG_BIN} -y -i "${videoPath}" -vf "${vf}" ` +
        `-c:v libx264 -preset fast -crf 18 -c:a copy "${outputPath}"`
      ).then(() => { clearTimeout(timer); resolve(); })
       .catch(err => { clearTimeout(timer); reject(err); });
    });

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10_000) {
      console.log(
        `[EditorialOverlay] s${plan.sceneIndex}: ${plan.overlays.length} overlay(s) burned in ` +
        `(${plan.overlays.map(o => o.type).join(", ")})`
      );
      return outputPath;
    }
  } catch (err) {
    console.warn(
      `[EditorialOverlay] s${plan.sceneIndex}: FFmpeg failed (non-fatal):`,
      (err as Error).message?.slice(0, 150)
    );
  }

  return videoPath;
}

export async function applyEditorialOverlaysToScenes(
  scenePaths: string[],
  plan: import("./types").VideoOverlayPlan,
  workDir: string
): Promise<string[]> {
  const results: string[] = [];
  for (let i = 0; i < scenePaths.length; i++) {
    const scenePlan = plan.scenes[i];
    const src = scenePaths[i];
    if (!scenePlan || !scenePlan.overlays.length) {
      results.push(src);
      continue;
    }
    const outPath = path.join(workDir, `scene_eo_s${i}.mp4`);
    results.push(await applyEditorialOverlays(src, scenePlan, workDir, outPath));
  }
  return results;
}
