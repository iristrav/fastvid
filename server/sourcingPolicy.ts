/** Production sourcing policy — curated media archive for visuals; ElevenLabs for voice. */

import { targetVideoDurationMinutes } from "../shared/videoLengths";

/** Visual beats use only the admin media archive (no YouTube, stock, Serp, Wikimedia, or AI clips). */
export function curatedArchiveOnlyVisuals(): boolean {
  return true;
}

/** External clip/image/video APIs are disabled — archive library only. */
export function externalVisualSourcingEnabled(): boolean {
  return false;
}

/** When true (default), voiceover uses ElevenLabs only (no Fish Audio). */
export function elevenLabsOnlyVoice(): boolean {
  return process.env.ELEVENLABS_ONLY !== "false";
}

/** Burned-in on-screen text (labels, subs, motion graphics). Off by default — set ENABLE_ONSCREEN_TEXT=true to re-enable. */
export function onScreenTextEnabled(): boolean {
  return process.env.ENABLE_ONSCREEN_TEXT === "true";
}

/** Faceless kinetic subtitles — off by default; only year badges on screen unless ENABLE_EXTRA_ONSCREEN_TEXT=true. */
export function facelessSubtitlesEnabled(): boolean {
  if (!onScreenTextEnabled()) return false;
  if (yearsOnlyOnScreen()) return false;
  return process.env.ENABLE_FACELESS_SUBTITLES === "true";
}

/** Only year numbers as on-screen text (no kinetic subs, maps, name cards). Default on when text is enabled. */
export function yearsOnlyOnScreen(): boolean {
  if (!onScreenTextEnabled()) return true;
  return process.env.ENABLE_EXTRA_ONSCREEN_TEXT !== "true";
}

/** Year/stat labels bottom-left. On when text enabled — set ENABLE_SCREEN_LABELS=false to disable. */
export function screenLabelsEnabled(): boolean {
  if (!onScreenTextEnabled()) return false;
  return process.env.ENABLE_SCREEN_LABELS !== "false";
}

/** When true (default), use Pexels stock only after archive search finds no acceptable clip. */
export function archivePexelsFallbackEnabled(): boolean {
  return process.env.ARCHIVE_PEXELS_FALLBACK !== "false";
}

/** Pexels allowed after archive misses; never skips archive search (default on). */
export function archivePexelsHybridEnabled(): boolean {
  return process.env.ARCHIVE_PEXELS_HYBRID !== "false" && archivePexelsFallbackEnabled();
}

/** Fail generation rather than loop, pad, or reuse any clip content in a video. */
export function strictNoVisualRepeat(): boolean {
  if (process.env.STRICT_NO_VISUAL_REPEAT === "false") return false;
  return curatedArchiveOnlyVisuals();
}

/** Subtle film grain + light flash overlays in effects pass. */
export function documentaryOverlaysEnabled(): boolean {
  if (yearsOnlyOnScreen()) return false;
  return process.env.ENABLE_DOC_OVERLAYS !== "false";
}

/** Generation wall-clock minutes allowed per 1 minute of finished video (default 10:1). */
export function pipelineMinutesPerVideoMinute(): number {
  const raw = process.env.PIPELINE_MIN_PER_VIDEO_MIN?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 5 && n <= 20) return n;
  }
  return 10;
}

/**
 * Hard cap for end-to-end video generation (minutes).
 * Default: targetVideoMinutes × 10 (e.g. 8–10 min video → up to 100 min).
 */
export function maxPipelineWallClockMin(videoLength?: string | null): number {
  const override = process.env.MAX_PIPELINE_WALL_CLOCK_MIN?.trim();
  if (override) {
    const n = parseInt(override, 10);
    if (!isNaN(n) && n >= 10 && n <= 300) return n;
  }
  return Math.round(targetVideoDurationMinutes(videoLength) * pipelineMinutesPerVideoMinute());
}

/** Prefer quality over speed (more time per beat/scene). Default on for archive docs. */
export function qualityOverSpeedEnabled(): boolean {
  if (process.env.QUALITY_OVER_SPEED === "false") return false;
  return curatedArchiveOnlyVisuals() || process.env.QUALITY_OVER_SPEED === "true";
}

/** Wall-clock budget for the visual sourcing stage (minutes). */
export function visualStageWallClockMin(videoLength?: string | null): number {
  const total = maxPipelineWallClockMin(videoLength);
  return Math.max(8, Math.min(total - 6, Math.round(total * 0.88)));
}

/** Target on-screen duration per archive clip (seconds). */
export function archiveVisualBeatSec(): number {
  const raw = process.env.ARCHIVE_VISUAL_BEAT_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 2.5 && n <= 6) return n;
  }
  return 4;
}

/** Hard limits for archive clip length in generated videos. */
export function archiveVisualMinClipSec(): number {
  const raw = process.env.ARCHIVE_VISUAL_MIN_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 1.5 && n <= 5) return n;
  }
  return 3.5;
}

export function archiveVisualMaxClipSec(): number {
  const raw = process.env.ARCHIVE_VISUAL_MAX_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 3 && n <= 8) return n;
  }
  return 5.0;
}

/** Prefer moving archive video over Ken Burns stills (default on). */
export function archivePreferVideoClips(): boolean {
  return process.env.ARCHIVE_PREFER_VIDEO !== "false";
}

/** Max still-image beats per generated video when preferVideo is on. */
export function archiveMaxImageClipsPerVideo(): number {
  const raw = process.env.ARCHIVE_MAX_IMAGE_CLIPS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  return 10;
}

/** Archive stills on gray mat (smaller photo, documentary YouTube style). */
export function framedArchiveStillsEnabled(): boolean {
  return process.env.ENABLE_FRAMED_ARCHIVE_STILLS !== "false";
}

/** Archive stills: blurred fill background + sharp photo + light zoom (off by default — use gray mat for consistency). */
export function archiveBlurFillStillsEnabled(): boolean {
  return process.env.ARCHIVE_BLUR_FILL_STILLS === "true";
}

/** On-screen label cadence (years + keywords) in seconds. */
export function screenLabelIntervalSec(): number {
  const raw = process.env.SCREEN_LABEL_INTERVAL_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 15 && n <= 60) return n;
  }
  return 30;
}

/** No yellow labels before this second in the final video timeline. */
export function screenLabelMinStartSec(): number {
  const raw = process.env.SCREEN_LABEL_MIN_START_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0 && n <= 30) return n;
  }
  return 10;
}

/** Minimum gap between on-screen labels (years / place names). */
export function screenLabelMinGapSec(): number {
  const raw = process.env.SCREEN_LABEL_MIN_GAP_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 5 && n <= 20) return n;
  }
  return 9;
}

/** Max yellow labels per scene (years + places). */
export function screenLabelMaxPerScene(): number {
  const raw = process.env.SCREEN_LABEL_MAX_PER_SCENE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 3 && n <= 12) return n;
  }
  return 7;
}

/** Prefer different archive clips across consecutive videos on the same topic. */
export function archiveCrossVideoVarietyEnabled(): boolean {
  return process.env.ARCHIVE_CROSS_VIDEO_VARIETY !== "false";
}

/** How many recent same-topic videos contribute to the cross-video exclude set. */
export function archiveCrossVideoCooldownVideos(): number {
  const raw = process.env.ARCHIVE_CROSS_VIDEO_COOLDOWN?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 20) return n;
  }
  return 6;
}

/** FFmpeg-generated text cards, maps, and diagram beats (no external API). */
export function motionGraphicsInVideosEnabled(): boolean {
  if (!onScreenTextEnabled()) return false;
  if (yearsOnlyOnScreen()) return false;
  return process.env.ENABLE_MOTION_GRAPHICS !== "false";
}

/** Automatic motion graphics typewriter overlays (off by default — set ENABLE_ONSCREEN_TEXT=true). */
export function autoMotionGraphicsLayerEnabled(): boolean {
  if (!onScreenTextEnabled()) return false;
  return process.env.ENABLE_AUTO_MOTION_GRAPHICS !== "false";
}

/**
 * Vidrush documentary quality gates — opening B-roll, 3.5s pacing, non-doc filter,
 * geo consistency, motion-graphics QA. On by default for every topic/subject.
 */
export function vidrushDocumentaryQualityEnabled(): boolean {
  return process.env.ENABLE_VIDRUSH_QUALITY !== "false";
}

export function maxMotionGraphicsPerVideo(): number {
  const raw = process.env.MAX_MOTION_GRAPHICS_PER_VIDEO?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0 && n <= 20) return n;
  }
  return 5;
}
