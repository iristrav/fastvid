import { describe, expect, it } from "vitest";
import { planClipTiming } from "./timelinePlanner";
import type { CandidateAsset } from "../visualMatchingV2/types";
import type { TtsWordTiming } from "../voiceTtsAlignment";

function makeCandidate(overrides: Partial<CandidateAsset> = {}): CandidateAsset {
  return {
    candidateId: "c1",
    source: "pexels",
    assetType: "video",
    title: null,
    description: null,
    tags: [],
    thumbnail: null,
    localPath: "/tmp/clip.mp4",
    remoteUrl: null,
    metadata: null,
    searchQuery: "",
    retrievalMethod: "search",
    fetchedAt: new Date().toISOString(),
    language: null,
    license: null,
    attribution: null,
    width: 1920,
    height: 1080,
    duration: 10,
    mimeType: null,
    originalSource: null,
    downloadTimeMs: null,
    embeddingSimilarity: null,
    keywordScore: null,
    retrievalReasons: [],
    retrievalSources: [],
    clipSimilarity: null,
    clipModel: null,
    clipEmbeddingVersion: null,
    clipLatencyMs: null,
    editorialScore: null,
    motionLevel: null,
    rankingScore: null,
    rankingBreakdown: null,
    ...overrides,
  };
}

describe("Timeline Planner (Phase 4)", () => {
  it("returns an empty array when there are no candidates", () => {
    expect(planClipTiming("some text", [], 0, 4)).toEqual([]);
  });

  it("plans one clip instruction spanning the whole beat for a single candidate", () => {
    const [clip] = planClipTiming("some text", [makeCandidate({ candidateId: "a" })], 2, 4);
    expect(clip!.candidateId).toBe("a");
    expect(clip!.startSec).toBe(2);
    expect(clip!.endSec).toBe(6);
    expect(clip!.trimEndSec).toBeCloseTo(4, 5);
  });

  it("caps trimEndSec at the candidate's own duration when the clip needs more than the asset has", () => {
    const [clip] = planClipTiming("some text", [makeCandidate({ duration: 2 })], 0, 8);
    expect(clip!.trimEndSec).toBe(2);
  });

  it("splits a beat across multiple candidates into contiguous, non-overlapping clips", () => {
    const clips = planClipTiming("one two three four", [makeCandidate({ candidateId: "a" }), makeCandidate({ candidateId: "b" })], 0, 6);
    expect(clips).toHaveLength(2);
    expect(clips[0]!.startSec).toBe(0);
    expect(clips[1]!.startSec).toBe(clips[0]!.endSec);
    expect(clips[1]!.endSec).toBe(6);
  });

  it("uses real word timestamps for cut boundaries when available", () => {
    const words: TtsWordTiming[] = [
      { word: "one", startSec: 0, endSec: 0.5 },
      { word: "two", startSec: 0.5, endSec: 1.1 },
      { word: "three", startSec: 1.1, endSec: 1.8 },
      { word: "four", startSec: 1.8, endSec: 2.5 },
    ];
    const clips = planClipTiming(
      "one two three four",
      [makeCandidate({ candidateId: "a" }), makeCandidate({ candidateId: "b" })],
      0,
      2.5,
      words
    );
    expect(clips[0]!.timingSource).toBe("tts_word_alignment");
    expect(clips[1]!.timingSource).toBe("tts_word_alignment");
  });

  it("does not trim images to a candidate duration (stills have no inherent duration)", () => {
    const [clip] = planClipTiming("some text", [makeCandidate({ assetType: "image", duration: null })], 0, 5);
    expect(clip!.trimEndSec).toBeCloseTo(5, 5);
  });
});
