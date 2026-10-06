
import * as path from "path";
import { vidrushStillPhotoScale } from "./vidrushQuality";
import { ffmpegThreadFlag } from "./sourcingPolicy";

export const DOC_STYLE_VIDEO_WIDTH = 1920;
export const DOC_STYLE_VIDEO_HEIGHT = 1080;

/** Off by default; set ENABLE_DOC_STYLE=true to enable. */
export function documentaryStyleEnabled(): boolean {
  return process.env.ENABLE_DOC_STYLE === "true";
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

/**
 * VIDEO 636 — a film from an open historical archive (Internet Archive, Wikimedia video). Counted
 * as "stock" for the grade above, but it is not commercial stock, and the person-topic gate in
 * `judgeCandidateMetadata` no longer treats it as such.
 */
export function isOpenArchiveVideoClip(filePath: string): boolean {
  return /_archive_|_wikivid_/i.test(path.basename(filePath));
}

/** Classify a clip's origin from its temp filename for source-aware grading. */
export function classifyDocGradeSourceKind(filePath: string): DocGradeSourceKind {
  if (isAIGeneratedClip(filePath)) return "ai_generated";
  if (isStockVideoClip(filePath)) return "stock";
  return "archive";
}

/**
 * RONDE 149 — the same classification, from a PROVIDER instead of a filename.
 *
 * `classifyDocGradeSourceKind` reads a temp filename, which is the only handle the old pipeline
 * ever had. The timeline has something better: a proven provider from the lineage ledger, which
 * survives the work directory being deleted and cannot be fooled by a rename.
 *
 * Both live here, next to each other and next to the grades they feed, because they answer one
 * question — "what kind of picture is this, so it can be matched to the others?" — and a second
 * answer living somewhere else is how two clips from the same source end up graded differently.
 *
 * The unknown case returns "unknown" rather than guessing "archive". The three grades differ by
 * how hard they pull saturation and contrast, and applying an archive grade to a glossy stock clip
 * leaves it looking glossy next to everything else — the exact mismatch the grade exists to fix.
 */
export function docGradeSourceKindForProvider(
  provider: string | null | undefined,
  opts: { archiveAssetId?: number | null } = {}
): DocGradeSourceKind {
  // A row in our own archive is archive material whatever the archive happens to be called.
  if (opts.archiveAssetId != null) return "archive";
  const p = (provider ?? "").trim().toLowerCase();
  if (!p) return "unknown";

  /** Institutional and public-domain collections: real archival footage and stills. */
  if (["archive", "curated", "wikimedia", "loc", "internet_archive", "nara", "nasa", "europeana"].includes(p)) {
    return "archive";
  }
  /** Commercial stock and modern uploads: clean, glossy, needs the strongest pull. */
  if (["pexels", "pixabay", "openverse", "unsplash", "youtube_cc", "youtube"].includes(p)) {
    return "stock";
  }
  /** Generative sources read plasticky next to real footage and get the hardest correction. */
  if (["ai", "ai_generated", "grok", "kling", "higgsfield", "runway", "luma", "pika", "veo", "stability", "leonardo"].includes(p)) {
    return "ai_generated";
  }
  /**
   * An archive an operator named themselves ("wwii_archive", "nara_films") is archive material.
   * Checked last so it cannot shadow a known provider that happens to contain the word.
   */
  if (p.includes("archive")) return "archive";
  return "unknown";
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
/**
 * VIDEO 626 — "Hij zoomt nu te raar in." A photograph moves slowly and evenly: at most
 * `STILL_MAX_ZOOM` over the whole shot, whatever its length, with no fast start. It was up to 20%
 * (1 + 0.15 × 8/6) and eased so most of it happened in the first second.
 */
export const STILL_MAX_ZOOM = 1.06;

export function standardArchiveKenBurnsZoomEnd(durationSec: number): number {
  const t = Math.min(8, Math.max(3, durationSec));
  return Math.min(STILL_MAX_ZOOM, 1 + 0.06 * (t / 8));
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

/**
 * The progress term of a still's move, embeddable in a zoompan expression: 0 at the first frame,
 * 1 at the last.
 *
 * RONDE 111 eased it (a sine blended with a line) so a move would not look machine-made, and
 * VIDEO 626 found the ease was what looked wrong: a third of the move in the first second, then a
 * crawl. With the move now at most `STILL_MAX_ZOOM`, even is what reads as slow.
 */
/** VIDEO 626 — even from the first frame to the last: an eased start read as a sudden zoom. */
function easeOutProgress(totalFrames: number): string {
  return `min(on/${totalFrames},1)`;
}

/**
 * RONDE 147 — how far a pan may travel: only as far as the zoom has actually made room for.
 *
 * ── The defect ───────────────────────────────────────────────────────────────────────────────
 *
 * The pan distance was `panStep * totalFrames`, and `panStep` was itself `totalFrames * 0.06`.
 * That makes the travel QUADRATIC in duration — the longer the shot, the further it slides:
 *
 *     3s    75 frames    300px
 *     5s   125 frames   1000px
 *     8s   200 frames   2400px
 *    12s   300 frames   5400px
 *
 * At the zoom these stills actually use (1.04), a 1920-wide image affords a half-range of
 * (1920 − 1920/1.04) / 2 ≈ 37px before the sampling window runs off the edge of the picture. So
 * the pan asked for between 8× and 146× more travel than existed. ffmpeg clamps x rather than
 * erroring, which is why this shipped: the window simply pinned itself against the edge and stayed
 * there for the rest of the shot. That is the reported symptom — the image zooms toward the edge
 * and part of it leaves the frame.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────────────────────
 *
 * Express the offset as a FRACTION OF WHAT THE ZOOM AFFORDS, inside the expression, rather than as
 * a pixel count computed in TypeScript:
 *
 *     centre           iw/2-(iw/zoom/2)
 *     affordable half  (iw-iw/zoom)/2        ← evaluated per frame, at that frame's zoom
 *
 * ffmpeg evaluates both per frame, so the bound holds at every zoom level by construction and
 * cannot be got wrong by arithmetic here. Three properties follow, and they are the brief's:
 *
 *  · at zoom 1.0 the affordable range is ZERO, so a shot opens perfectly centred and full-frame;
 *  · the centre stays the focus point, because the offset is a fraction of a range that is itself
 *    centred on it;
 *  · the sampling window can never leave the image, whatever the duration or the zoom.
 *
 * The share is below 1 so the pan stops short of the very edge rather than grazing it.
 */
export const KEN_BURNS_MAX_PAN_SHARE = 0.6;

/**
 * The x expression for a Ken Burns move: centred, optionally drifting within the zoom's own room.
 *
 * `direction` null is a pure centre-zoom — the case every non-panning variant uses, and the one
 * the still-image paths want.
 */
export function kenBurnsCenterXExpr(
  direction: "left" | "right" | null,
  progress: string
): string {
  const centre = "iw/2-(iw/zoom/2)";
  if (!direction) return centre;
  const sign = direction === "left" ? "-" : "+";
  return `${centre}${sign}(iw-iw/zoom)/2*${KEN_BURNS_MAX_PAN_SHARE}*${progress}`;
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
  /**
   * RONDE 147 — the travel is now bounded by the zoom's own room; see kenBurnsCenterXExpr.
   *
   * The pixel distance that used to be computed here was quadratic in duration and exceeded the
   * affordable range by up to 146×, so the frame pinned itself against the edge of the picture.
   * The eased progress curve is unchanged — only how far it is allowed to carry the frame.
   */
  const progress = easeOutProgress(totalFrames);
  const xExpr = kenBurnsCenterXExpr(
    variant === "pan-left" ? "left" : variant === "pan-right" ? "right" : null,
    progress
  );
  const zExpr = `(${zoomStart.toFixed(4)}+(${zoomDelta.toFixed(7)})*${progress})`;
  return (
    `select='eq(n\\,0)',` +
    `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':` +
    `d=${totalFrames}:s=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:fps=${fps}`
  );
}

/**
 * A HELD STILL — the photograph encoded without any movement.
 *
 * A still's camera move belongs to the timeline (`cameraPlanner` → `clip.camera` → `cameraChain`),
 * which gives every still a slow move at render. A zoom baked in here as well moved the photograph
 * twice. `zoompan` at a constant zoom of 1 is kept only for what it does besides moving: it turns
 * one image into the clip's frames at the output size.
 */
export function buildStillHoldTail(duration: number): string {
  const fps = 25;
  const totalFrames = stillOutputFrameCount(duration, fps);
  return (
    `select='eq(n\\,0)',` +
    `zoompan=z=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `d=${totalFrames}:s=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:fps=${fps}`
  );
}

/** Simple still fallback when blur/polaroid filters fail on the host FFmpeg: cover-crop, held. */
export function buildSimpleStillVF(
  duration: number,
  personPortrait: boolean
): string {
  const cropY = personPortrait ? "0" : `(ih-${DOC_STYLE_VIDEO_HEIGHT})/2`;
  return (
    `[0:v]scale=${DOC_STYLE_VIDEO_WIDTH}:${DOC_STYLE_VIDEO_HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${DOC_STYLE_VIDEO_WIDTH}:${DOC_STYLE_VIDEO_HEIGHT}:(iw-${DOC_STYLE_VIDEO_WIDTH})/2:${cropY},` +
    `${buildStillHoldTail(duration)}[vout]`
  );
}

/** Blurred duplicate background + sharp foreground (reference pillarbox style). */
export function buildBlurFillStillVF(
  duration: number,
  foregroundScale = 0.78,
  yAnchor: "center" | "top" = "center",
  blurMode: "gblur" | "boxblur" = "gblur",
): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  const fgY = yAnchor === "top" ? "(H-h)/4" : "(H-h)/2";
  /** Held: the still's camera move is the timeline's (see `buildStillHoldTail`). */
  const ken = buildStillHoldTail(duration);
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

/** Single -vf chain for archive clip trim (fast encode). */
export function buildFitGrayVideoVF(): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x2a2a2a,fps=25,format=yuv420p`
  );
}

/** Photo on neutral gray mat — smaller than frame (reference-doc / City Beautiful style). */
export function buildMatFramedStillVF(
  duration: number,
  photoScale = vidrushStillPhotoScale()
): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  /** Held: the still's camera move is the timeline's (see `buildStillHoldTail`). */
  const ken = buildStillHoldTail(duration);
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
  if (process.env.ARCHIVE_BLUR_FILL_STILLS === "false") {
    return buildMatFramedStillVF(duration, scale);
  }
  return buildBlurFillStillVF(duration, scale, personPortrait ? "top" : "center", "gblur");
}

/** Boxblur variant for hosts where gblur is unavailable or fails. */
export function buildArchiveStillFilterComplexBoxBlur(
  duration: number,
  sceneIndex: number,
  beatIndex: number,
  personPortrait = false
): string {
  const scale = vidrushStillPhotoScale();
  if (process.env.ARCHIVE_BLUR_FILL_STILLS === "false") {
    return buildMatFramedStillVF(duration, scale);
  }
  return buildBlurFillStillVF(duration, scale, personPortrait ? "top" : "center", "boxblur");
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

