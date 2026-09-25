/**
 * RONDE 656 — TEXT THAT TYPES, AT ONE FIXED PACE, SO THE SOUND CAN FOLLOW IT.
 *
 * `type_on` spreads its reveal over 80% of the element's life, so its pace depends on how long the
 * element stays up — a sound laid under it could never land on the letters. A typewriter types at
 * one speed. These functions are the single definition of that speed: the renderer draws with them
 * and the planner places the key clicks with them, so picture and sound cannot drift apart.
 *
 * Pure. No React, no Remotion, so the server imports the same numbers.
 */

/** Seconds per character. A brisk typewriter, not a teletype. */
export const TYPE_CHAR_SEC = 0.075;
/** The element appears, then a beat, then the first key. */
export const TYPE_DELAY_SEC = 0.2;

/** Characters that take a keystroke. A space is a keystroke on a typewriter too. */
export function typedLength(text: string): number {
  return [...text].length;
}

/** How many characters are on screen `elapsedSec` after the element appeared. */
export function typedCount(text: string, elapsedSec: number): number {
  const n = typedLength(text);
  if (elapsedSec <= TYPE_DELAY_SEC) return 0;
  return Math.min(n, Math.floor((elapsedSec - TYPE_DELAY_SEC) / TYPE_CHAR_SEC) + 1);
}

/** When, after the element appeared, the last character lands. */
export function typingDurationSec(text: string): number {
  return TYPE_DELAY_SEC + typedLength(text) * TYPE_CHAR_SEC;
}

/** The moments (after the element appeared) at which a visible character lands. Spaces are silent. */
export function keystrokeTimesSec(text: string): number[] {
  return [...text]
    .map((ch, i) => ({ ch, at: TYPE_DELAY_SEC + i * TYPE_CHAR_SEC }))
    .filter((k) => k.ch.trim() !== "")
    .map((k) => Number(k.at.toFixed(3)));
}
