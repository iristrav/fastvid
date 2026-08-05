import { describe, expect, it } from "vitest";
import { planSubBeatCuts } from "./timingAlignment";
import type { TtsWordTiming } from "../voiceTtsAlignment";

function word(w: string, startSec: number, endSec: number): TtsWordTiming {
  return { word: w, startSec, endSec };
}

describe("Sub-beat word-timing alignment (Phase 3)", () => {
  it("returns one cut spanning the whole beat when numCuts is 1", () => {
    const cuts = planSubBeatCuts("Elon Musk announced Grok 5", 1, 10, 4);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ startSec: 10, endSec: 14, source: "proportional_estimate" });
  });

  it("uses real TTS word timestamps to place each cut exactly when available", () => {
    const words: TtsWordTiming[] = [
      word("Elon", 10.0, 10.3),
      word("Musk", 10.3, 10.6),
      word("announced", 10.6, 11.1),
      word("Grok", 11.1, 11.4),
      word("5", 11.4, 11.6),
      word("today", 11.6, 12.0),
    ];
    const cuts = planSubBeatCuts("Elon Musk announced Grok 5 today", 3, 10.0, 2.0, words);

    expect(cuts).toHaveLength(3);
    for (const cut of cuts) expect(cut.source).toBe("tts_word_alignment");
    // Cuts must be in chronological order and cover the beat's real word timing exactly,
    // not an evenly-guessed split — the whole point of using word timestamps.
    expect(cuts[0]!.startSec).toBe(10.0);
    expect(cuts[cuts.length - 1]!.endSec).toBe(12.0);
    for (let i = 1; i < cuts.length; i++) {
      expect(cuts[i]!.startSec).toBeGreaterThanOrEqual(cuts[i - 1]!.startSec);
    }
  });

  it("falls back to proportional estimation when no word timestamps are available", () => {
    const cuts = planSubBeatCuts("one two three four", 2, 0, 4);
    expect(cuts).toHaveLength(2);
    for (const cut of cuts) expect(cut.source).toBe("proportional_estimate");
    expect(cuts[0]!.startSec).toBe(0);
    expect(cuts[0]!.endSec).toBe(2);
    expect(cuts[1]!.startSec).toBe(2);
    expect(cuts[1]!.endSec).toBe(4);
  });

  it("falls back to proportional estimation when there are fewer real words than requested cuts", () => {
    const words: TtsWordTiming[] = [word("hi", 0, 0.5)];
    const cuts = planSubBeatCuts("hi", 3, 0, 3, words);
    expect(cuts).toHaveLength(3);
    for (const cut of cuts) expect(cut.source).toBe("proportional_estimate");
  });
});
