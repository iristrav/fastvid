import { describe, expect, it } from "vitest";
import {
  mergeCharacterAlignments,
  normalizeTtsBeatsToSceneLocal,
  planBeatsFromTtsWords,
  sceneSplitBoundariesFromTts,
  sliceWordsForSceneText,
  wordsFromCharacterAlignment,
  joinNarrationWithBreathingPauses,
  narrationBreathingPauseEnabled,
  classifyNarrationEmotionalTone,
  elevenLabsVoiceSettingsForTone,
  narrationEmotionalVoiceEnabled,
  type TtsCharacterAlignment,
} from "./voiceTtsAlignment";

describe("narration breathing pauses (Phase 10)", () => {
  it("joins multiple scene blocks with an ellipsis pause by default", () => {
    const prev = process.env.NARRATION_BREATHING_PAUSE;
    delete process.env.NARRATION_BREATHING_PAUSE;
    expect(narrationBreathingPauseEnabled()).toBe(true);
    expect(joinNarrationWithBreathingPauses(["First scene text.", "Second scene text."])).toBe(
      "First scene text. ... Second scene text."
    );
    if (prev === undefined) delete process.env.NARRATION_BREATHING_PAUSE;
    else process.env.NARRATION_BREATHING_PAUSE = prev;
  });

  it("falls back to a plain space join when disabled via env", () => {
    const prev = process.env.NARRATION_BREATHING_PAUSE;
    process.env.NARRATION_BREATHING_PAUSE = "false";
    expect(narrationBreathingPauseEnabled()).toBe(false);
    expect(joinNarrationWithBreathingPauses(["First.", "Second."])).toBe("First. Second.");
    if (prev === undefined) delete process.env.NARRATION_BREATHING_PAUSE;
    else process.env.NARRATION_BREATHING_PAUSE = prev;
  });

  it("skips empty blocks and never pauses around a single block", () => {
    expect(joinNarrationWithBreathingPauses(["Only one."])).toBe("Only one.");
    expect(joinNarrationWithBreathingPauses(["  ", "First.", "", "Second."])).toBe("First. ... Second.");
  });
});

describe("narration emotional tone → voice settings (Phase 10)", () => {
  it("classifies dramatic narration from keyword content", () => {
    expect(classifyNarrationEmotionalTone("The cover-up led to a shocking betrayal and disaster.")).toBe(
      "dramatic"
    );
  });

  it("classifies exciting narration from keyword content", () => {
    expect(classifyNarrationEmotionalTone("It was an incredible, record-breaking triumph.")).toBe("exciting");
  });

  it("classifies plain narration as neutral", () => {
    expect(classifyNarrationEmotionalTone("The meeting was held on a Tuesday afternoon.")).toBe("neutral");
  });

  it("maps neutral tone to the exact original production constants (backwards compatible)", () => {
    expect(elevenLabsVoiceSettingsForTone("neutral")).toEqual({
      stability: 0.58,
      similarity_boost: 0.88,
      style: 0.05,
      use_speaker_boost: true,
    });
  });

  it("gives dramatic/exciting tones a lower stability than neutral (more expressive delivery)", () => {
    const neutral = elevenLabsVoiceSettingsForTone("neutral");
    const dramatic = elevenLabsVoiceSettingsForTone("dramatic");
    const exciting = elevenLabsVoiceSettingsForTone("exciting");
    expect(dramatic.stability).toBeLessThan(neutral.stability);
    expect(exciting.stability).toBeLessThan(neutral.stability);
  });

  it("is enabled by default and can be disabled via env", () => {
    const prev = process.env.NARRATION_EMOTIONAL_VOICE;
    delete process.env.NARRATION_EMOTIONAL_VOICE;
    expect(narrationEmotionalVoiceEnabled()).toBe(true);
    process.env.NARRATION_EMOTIONAL_VOICE = "false";
    expect(narrationEmotionalVoiceEnabled()).toBe(false);
    if (prev === undefined) delete process.env.NARRATION_EMOTIONAL_VOICE;
    else process.env.NARRATION_EMOTIONAL_VOICE = prev;
  });
});

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
