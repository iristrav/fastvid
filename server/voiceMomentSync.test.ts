import { describe, expect, it } from "vitest";
import { beatWordCount, syncBeatHoldSecToVoiceTimeline } from "./voiceMomentSync";

describe("voiceMomentSync", () => {
  it("weights holdSec by word count", () => {
    const beats = [
      { text: "Korte zin.", holdSec: 0 },
      { text: "Een veel langere zin met extra woorden voor timing en sync.", holdSec: 0 },
    ];
    syncBeatHoldSecToVoiceTimeline(beats, 12, 0.35);
    expect(beats[1]!.holdSec).toBeGreaterThan(beats[0]!.holdSec);
    const gross = beats[0]!.holdSec + beats[1]!.holdSec - 0.35;
    expect(gross).toBeGreaterThan(11);
    expect(gross).toBeLessThan(13);
  });

  it("counts words in narration", () => {
    expect(beatWordCount("In 2024 groeide de vraag.")).toBe(5);
    expect(beatWordCount("[visual: map]")).toBe(0);
  });
});
