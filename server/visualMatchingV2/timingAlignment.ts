/** Visual Matching Engine V2 — Sub-beat word-timing alignment (Phase 3, Visual Intelligence
 *  Engine).
 *
 *  Existing TTS alignment (server/voiceTtsAlignment.ts) already places BEAT boundaries at
 *  exact word timestamps (planBeatsFromTtsWords / sceneSplitBoundariesFromTts /
 *  buildTtsSceneBeatMap) using real per-word timing (TtsWordTiming[]) captured from
 *  ElevenLabs. What's missing is placing a VISUAL CUT exactly when the words it corresponds
 *  to are spoken, for beats that need more than one shot (e.g. a 3-shot montage inside one
 *  beat's narration) — today that's only ever estimated proportionally by word count
 *  (syncBeatHoldSecToVoiceTimeline, videoPipeline.ts), never timestamp-driven.
 *
 *  This module adds exactly that missing piece, and nothing else: given a beat's already-
 *  resolved word timings (from the existing alignment machinery) and how many visual cuts the
 *  beat needs, return exact cut boundaries. When real word timestamps aren't available for a
 *  beat, falls back to the existing proportional-by-word-count estimate — literally "use word
 *  timestamps if available, otherwise estimate," per the Phase 3 requirement.
 */
import type { TtsWordTiming } from "../voiceTtsAlignment";

export type SubBeatCutSource = "tts_word_alignment" | "proportional_estimate";

export type SubBeatCut = {
  /** 0-based position of this cut within the beat. */
  cutIndex: number;
  /** The portion of the beat's narration text this cut corresponds to. */
  text: string;
  startSec: number;
  endSec: number;
  source: SubBeatCutSource;
};

function splitIntoGroups<T>(items: T[], numGroups: number): T[][] {
  const groups: T[][] = [];
  const perGroup = items.length / numGroups;
  for (let i = 0; i < numGroups; i++) {
    const start = Math.round(i * perGroup);
    const end = i === numGroups - 1 ? items.length : Math.round((i + 1) * perGroup);
    groups.push(items.slice(start, Math.max(start + 1, end)));
  }
  return groups;
}

/**
 * Splits one beat's narration into `numCuts` visual cuts, timed to the exact words being
 * spoken when real word-level TTS timing is available (`beatWords`), or distributed evenly by
 * word count across the beat's known voice duration otherwise.
 */
export function planSubBeatCuts(
  beatText: string,
  numCuts: number,
  beatVoiceStartSec: number,
  beatVoiceDurationSec: number,
  beatWords?: TtsWordTiming[]
): SubBeatCut[] {
  const cuts = Math.max(1, Math.floor(numCuts));

  if (cuts === 1) {
    return [
      {
        cutIndex: 0,
        text: beatText,
        startSec: beatVoiceStartSec,
        endSec: beatVoiceStartSec + beatVoiceDurationSec,
        source: beatWords && beatWords.length > 0 ? "tts_word_alignment" : "proportional_estimate",
      },
    ];
  }

  if (beatWords && beatWords.length >= cuts) {
    // Real word timestamps available and there are enough words to give each cut at least
    // one — split into contiguous word groups (roughly equal share of narration each) and
    // read each group's exact start/end second straight off the TTS alignment.
    return splitIntoGroups(beatWords, cuts).map((group, i) => ({
      cutIndex: i,
      text: group.map((w) => w.word).join(" "),
      startSec: group[0]!.startSec,
      endSec: group[group.length - 1]!.endSec,
      source: "tts_word_alignment" as const,
    }));
  }

  // Fallback: no (or insufficient) word-level timing for this beat — same proportional-by-
  // word-count estimate the legacy pipeline already uses elsewhere.
  const perCutSec = beatVoiceDurationSec / cuts;
  const words = beatText.split(/\s+/).filter(Boolean);
  const wordsPerCut = Math.max(1, Math.ceil(words.length / cuts));
  return Array.from({ length: cuts }, (_, i) => ({
    cutIndex: i,
    text: words.slice(i * wordsPerCut, (i + 1) * wordsPerCut).join(" "),
    startSec: beatVoiceStartSec + i * perCutSec,
    endSec: beatVoiceStartSec + (i + 1) * perCutSec,
    source: "proportional_estimate" as const,
  }));
}
