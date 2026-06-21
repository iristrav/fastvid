import { describe, expect, it } from "vitest";
import {
  alignBeatTextsToSegments,
  applyBeatVoiceAlignments,
  validateMontageVoiceCoverage,
  voiceBeatAlignmentEnabled,
} from "./voiceBeatAlignment";
import type { WhisperSegment } from "./_core/voiceTranscription";

describe("voiceBeatAlignment", () => {
  const segments: WhisperSegment[] = [
    { id: 0, seek: 0, start: 0, end: 2.5, text: "Elon Musk arrived at the launch pad.", tokens: [], temperature: 0, avg_logprob: 0, compression_ratio: 1, no_speech_prob: 0 },
    { id: 1, seek: 0, start: 2.5, end: 5.2, text: "The rocket stood ready for test flight.", tokens: [], temperature: 0, avg_logprob: 0, compression_ratio: 1, no_speech_prob: 0 },
    { id: 2, seek: 0, start: 5.2, end: 8.0, text: "Engines ignited and the crowd cheered.", tokens: [], temperature: 0, avg_logprob: 0, compression_ratio: 1, no_speech_prob: 0 },
  ];

  it("maps beat texts onto whisper segment windows", () => {
    const alignments = alignBeatTextsToSegments(
      [
        "Elon Musk arrived at the launch pad.",
        "The rocket stood ready for test flight.",
        "Engines ignited and the crowd cheered.",
      ],
      segments,
      8
    );
    expect(alignments).toHaveLength(3);
    expect(alignments[0]!.startSec).toBeCloseTo(0, 1);
    expect(alignments[2]!.endSec).toBeCloseTo(8, 1);
    expect(alignments[1]!.durationSec).toBeGreaterThan(0.5);
  });

  it("applyBeatVoiceAlignments rescales holds to voice duration", () => {
    const beats = [
      { text: "Short beat.", holdSec: 3 },
      { text: "A longer beat with more spoken words in the narration.", holdSec: 3 },
    ];
    applyBeatVoiceAlignments(
      beats,
      [
        { beatIndex: 0, startSec: 0, endSec: 2, durationSec: 2 },
        { beatIndex: 1, startSec: 2, endSec: 10, durationSec: 8 },
      ],
      10,
      0.35
    );
    expect(beats[1]!.holdSec).toBeGreaterThan(beats[0]!.holdSec);
    const gross = beats[0]!.holdSec + beats[1]!.holdSec - 0.35;
    expect(gross).toBeGreaterThan(9);
    expect(gross).toBeLessThan(11);
  });

  it("validateMontageVoiceCoverage flags large drift", () => {
    const bad = validateMontageVoiceCoverage([2, 2, 2], 12, 0.35);
    expect(bad.ok).toBe(false);
    const ok = validateMontageVoiceCoverage([4, 4, 4.5], 12, 0.35);
    expect(ok.ok).toBe(true);
  });

  it("voiceBeatAlignmentEnabled respects env kill switch", () => {
    const prev = process.env.ENABLE_VOICE_BEAT_ALIGNMENT;
    process.env.ENABLE_VOICE_BEAT_ALIGNMENT = "false";
    expect(voiceBeatAlignmentEnabled()).toBe(false);
    process.env.ENABLE_VOICE_BEAT_ALIGNMENT = prev;
  });
});
