import { describe, expect, it } from "vitest";
import {
  expectedMontageCutStarts,
  selectCheckClipIndices,
  summarizeVoiceMontageSyncAudits,
} from "./voiceMontageSyncAudit";

describe("voiceMontageSyncAudit", () => {
  it("expectedMontageCutStarts matches TTS beat starts", () => {
    const beats = [
      { text: "A", holdSec: 2, voiceStartSec: 0, voiceEndSec: 2 },
      { text: "B", holdSec: 3, voiceStartSec: 2, voiceEndSec: 5 },
    ];
    const starts = expectedMontageCutStarts(beats, 5, [0, 1]);
    expect(starts[0]).toBeCloseTo(0, 2);
    expect(starts[1]).toBeCloseTo(2, 2);
  });

  it("selectCheckClipIndices prefers weakest adopt vision scores", () => {
    const clipBeatIndices = [0, 0, 1, 1, 2, 2, 3, 3];
    const adoptVision = new Map<number, number>([
      [0, 9],
      [1, 5],
      [2, 7],
      [3, 8],
    ]);
    const picks = selectCheckClipIndices(8, clipBeatIndices, adoptVision);
    expect(picks.length).toBe(6);
    expect(picks.some((ci) => clipBeatIndices[ci] === 1)).toBe(true);
  });

  it("summarizeVoiceMontageSyncAudits collects failed scenes", () => {
    const summary = summarizeVoiceMontageSyncAudits([
      { sceneIndex: 0, audit: { ok: true, blocking: false, warnings: [], checks: [] } },
      {
        sceneIndex: 1,
        audit: { ok: false, blocking: false, warnings: ["clip 0 beat 0: cut drift 0.50s"], checks: [] },
      },
    ]);
    expect(summary.ok).toBe(false);
    expect(summary.failedScenes).toEqual([1]);
    expect(summary.warnings.length).toBe(1);
  });
});
