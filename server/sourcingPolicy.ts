/** Production sourcing policy — curated archive visuals + ElevenLabs voice only. */

/** When true (default), beats use only admin media archive assets (no Serp/Pexels/AI). */
export function curatedArchiveOnlyVisuals(): boolean {
  return process.env.CURATED_ARCHIVE_ONLY !== "false";
}

/** When true (default), voiceover uses ElevenLabs only (no Fish Audio). */
export function elevenLabsOnlyVoice(): boolean {
  return process.env.ELEVENLABS_ONLY !== "false";
}

/** When true (default), skip generating_effects and mark video completed after upload. */
export function skipEffectsStage(): boolean {
  return process.env.SKIP_EFFECTS_STAGE !== "false";
}
