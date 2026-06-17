/** Production sourcing policy — curated media archive for visuals; ElevenLabs for voice. */

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

export function maxMotionGraphicsPerVideo(): number {
  const raw = process.env.MAX_MOTION_GRAPHICS_PER_VIDEO?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0 && n <= 20) return n;
  }
  return 5;
}
