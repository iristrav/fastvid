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

/** When true (default), skip generating_effects and mark video completed after upload. */
export function skipEffectsStage(): boolean {
  return process.env.SKIP_EFFECTS_STAGE !== "false";
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
  return 1;
}
