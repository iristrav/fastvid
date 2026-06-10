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
