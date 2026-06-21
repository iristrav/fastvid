import { describe, expect, it } from "vitest";
import {
  mergeCharacterAlignments,
  normalizeTtsBeatsToSceneLocal,
  planBeatsFromTtsWords,
  sceneSplitBoundariesFromTts,
  sliceWordsForSceneText,
  wordsFromCharacterAlignment,
  type TtsCharacterAlignment,
} from "./voiceTtsAlignment";

describe("voiceTtsAlignment", () => {
  const alignment: TtsCharacterAlignment = {
    characters: "Hello world".split(""),
    character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2],
  };

  it("wordsFromCharacterAlignment groups tokens", () => {
    const words = wordsFromCharacterAlignment(alignment);
    expect(words.map((w) => w.word)).toEqual(["Hello", "world"]);
    expect(words[0]!.startSec).toBeCloseTo(0, 1);
  });

  it("mergeCharacterAlignments offsets times", () => {
    const merged = mergeCharacterAlignments([
      { offsetSec: 0, alignment },
      { offsetSec: 2, alignment },
    ]);
    expect(merged.characters.length).toBe(alignment.characters.length * 2);
    expect(merged.character_start_times_seconds[alignment.characters.length]).toBeCloseTo(2, 1);
  });

  it("planBeatsFromTtsWords respects min duration", () => {
    const words = [
      { word: "One", startSec: 0, endSec: 0.4 },
      { word: "two", startSec: 0.4, endSec: 0.8 },
      { word: "three.", startSec: 0.8, endSec: 6.5 },
    ];
    const beats = planBeatsFromTtsWords(words, { minSec: 5, maxSec: 8 });
    expect(beats.length).toBeGreaterThan(0);
    expect(beats[0]!.holdSec).toBeGreaterThanOrEqual(5);
  });

  it("sliceWordsForSceneText matches scene tokens in order", () => {
    const all = [
      { word: "Elon", startSec: 0, endSec: 0.3 },
      { word: "Musk", startSec: 0.3, endSec: 0.6 },
      { word: "launched", startSec: 0.6, endSec: 1.0 },
    ];
    const cursor = { index: 0 };
    const { words } = sliceWordsForSceneText(all, "Elon Musk launched", cursor);
    expect(words).toHaveLength(3);
    expect(cursor.index).toBe(3);
  });

  it("sceneSplitBoundariesFromTts returns per-scene word windows", () => {
    const stored = {
      words: [
        { word: "Scene", startSec: 0, endSec: 0.4 },
        { word: "one.", startSec: 0.4, endSec: 1.0 },
        { word: "Scene", startSec: 5.0, endSec: 5.4 },
        { word: "two.", startSec: 5.4, endSec: 6.0 },
      ],
      totalDurationSec: 6.2,
      updatedAt: "",
    };
    const bounds = sceneSplitBoundariesFromTts(
      [{ text: "Scene one." }, { text: "Scene two." }],
      stored
    );
    expect(bounds).toEqual([
      { startSec: 0, endSec: 1.0 },
      { startSec: 5.0, endSec: 6.2 },
    ]);
  });

  it("normalizeTtsBeatsToSceneLocal shifts voice windows", () => {
    const beats = planBeatsFromTtsWords([
      { word: "Hello", startSec: 5, endSec: 5.5 },
      { word: "world.", startSec: 5.5, endSec: 6.2 },
    ]);
    const local = normalizeTtsBeatsToSceneLocal(beats, 5);
    expect(local[0]!.voiceStartSec).toBeCloseTo(0, 2);
    expect(local[0]!.voiceEndSec).toBeCloseTo(1.2, 1);
  });
});
