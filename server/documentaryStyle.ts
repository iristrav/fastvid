/**
 * Reference-documentary visual style (history-short aesthetic):
 * blur-fill stills, polaroid collages, film grain, orange name badges,
 * yellow highlight captions, vintage color grade.
 */
import * as fs from "fs";
import * as path from "path";
import { sanitizeForDrawtext } from "./ffmpegSanitize";

export const DOC_STYLE_VIDEO_WIDTH = 1920;
export const DOC_STYLE_VIDEO_HEIGHT = 1080;

/** On by default; set ENABLE_DOC_STYLE=false to disable. */
export function documentaryStyleEnabled(): boolean {
  return process.env.ENABLE_DOC_STYLE !== "false";
}

/** Film grain — on by default for documentary look (ENABLE_FILM_GRAIN=false to disable). */
export function filmGrainEnabled(): boolean {
  return process.env.ENABLE_FILM_GRAIN !== "false";
}

/** Every 4th still uses polaroid-on-grid layout instead of blur-fill (skip on Railway — rotate/gblur can fail). */
export function usePolaroidLayout(sceneIndex: number, beatIndex = 0): boolean {
  if (process.env.IS_RAILWAY === "true" || process.env.RAILWAY_ENVIRONMENT) return false;
  return (sceneIndex * 3 + beatIndex) % 4 === 0;
}

export function buildDocumentaryColorGradeVF(): string {
  return (
    "eq=contrast=1.12:saturation=0.88:brightness=-0.03:gamma=1.02," +
    "colorbalance=rs=-0.02:gs=0:bs=0.04:rm=-0.01:gm=0:bm=0.02:rh=-0.01:gh=0:bh=0.02"
  );
}

export function buildDocumentaryVignetteVF(): string {
  return "vignette=angle=0.62:mode=forward";
}

export function buildFilmGrainVF(): string {
  if (!filmGrainEnabled()) return "";
  return ",noise=alls=6:allf=t+u";
}

export function buildPostGradeVF(): string {
  return `${buildDocumentaryColorGradeVF()},${buildDocumentaryVignetteVF()}${buildFilmGrainVF()}`;
}

export function stillOutputFrameCount(duration: number, fps = 25): number {
  return Math.max(25, Math.round(duration * fps));
}

export type KenBurnsVariant = "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "center";

/** ~20% zoom over 6s — scales with clip duration. */
export function documentaryKenBurnsZoomEnd(durationSec: number): number {
  const t = Math.min(8, Math.max(3, durationSec));
  return 1 + 0.2 * (t / 6);
}

export function pickKenBurnsVariant(sceneIndex: number, beatIndex: number): KenBurnsVariant {
  const variants: KenBurnsVariant[] = ["zoom-in", "pan-left", "pan-right", "zoom-out", "center"];
  return variants[(sceneIndex * 3 + beatIndex) % variants.length];
}

/** Archive stills always zoom in slightly — avoids static/frozen-looking frames. */
export function archiveStillKenBurnsVariant(_sceneIndex = 0, _beatIndex = 0): KenBurnsVariant {
  return "zoom-in";
}

/** Ken Burns zoompan — zoom 100%→120%, optional pan left/right. */
export function buildKenBurnsTail(
  duration: number,
  zoomEnd = 1.04,
  yAnchor: "center" | "top" = "center",
  variant: KenBurnsVariant = "zoom-in"
): string {
  const fps = 25;
  const totalFrames = stillOutputFrameCount(duration, fps);
  const zoomStart = variant === "zoom-out" ? zoomEnd : 1.0;
  const zoomTarget = variant === "zoom-out" ? 1.0 : zoomEnd;
  const zoomStep = Math.abs(zoomTarget - zoomStart) / totalFrames;
  const yExpr = yAnchor === "top" ? "ih/4-(ih/zoom/4)" : "ih/2-(ih/zoom/2)";
  const panStep = Math.max(1, Math.round(totalFrames * 0.06));
  const xExpr =
    variant === "pan-left"
      ? `iw/2-(iw/zoom/2)-on*${panStep}`
      : variant === "pan-right"
        ? `iw/2-(iw/zoom/2)+on*${panStep}`
        : "iw/2-(iw/zoom/2)";
  const zExpr =
    variant === "zoom-out"
      ? `max(zoom-${zoomStep.toFixed(7)},${zoomTarget.toFixed(4)})`
      : `min(zoom+${zoomStep.toFixed(7)},${zoomTarget.toFixed(4)})`;
  return (
    `select='eq(n\\,0)',` +
    `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':` +
    `d=${totalFrames}:s=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:fps=${fps}`
  );
}

/** Simple Ken Burns fallback when blur/polaroid filters fail on the host FFmpeg. */
export function buildSimpleKenBurnsVF(
  duration: number,
  personPortrait: boolean
): string {
  const fps = 25;
  const totalFrames = stillOutputFrameCount(duration, fps);
  const zoomEnd = personPortrait ? 1.02 : 1.03;
  const zoomStep = (zoomEnd - 1.0) / totalFrames;
  const yExpr = personPortrait ? "ih/4-(ih/zoom/4)" : "ih/2-(ih/zoom/2)";
  const cropY = personPortrait ? "0" : `(ih-${DOC_STYLE_VIDEO_HEIGHT})/2`;
  return (
    `[0:v]scale=${DOC_STYLE_VIDEO_WIDTH}:${DOC_STYLE_VIDEO_HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${DOC_STYLE_VIDEO_WIDTH}:${DOC_STYLE_VIDEO_HEIGHT}:(iw-${DOC_STYLE_VIDEO_WIDTH})/2:${cropY},` +
    `select='eq(n\\,0)',` +
    `zoompan=z='min(zoom+${zoomStep.toFixed(7)},${zoomEnd})':` +
    `x='iw/2-(iw/zoom/2)':y='${yExpr}':` +
    `d=${totalFrames}:s=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:fps=${fps}[vout]`
  );
}

/** Blurred duplicate background + sharp foreground (reference pillarbox style). */
export function buildBlurFillStillVF(
  duration: number,
  foregroundScale = 0.78,
  yAnchor: "center" | "top" = "center"
): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  const fgY = yAnchor === "top" ? "(H-h)/4" : "(H-h)/2";
  const ken = buildKenBurnsTail(duration, yAnchor === "top" ? 1.02 : 1.04, yAnchor);
  return (
    `[0:v]split=2[orig][orig2];` +
    `[orig]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=38[bg];` +
    `[orig2]scale='min(${w}*${foregroundScale}/iw\\,${h}*${foregroundScale}/ih)*iw':-2[fg];` +
    `[bg][fg]overlay=(W-w)/2:${fgY}[composed];` +
    `[composed]${ken}[vout]`
  );
}

/** Archive B-roll: full clip in frame on dark gray — fast (no gblur). */
export function buildFitGrayVideoFilterComplex(): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  return (
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x2a2a2a,format=yuv420p[vout]`
  );
}

/** Single -vf chain for archive clip trim (fast encode). */
export function buildFitGrayVideoVF(): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x2a2a2a,fps=25,format=yuv420p`
  );
}

/** Montage prep chain after trim — fit entire clip, gray letterbox. */
export function buildFitGrayVideoMontageChain(): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x2a2a2a`
  );
}

/** @deprecated Use buildFitGrayVideoFilterComplex — gblur is too slow on Railway. */
export function buildBlurFillVideoFilterComplex(): string {
  return buildFitGrayVideoFilterComplex();
}

/** @deprecated Use buildFitGrayVideoMontageChain. */
export function buildBlurFillVideoMontageChain(): string {
  return buildFitGrayVideoMontageChain();
}

/** Polaroid white frame on light gray canvas (no rotate — fragile on minimal FFmpeg builds). */
export function buildPolaroidStillVF(duration: number): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  const ken = buildKenBurnsTail(duration, 1.03, "center");
  return (
    `[0:v]scale=920:-1,` +
    `pad=960:1040:20:80:white,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2+30:color=0xD8D8D8,` +
    `${ken}[vout]`
  );
}

/** Photo on neutral gray mat — smaller than frame (reference-doc / City Beautiful style). */
export function buildMatFramedStillVF(
  duration: number,
  photoScale = 0.74,
  sceneIndex = 0,
  beatIndex = 0
): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  const variant = archiveStillKenBurnsVariant(sceneIndex, beatIndex);
  const zoomEnd = Math.max(1.06, documentaryKenBurnsZoomEnd(duration));
  const ken = buildKenBurnsTail(duration, zoomEnd, "center", variant);
  return (
    `[0:v]scale='min(${w}*${photoScale}/iw\\,${h}*${photoScale}/ih)*iw':-2,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0xCFCFCF[mat];` +
    `[mat]${ken}[vout]`
  );
}

export function buildStillEncodeArgs(
  imgPath: string,
  outPath: string,
  duration: number,
  filterComplex: string
): string {
  const frames = stillOutputFrameCount(duration);
  return (
    `-y -i "${imgPath}" -filter_complex "${filterComplex}" -map "[vout]" ` +
    `-frames:v ${frames} -c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p -r 25 "${outPath}"`
  );
}

export function resolveStillCompositionVF(
  duration: number,
  sceneIndex: number,
  beatIndex: number,
  personPortrait: boolean
): string {
  if (usePolaroidLayout(sceneIndex, beatIndex)) {
    return buildPolaroidStillVF(duration);
  }
  return buildBlurFillStillVF(
    duration,
    personPortrait ? 0.72 : 0.78,
    personPortrait ? "top" : "center"
  );
}

export interface TimedOverlay {
  path: string;
  startTime: number;
  endTime: number;
  isStatCallout?: boolean;
  isNameBadge?: boolean;
  isYearBadge?: boolean;
  isParticle?: boolean;
  /** Full-frame PNG — overlay at 0:0 (content positioned inside PNG). */
  fullFrame?: boolean;
  /** Positioned overlay (e.g. year badge) — composited over footage at x/y. */
  overlayX?: number;
  overlayY?: number;
}

export async function renderNameBadgeOverlay(
  name: string,
  sceneIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  durationSec = 3.0
): Promise<TimedOverlay | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const safeName = sanitizeForDrawtext(trimmed, 40);
  const FONT_SIZE = 42;
  const PAD_X = 28;
  const PAD_Y = 14;
  const estTextW = Math.min(safeName.length * FONT_SIZE * 0.55, DOC_STYLE_VIDEO_WIDTH - 200);
  const boxW = Math.round(estTextW + PAD_X * 2);
  const boxH = FONT_SIZE + PAD_Y * 2;
  const boxX = Math.round((DOC_STYLE_VIDEO_WIDTH - boxW) / 2);
  const boxY = DOC_STYLE_VIDEO_HEIGHT - boxH - 72;

  const pngPath = path.join(workDir, `scene_${sceneIndex}_name_badge.png`);
  try {
    await execWithTimeout(
      `${ffmpegBin} -y ` +
        `-f lavfi -i "color=c=black@0:size=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:rate=1" ` +
        `-vf "drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=FF7A00@0.96:t=fill,` +
        `drawtext=text='${safeName}':fontcolor=black:fontsize=${FONT_SIZE}:x=${boxX + PAD_X}:y=${boxY + PAD_Y}" ` +
        `-frames:v 1 -pix_fmt rgba "${pngPath}"`,
      8_000,
      `Name badge scene ${sceneIndex}`
    );
    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      return { path: pngPath, startTime: 0.4, endTime: Math.min(durationSec, 3.4), isNameBadge: true, fullFrame: true };
    }
  } catch {
    /* non-fatal */
  }
  return null;
}

export async function renderHighlightCaptionOverlay(
  highlightWord: string,
  sceneIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  sceneDuration: number
): Promise<TimedOverlay | null> {
  const word = highlightWord.trim();
  if (!word) return null;

  const safeWord = sanitizeForDrawtext(word.toUpperCase(), 24);
  const FONT_SIZE = 52;
  const PAD_X = 22;
  const PAD_Y = 12;
  const estTextW = Math.min(safeWord.length * FONT_SIZE * 0.58, DOC_STYLE_VIDEO_WIDTH / 2);
  const boxW = Math.round(estTextW + PAD_X * 2);
  const boxH = FONT_SIZE + PAD_Y * 2;
  const boxX = Math.round((DOC_STYLE_VIDEO_WIDTH - boxW) / 2);
  const boxY = Math.round(DOC_STYLE_VIDEO_HEIGHT * 0.42);

  const pngPath = path.join(workDir, `scene_${sceneIndex}_highlight_caption.png`);
  const startTime = Math.max(0.8, sceneDuration * 0.25);
  const endTime = Math.min(sceneDuration - 0.3, startTime + 2.2);

  try {
    await execWithTimeout(
      `${ffmpegBin} -y ` +
        `-f lavfi -i "color=c=black@0:size=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:rate=1" ` +
        `-vf "drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=FFD200@0.97:t=fill,` +
        `drawtext=text='${safeWord}':fontcolor=black:fontsize=${FONT_SIZE}:x=${boxX + PAD_X}:y=${boxY + PAD_Y}" ` +
        `-frames:v 1 -pix_fmt rgba "${pngPath}"`,
      8_000,
      `Highlight caption scene ${sceneIndex}`
    );
    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      return { path: pngPath, startTime, endTime, fullFrame: true };
    }
  } catch {
    /* non-fatal */
  }
  return null;
}

/** Apply vintage grade + optional grain to an existing clip (fair-use transform path). */
export async function applyDocumentaryClipGrade(
  inputPath: string,
  outputPath: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  timeoutMs = 120_000
): Promise<string> {
  const grade = buildPostGradeVF();
  await execWithTimeout(
    `${ffmpegBin} -y -i "${inputPath}" -vf "${grade}" ` +
      `-c:v libx264 -preset veryfast -crf 20 -an -pix_fmt yuv420p "${outputPath}"`,
    timeoutMs,
    `Documentary grade ${path.basename(inputPath)}`
  );
  return outputPath;
}
