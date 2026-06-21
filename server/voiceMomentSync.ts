/**
 * Voice-moment sync — each montage clip covers the narration window when that sentence is spoken
 * (Vidrush / Beyond Cities style: right footage at the right moment).
 */
import { archiveVisualMaxClipSec, archiveVisualMinClipSec } from "./sourcingPolicy";

export function beatWordCount(text: string): number {
  return text.replace(/\[visual:[^\]]+\]/gi, "").split(/\s+/).filter(Boolean).length;
}

export type BeatHoldInput = { text: string; holdSec: number };

/**
 * Set each beat.holdSec from scene voice duration and word weights.
 * Accounts for crossfade overlap: sum(holds) - (n-1)*xfade ≈ voiceSec.
 */
export function syncBeatHoldSecToVoiceTimeline(
  beats: BeatHoldInput[],
  voiceSec: number,
  xfadeSec = 0.35,
  weightOverride?: number[]
): void {
  if (!beats.length || voiceSec <= 0) return;

  const minSec = archiveVisualMinClipSec();
  const maxSec = archiveVisualMaxClipSec();
  const n = beats.length;
  const weights =
    weightOverride?.length === beats.length
      ? weightOverride.map((w) => Math.max(0.25, w))
      : beats.map((b) => Math.max(1, beatWordCount(b.text)));
  const totalWords = weights.reduce((s, w) => s + w, 0) || beats.length;
  const grossBudget = voiceSec + (n > 1 ? (n - 1) * xfadeSec : 0);

  for (let i = 0; i < n; i++) {
    const share = weights[i]! / totalWords;
    beats[i]!.holdSec = Math.max(minSec, Math.min(maxSec, grossBudget * share));
  }

  let gross = beats.reduce((s, b) => s + b.holdSec, 0);
  if (gross <= 0.1 || Math.abs(gross - grossBudget) <= 0.08) return;

  const scale = grossBudget / gross;
  for (const beat of beats) {
    beat.holdSec = Math.max(minSec, Math.min(maxSec, beat.holdSec * scale));
  }
}

/** Map clip index → beat hold duration (1:1 sentence montage). */
export function beatDurationsForClipMontage(
  beats: BeatHoldInput[],
  clipBeatIndices: number[]
): number[] {
  return clipBeatIndices.map((beatIdx) => {
    const beat = beats.find((b, i) => i === beatIdx) ?? beats[beatIdx];
    return beat?.holdSec ?? archiveVisualMinClipSec();
  });
}
