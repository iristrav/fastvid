/** Production sourcing policy — archive-first visuals; ElevenLabs for voice. */

import { targetVideoDurationMinutes } from "../shared/videoLengths";

/**
 * Archive-first mode: prefer admin media archive, then Wikimedia / Pexels / Pixabay fallbacks.
 * YouTube, Serp, and AI clip generation stay off unless explicitly re-enabled elsewhere.
 */
export function curatedArchiveOnlyVisuals(): boolean {
  return process.env.CURATED_ARCHIVE_ONLY !== "false";
}

/** Full external sourcing (YouTube, internet stills, Serp) — off by default; stock fallbacks still run in archive-first mode. */
export function externalVisualSourcingEnabled(): boolean {
  return process.env.ENABLE_EXTERNAL_VISUAL_SOURCING === "true";
}

/** When true, voiceover uses ElevenLabs only (no Fish Audio). */
export function elevenLabsOnlyVoice(): boolean {
  if (process.env.ELEVENLABS_ONLY === "true") return true;
  if (process.env.ELEVENLABS_ONLY === "false") return false;
  return false;
}

/** Fish Audio when ElevenLabs fails (quota, 401). On by default when FISH_AUDIO_API_KEY is set. */
export function fishAudioFallbackEnabled(): boolean {
  if (process.env.ELEVENLABS_ONLY === "true") return false;
  return Boolean(process.env.FISH_AUDIO_API_KEY?.trim());
}

/** Faceless kinetic subtitles — off by default; only year badges on screen unless ENABLE_EXTRA_ONSCREEN_TEXT=true. */
export function facelessSubtitlesEnabled(): boolean {
  if (yearsOnlyOnScreen()) return false;
  return process.env.ENABLE_FACELESS_SUBTITLES === "true";
}

/** Only year numbers as on-screen text (no kinetic subs, maps, name cards). Default on. */
export function yearsOnlyOnScreen(): boolean {
  return process.env.ENABLE_EXTRA_ONSCREEN_TEXT !== "true";
}

/** Year/stat labels bottom-left. On by default — set ENABLE_SCREEN_LABELS=false to disable. */
export function screenLabelsEnabled(): boolean {
  return process.env.ENABLE_SCREEN_LABELS !== "false";
}

/** When true (default), use Pexels stock if no archive clip matches a sentence. */
export function archivePexelsFallbackEnabled(): boolean {
  return process.env.ARCHIVE_PEXELS_FALLBACK !== "false";
}

/** Pexels/Pixabay after Wikimedia + archive misses (default on). */
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

/** Multiplier on target budget before hard-fail (default 1.2 → ~12 min pipeline per 1 min video). */
export function pipelineWallClockGraceFactor(): number {
  const raw = process.env.PIPELINE_WALL_CLOCK_GRACE?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 1.05 && n <= 1.5) return n;
  }
  return 1.2;
}

/** When true (default), cap generation at video_minutes × 10 wall-clock. Set PIPELINE_WALL_CLOCK_LIMIT=false to disable. */
export function pipelineWallClockLimitEnabled(): boolean {
  return process.env.PIPELINE_WALL_CLOCK_LIMIT !== "false";
}

/** Practical "no limit" for withTimeout / setTimeout (7 days — below Node's max delay). */
export const PIPELINE_UNLIMITED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Target end-to-end generation budget (minutes) — video_minutes × 10 by default.
 * Used for perf profiles and stage timeouts; generation may run slightly over via grace.
 */
export function maxPipelineWallClockMin(videoLength?: string | null): number {
  if (!pipelineWallClockLimitEnabled()) {
    return Math.round(PIPELINE_UNLIMITED_MS / 60_000);
  }
  const override = process.env.MAX_PIPELINE_WALL_CLOCK_MIN?.trim();
  if (override) {
    const n = parseInt(override, 10);
    if (!isNaN(n) && n >= 10 && n <= 300) return n;
  }
  return Math.round(targetVideoDurationMinutes(videoLength) * pipelineMinutesPerVideoMinute());
}

/** Hard fail only after target × grace (default 12 min pipeline per 1 min video). */
export function maxPipelineWallClockHardMin(videoLength?: string | null): number {
  if (!pipelineWallClockLimitEnabled()) {
    return Math.round(PIPELINE_UNLIMITED_MS / 60_000);
  }
  const target = maxPipelineWallClockMin(videoLength);
  return Math.min(360, Math.round(target * pipelineWallClockGraceFactor()));
}

/** Max archive/Wikimedia candidates to try per beat when wall-clock limit is on. */
export function maxVisualCandidatesPerBeatTry(): number {
  return pipelineWallClockLimitEnabled() ? 4 : 12;
}

/** Wall-clock budget for the visual sourcing stage (minutes). */
export function visualStageWallClockMin(videoLength?: string | null): number {
  if (!pipelineWallClockLimitEnabled()) {
    return Math.round(PIPELINE_UNLIMITED_MS / 60_000);
  }
  const total = maxPipelineWallClockMin(videoLength);
  return Math.max(8, Math.min(total - 6, Math.round(total * 0.88)));
}

/** Target on-screen duration per archive clip (seconds). */
export function archiveVisualBeatSec(): number {
  const raw = process.env.ARCHIVE_VISUAL_BEAT_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 5 && n <= 8) return n;
  }
  return 6;
}

/** Hard limits for archive clip length in generated videos. */
export function archiveVisualMinClipSec(): number {
  return 5;
}

export function archiveVisualMaxClipSec(): number {
  const raw = process.env.ARCHIVE_VISUAL_MAX_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 5 && n <= 8) return n;
  }
  return 8;
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

/** Archive stills: blurred fill background + sharp photo + light zoom (Locomotive Historian style). */
export function archiveBlurFillStillsEnabled(): boolean {
  return process.env.ARCHIVE_BLUR_FILL_STILLS !== "false";
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
  if (yearsOnlyOnScreen()) return false;
  return process.env.ENABLE_MOTION_GRAPHICS !== "false";
}

/** Automatic V3 text overlays — centered typewriter highlights (default on). */
export function autoMotionGraphicsLayerEnabled(): boolean {
  return process.env.ENABLE_AUTO_MOTION_GRAPHICS !== "false";
}

/**
 * Vidrush documentary quality gates — opening B-roll, pacing, non-doc filter,
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

/**
 * Visual Matching Engine V1: Wikimedia Commons as a free/public fallback source.
 * On by default (Wikimedia needs no API key). Disable via VISUAL_MATCHING_V1=false.
 */
export function visualMatchingV1Enabled(): boolean {
  return process.env.VISUAL_MATCHING_V1 !== "false";
}
