/**
 * Reference-documentary visual style (history-short aesthetic):
 * blur-fill stills, polaroid collages, film grain, orange name badges,
 * yellow highlight captions, vintage color grade.
 */
import * as fs from "fs";
import * as path from "path";
import { sanitizeForDrawtext } from "./ffmpegSanitize";
import { vidrushStillPhotoScale } from "./vidrushQuality";
import { ffmpegThreadFlag } from "./sourcingPolicy";

export const DOC_STYLE_VIDEO_WIDTH = 1920;
export const DOC_STYLE_VIDEO_HEIGHT = 1080;

/** Off by default; set ENABLE_DOC_STYLE=true to enable. */
export function documentaryStyleEnabled(): boolean {
  return process.env.ENABLE_DOC_STYLE === "true";
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

/** Phase 10: clip source, so grading can differ instead of applying one fixed look to every
 *  clip regardless of where it came from. Callers classify with their own source-detection
 *  logic (e.g. videoPipeline.ts's isAIGeneratedClip/isStockVideoClip — not imported here to
 *  avoid a circular dependency, since videoPipeline.ts imports this module) and pass the
 *  result in; omitting it keeps the original uniform grade (backwards compatible). */
export type DocGradeSourceKind = "archive" | "ai_generated" | "stock" | "unknown";

export function buildDocumentaryColorGradeVF(sourceKind?: DocGradeSourceKind): string {
  // AI-generated clips tend to read too clean/plasticky next to real archival footage —
  // pull saturation and contrast down harder to fight that. Stock footage reads too
  // glossy/modern — a moderate pull. Real archive footage already looks authentic, so it
  // keeps the original (lightest) grade.
  const { saturation, contrast } =
    sourceKind === "ai_generated"
      ? { saturation: 0.78, contrast: 1.08 }
      : sourceKind === "stock"
        ? { saturation: 0.82, contrast: 1.15 }
        : { saturation: 0.88, contrast: 1.12 };
  return (
    `eq=contrast=${contrast}:saturation=${saturation}:brightness=-0.03:gamma=1.02,` +
    "colorbalance=rs=-0.02:gs=0:bs=0.04:rm=-0.01:gm=0:bm=0.02:rh=-0.01:gh=0:bh=0.02"
  );
}

export function buildDocumentaryVignetteVF(sourceKind?: DocGradeSourceKind): string {
  // A slightly stronger vignette on AI/stock sources helps mask clean digital edges and
  // pulls the eye toward center, blending them into the surrounding archival material.
  const angle = sourceKind === "ai_generated" || sourceKind === "stock" ? 0.55 : 0.62;
  return `vignette=angle=${angle}:mode=forward`;
}

export function buildFilmGrainVF(sourceKind?: DocGradeSourceKind): string {
  if (!filmGrainEnabled()) return "";
  // Real archive footage is frequently already grainy from the source scan — don't stack
  // synthetic grain on top of that. Clean digital sources (AI-generated, stock) get more
  // grain specifically to disguise how smooth/artifact-free they are.
  const amount = sourceKind === "ai_generated" || sourceKind === "stock" ? 9 : 6;
  return `,noise=alls=${amount}:allf=t+u`;
}

export function buildPostGradeVF(sourceKind?: DocGradeSourceKind): string {
  return `${buildDocumentaryColorGradeVF(sourceKind)},${buildDocumentaryVignetteVF(sourceKind)}${buildFilmGrainVF(sourceKind)}`;
}

/** Color + vignette only — applied on each montage clip so sources match before xfade. */
export function buildPerClipDocumentaryGradeVF(sourceKind?: DocGradeSourceKind): string {
  return `${buildDocumentaryColorGradeVF(sourceKind)},${buildDocumentaryVignetteVF(sourceKind)}`;
}

/** Fit-gray trim chain with optional per-clip documentary grade. */
export function buildFitGrayGradedVideoVF(sourceKind?: DocGradeSourceKind): string {
  const base = buildFitGrayVideoVF();
  if (!documentaryStyleEnabled()) return base;
  return `${base},${buildPerClipDocumentaryGradeVF(sourceKind)}`;
}

/** Montage branch: scale/pad/fps + per-clip grade when documentary style is on. */
export function buildMontageBranchNormVF(sourceKind?: DocGradeSourceKind): string {
  const base = `${buildFitGrayVideoMontageChain()},fps=25,format=yuv420p,setsar=1`;
  if (!documentaryStyleEnabled()) return base;
  // format=yuv420p at the end ensures grade filters (colorbalance, vignette) don't
  // leave an incompatible pixel format that causes libx264 to fail on init.
  return `${base},${buildPerClipDocumentaryGradeVF(sourceKind)},format=yuv420p`;
}

/** Final scene pass — grain only when doc style is on, otherwise pass through. */
export function buildFinalSceneGradeVF(sourceKind?: DocGradeSourceKind): string {
  if (!documentaryStyleEnabled()) return "copy";
  const grain = buildFilmGrainVF(sourceKind);
  return grain ? grain.replace(/^,/, "") : "copy";
}

/** AI-generated clip path (used only as last-resort after stock search). Moved here from
 *  videoPipeline.ts (Phase 10) so both videoPipeline.ts and curatedMediaSourcing.ts can reuse
 *  the same classifier for source-aware grading without a circular import — videoPipeline.ts
 *  imports both of those, so this shared-ancestor module is the only non-circular home. */
export function isAIGeneratedClip(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return /_ai_fallback\.mp4$|_stability_|_leonardo_|_grok_|_ai\.mp4|_runway_|_kling_|_luma_|_pika_|_veo_|_forge_|scene_\d+_b\d+_ai/i.test(base);
}

export function isStockVideoClip(filePath: string): boolean {
  return /_pexels_|_pex_|_pixabay_|_pix_|_broll_|_ytcc_|_archive_|_wikivid_|_nasa_|_esa_|_b\d+_(pex|pix)/i.test(
    path.basename(filePath)
  );
}

/** Classify a clip's origin from its temp filename for source-aware grading. */
export function classifyDocGradeSourceKind(filePath: string): DocGradeSourceKind {
  if (isAIGeneratedClip(filePath)) return "ai_generated";
  if (isStockVideoClip(filePath)) return "stock";
  return "archive";
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

/**
 * Content-aware Ken Burns variant. Rotates between zoom-in / zoom-out / pan-left /
 * pan-right based on scene + beat position so adjacent clips never share the same motion.
 * Adjacent even/odd beats alternate direction; every 3rd scene gets a pan instead of zoom.
 */
export function pickKenBurnsVariant(sceneIndex: number, beatIndex: number): KenBurnsVariant {
  const VARIANTS: KenBurnsVariant[] = ["zoom-in", "pan-left", "zoom-out", "pan-right"];
  return VARIANTS[(sceneIndex * 3 + beatIndex) % VARIANTS.length];
}

/** Archive stills use content-aware variation — avoids the static frozen-image feel. */
export function archiveStillKenBurnsVariant(sceneIndex = 0, beatIndex = 0): KenBurnsVariant {
  return pickKenBurnsVariant(sceneIndex, beatIndex);
}

/** Standard B-roll motion for generated videos — same content-aware variation. */
export function standardArchiveKenBurnsVariant(sceneIndex = 0, beatIndex = 0): KenBurnsVariant {
  return pickKenBurnsVariant(sceneIndex, beatIndex);
}

/** Slower Ken Burns for documentary B-roll (~15% over clip duration). */
export function standardArchiveKenBurnsZoomEnd(durationSec: number): number {
  const t = Math.min(8, Math.max(3, durationSec));
  return 1 + 0.15 * (t / 6);
}

function autoMotionGraphicsKenBurnsLocked(): boolean {
  return process.env.ENABLE_AUTO_MOTION_GRAPHICS !== "false";
}

export function resolveStillKenBurnsVariant(sceneIndex: number, beatIndex: number): KenBurnsVariant {
  if (autoMotionGraphicsKenBurnsLocked()) {
    return standardArchiveKenBurnsVariant(sceneIndex, beatIndex);
  }
  return archiveStillKenBurnsVariant(sceneIndex, beatIndex);
}

/** Sine-based ease-out progress term, embeddable directly in a zoompan expression: 0 at the
 *  first frame, smoothly approaching 1 by the clip's last frame — never linear. `totalFrames`
 *  is a compile-time constant (known from clip duration), so this is plain arithmetic FFmpeg's
 *  expression evaluator accepts, not a runtime variable lookup. Reused verbatim (same formula)
 *  from professionalRenderEngine/cameraRenderer.ts's `easeOutTerm()`, which proved this exact
 *  pattern for the dormant engine's new camera movements (Phase 7) — duplicated here as a
 *  standalone expression rather than imported, since documentaryStyle.ts is live production
 *  code with no dependency on that dormant, feature-flagged directory. */
function easeOutProgress(totalFrames: number): string {
  return `sin(PI/2*min(on/${totalFrames},1))`;
}

/** Ken Burns zoompan — zoom 100%→120%, optional pan left/right.
 *
 *  Phase 10: zoom and pan both move along `easeOutProgress()` (0 -> 1, smoothly) rather than
 *  the previous constant per-frame increment (`zoom+step`, clamped). The previous version was
 *  perfectly linear velocity on every single still in every video — the single most
 *  recognizable "AI slideshow" tell (confirmed by the Phase 10 rendering-quality audit). Total
 *  zoom range and total pan distance are unchanged (still reaches the same `zoomEnd` and the
 *  same overall pan distance by the last frame) — only the velocity curve getting there
 *  changed, so this is a pure motion-quality improvement, not a reframing. */
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
  const zoomDelta = zoomTarget - zoomStart;
  const yExpr = yAnchor === "top" ? "ih/4-(ih/zoom/4)" : "ih/2-(ih/zoom/2)";
  // Same total pan distance as the previous linear version (panStep px/frame * totalFrames
  // frames) — only now reached via the eased progress curve instead of a constant per-frame
  // step.
  const panStep = Math.max(1, Math.round(totalFrames * 0.06));
  const panDistance = panStep * totalFrames;
  const progress = easeOutProgress(totalFrames);
  const xExpr =
    variant === "pan-left"
      ? `iw/2-(iw/zoom/2)-${panDistance}*${progress}`
      : variant === "pan-right"
        ? `iw/2-(iw/zoom/2)+${panDistance}*${progress}`
        : "iw/2-(iw/zoom/2)";
  const zExpr = `(${zoomStart.toFixed(4)}+(${zoomDelta.toFixed(7)})*${progress})`;
  return (
    `select='eq(n\\,0)',` +
    `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':` +
    `d=${totalFrames}:s=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:fps=${fps}`
  );
}

/** Simple Ken Burns fallback when blur/polaroid filters fail on the host FFmpeg.
 *  Phase 10: eased zoom (see buildKenBurnsTail's doc comment) — this fallback path renders
 *  real user-facing frames too, so it gets the same easing rather than staying linear. */
export function buildSimpleKenBurnsVF(
  duration: number,
  personPortrait: boolean
): string {
  const fps = 25;
  const totalFrames = stillOutputFrameCount(duration, fps);
  const zoomEnd = personPortrait ? 1.10 : 1.15;
  const yExpr = personPortrait ? "ih/4-(ih/zoom/4)" : "ih/2-(ih/zoom/2)";
  const cropY = personPortrait ? "0" : `(ih-${DOC_STYLE_VIDEO_HEIGHT})/2`;
  const zExpr = `(1.0+(${(zoomEnd - 1.0).toFixed(7)})*${easeOutProgress(totalFrames)})`;
  return (
    `[0:v]scale=${DOC_STYLE_VIDEO_WIDTH}:${DOC_STYLE_VIDEO_HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${DOC_STYLE_VIDEO_WIDTH}:${DOC_STYLE_VIDEO_HEIGHT}:(iw-${DOC_STYLE_VIDEO_WIDTH})/2:${cropY},` +
    `select='eq(n\\,0)',` +
    `zoompan=z='${zExpr}':` +
    `x='iw/2-(iw/zoom/2)':y='${yExpr}':` +
    `d=${totalFrames}:s=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:fps=${fps}[vout]`
  );
}

/** Blurred duplicate background + sharp foreground (reference pillarbox style). */
export function buildBlurFillStillVF(
  duration: number,
  foregroundScale = 0.78,
  yAnchor: "center" | "top" = "center",
  blurMode: "gblur" | "boxblur" = "gblur",
  variant: KenBurnsVariant = "zoom-in",
): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  const fgY = yAnchor === "top" ? "(H-h)/4" : "(H-h)/2";
  const baseZoom = yAnchor === "top" ? 1.12 : 1.18;
  const ken = buildKenBurnsTail(duration, baseZoom, yAnchor, variant);
  const blurFilter =
    blurMode === "boxblur"
      ? "boxblur=luma_radius=32:luma_power=2:chroma_radius=16:chroma_power=1"
      : "gblur=sigma=42";
  return (
    `[0:v]split=2[orig][orig2];` +
    `[orig]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},${blurFilter}[bg];` +
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
  // 1. Normalize format/SAR before scale so variable-resolution clips don't cause reinit errors.
  // 2. Use -2 instead of force_divisible_by=2: -2 tells FFmpeg to compute the other
  //    dimension while guaranteeing it's divisible by 2 — more compatible across builds.
  // 3. Two-pass scale: fit to target, then round to exact target via a second scale.
  return (
    `format=yuv420p,setsar=1/1,` +
    `scale='if(gt(iw/ih,${w}/${h}),${w},-2)':'if(gt(iw/ih,${w}/${h}),-2,${h})',` +
    `pad=${w}:${h}:(${w}-iw)/2:(${h}-ih)/2:color=0x2a2a2a`
  );
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
  photoScale = vidrushStillPhotoScale(),
  sceneIndex = 0,
  beatIndex = 0
): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  const variant = resolveStillKenBurnsVariant(sceneIndex, beatIndex);
  const zoomEnd = autoMotionGraphicsKenBurnsLocked()
    ? standardArchiveKenBurnsZoomEnd(duration)
    : Math.max(1.06, documentaryKenBurnsZoomEnd(duration));
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
    `-frames:v ${frames} -c:v libx264 ${ffmpegThreadFlag()} -preset veryfast -crf 18 -an -pix_fmt yuv420p -r 25 "${outPath}"`
  );
}

export function resolveStillCompositionVF(
  duration: number,
  sceneIndex: number,
  beatIndex: number,
  personPortrait: boolean
): string {
  return buildArchiveStillFilterComplex(duration, sceneIndex, beatIndex, personPortrait);
}

/** Smaller photo on blurred duplicate background — default for all archive/stock stills. */
export function buildArchiveStillFilterComplex(
  duration: number,
  sceneIndex: number,
  beatIndex: number,
  personPortrait = false
): string {
  const scale = vidrushStillPhotoScale();
  const variant = resolveStillKenBurnsVariant(sceneIndex, beatIndex);
  if (process.env.ARCHIVE_BLUR_FILL_STILLS === "false") {
    return buildMatFramedStillVF(duration, scale, sceneIndex, beatIndex);
  }
  return buildBlurFillStillVF(duration, scale, personPortrait ? "top" : "center", "gblur", variant);
}

/** Boxblur variant for hosts where gblur is unavailable or fails. */
export function buildArchiveStillFilterComplexBoxBlur(
  duration: number,
  sceneIndex: number,
  beatIndex: number,
  personPortrait = false
): string {
  const scale = vidrushStillPhotoScale();
  const variant = resolveStillKenBurnsVariant(sceneIndex, beatIndex);
  if (process.env.ARCHIVE_BLUR_FILL_STILLS === "false") {
    return buildMatFramedStillVF(duration, scale, sceneIndex, beatIndex);
  }
  return buildBlurFillStillVF(duration, scale, personPortrait ? "top" : "center", "boxblur", variant);
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
  overlayW?: number;
  overlayH?: number;
  /** Yellow interval label (year/keyword) — small positioned clip. */
  isScreenLabel?: boolean;
  isVideoOverlay?: boolean;
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

/**
 * Wikimedia documentary style (Visual Matching Engine V1 — AFBEELDING STIJL):
 * - Background: same image, full-screen, strongly blurred, darkened (brightness -0.15)
 * - Foreground: centered, max 80% of frame, with subtle dark shadow border
 * - Ken Burns slow zoom
 */
export function buildWikimediaDocumentaryVF(
  duration: number,
  yAnchor: "center" | "top" = "center",
  sceneIndex = 0,
  beatIndex = 0,
): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  const fgScale = 0.80;
  const shadowPad = 10;
  const fgY = yAnchor === "top" ? "(H-h)/4" : "(H-h)/2";
  const variant = resolveStillKenBurnsVariant(sceneIndex, beatIndex);
  const zoomEnd = documentaryKenBurnsZoomEnd(duration);
  const ken = buildKenBurnsTail(duration, zoomEnd, yAnchor, variant);
  return (
    `[0:v]split=2[orig][orig2];` +
    `[orig]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
    `gblur=sigma=42,eq=brightness=-0.15:contrast=0.9[bg];` +
    `[orig2]scale='min(${w}*${fgScale}/iw\\,${h}*${fgScale}/ih)*iw':-2,` +
    `pad=iw+${shadowPad * 2}:ih+${shadowPad * 2}:${shadowPad}:${shadowPad}:color=0x0c0c0c[fg];` +
    `[bg][fg]overlay=(W-w)/2:${fgY}[composed];` +
    `[composed]${ken}[vout]`
  );
}

