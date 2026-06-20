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

/** Faceless typewriter keywords on B-roll (% / years / €). On by default — set ENABLE_FACELESS_SUBTITLES=false to disable. */
export function facelessSubtitlesEnabled(): boolean {
  return process.env.ENABLE_FACELESS_SUBTITLES !== "false";
}

/** Extra on-screen overlays (stat pills, film grain, motion graphics cards). On by default — set ENABLE_EXTRA_ONSCREEN_TEXT=false for years-only. */
export function yearsOnlyOnScreen(): boolean {
  return process.env.ENABLE_EXTRA_ONSCREEN_TEXT === "false";
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

/** Cap licensed stock (Pexels/Pixabay) per video — archive-first default is very low. */
export function curatedMaxStockBeatsPerVideo(videoLength?: string | null): number {
  if (!archivePexelsFallbackEnabled()) return 0;
  const raw = process.env.MAX_STOCK_BEATS_PER_VIDEO?.trim();
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  const mins = targetVideoDurationMinutes(videoLength);
  if (mins <= 1) return 2;
  if (mins <= 10) return 2;
  return 3;
}

/** Max AI-generated clips per video when licensed stock cap is full (Stability/Leonardo → Ken Burns). */
export function curatedAiFallbackMaxClips(videoLength?: string | null): number {
  const raw = process.env.MAX_AI_CLIPS_PER_VIDEO?.trim();
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  const mins = targetVideoDurationMinutes(videoLength);
  if (mins <= 1) return 12;
  if (mins <= 10) return 20;
  return 28;
}

/** When true (default in archive-first mode), Pexels/Pixabay are tightly capped per video. */
export function curatedMinimizeStockFootage(): boolean {
  return process.env.MINIMIZE_STOCK_FOOTAGE !== "false";
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

/** Min beats per scene so no single shot exceeds archiveVisualMaxClipSec (default 8s). */
export function minBeatsForVisualCadence(sceneDurationSec: number): number {
  if (sceneDurationSec <= 0) return 1;
  return Math.max(1, Math.ceil(sceneDurationSec / archiveVisualMaxClipSec()));
}

/** Max beats per scene so clips stay at least archiveVisualMinClipSec (default 5s). */
export function maxBeatCapForVisualCadence(sceneDurationSec: number): number {
  if (sceneDurationSec <= 0) return 2;
  return Math.max(
    minBeatsForVisualCadence(sceneDurationSec),
    Math.ceil(sceneDurationSec / archiveVisualMinClipSec())
  );
}

/**
 * Beat cap for one scene — targets ~5–8s per visual (sentence length still splits within this band).
 * perfFloor is a profile minimum, not a ceiling.
 */
export function sceneBeatCapForCadence(sceneDurationSec: number, perfFloor = 1): number {
  const minBeats = minBeatsForVisualCadence(sceneDurationSec);
  const maxBeats = maxBeatCapForVisualCadence(sceneDurationSec);
  const target = Math.max(minBeats, Math.ceil(sceneDurationSec / archiveVisualBeatSec()));
  return Math.max(perfFloor, Math.min(maxBeats, target));
}

/** Pipeline perf floor: enough beats for the longest typical scene in this video length. */
export function curatedPerfBeatsFloor(videoLength: string): number {
  const totalSec = targetVideoDurationMinutes(videoLength) * 60;
  const scenes =
    videoLength === "1" ? 3 : videoLength === "8-10" ? 18 : videoLength === "10-15" ? 25 : 35;
  const longestTypicalSceneSec = totalSec / scenes + 4;
  return maxBeatCapForVisualCadence(longestTypicalSceneSec);
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
  return 6;
}

/** Min archive video clips before Ken Burns stills / Wikimedia photos (opening montage). */
export function archiveOpeningVideoBeatsTarget(videoLength?: string | null): number {
  const raw = process.env.ARCHIVE_OPENING_VIDEO_BEATS?.trim();
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  const mins = targetVideoDurationMinutes(videoLength);
  if (mins <= 1) return 8;
  if (mins <= 10) return 12;
  return 16;
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

/** Block upload when qualityReport fails thresholds (on by default). */
export function strictQualityExportEnabled(): boolean {
  return process.env.ENABLE_STRICT_QUALITY_EXPORT !== "false";
}

/** Minimum qualityReport.score before export (default 45). */
export function minQualityExportScore(): number {
  const raw = process.env.MIN_QUALITY_EXPORT_SCORE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0 && n <= 100) return n;
  }
  return 45;
}

/** YouTube Creative Commons clips — off unless ENABLE_YOUTUBE_SOURCING=true and keys set. */
export function youtubeSourcingEnabled(): boolean {
  return process.env.ENABLE_YOUTUBE_SOURCING === "true";
}

/** Archive clip pick driven by asset.tags + title (default on). Set ENABLE_ARCHIVE_TAG_MATCH=false for semantic-only. */
export function archiveTagsPrimaryMatching(): boolean {
  return process.env.ENABLE_ARCHIVE_TAG_MATCH !== "false";
}

/** Europeana EU heritage API — off by default; set ENABLE_EUROPEANA=true + EUROPEANA_API_KEY. */
export function europeanaSourcingEnabled(): boolean {
  return process.env.ENABLE_EUROPEANA === "true";
}

/** Run bulk geo-retag on all archive assets once at worker startup. */
export function autoArchiveGeoRetagOnStart(): boolean {
  return process.env.AUTO_ARCHIVE_GEO_RETAG_ON_START === "true";
}
