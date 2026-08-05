import { describe, expect, it } from "vitest";
import { generateEDL } from "./edlGenerator";
import type { CinematicEditingInput } from "./types";
import type { VisualIntent, CandidateAsset } from "../visualMatchingV2/types";
import type { Scene } from "../pipeline/types";

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return { index: 0, text: "text", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 10, ...overrides };
}

function makeIntent(overrides: Partial<VisualIntent> = {}): VisualIntent {
  return {
    beatId: "b0",
    spokenText: "Apple introduced the Vision Pro.",
    visualSubject: "Apple",
    visualAction: "",
    visualLocation: "",
    visualTime: "present day",
    historicalContext: "",
    emotion: "",
    visualDescription: "",
    primaryKeyword: "Apple Vision Pro",
    secondaryKeyword: "",
    negativeKeywords: [],
    secondaryVisualSubjects: [],
    objects: [],
    brands: [],
    companies: [],
    people: [],
    countries: [],
    events: [],
    intentHash: "hash",
    cacheHit: false,
    ...overrides,
  };
}

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

function makeInput(overrides: Partial<CinematicEditingInput> = {}): CinematicEditingInput {
  return {
    scene: makeScene(),
    intent: makeIntent(),
    bestCandidate: makeCandidate(),
    beatVoiceStartSec: 0,
    beatVoiceDurationSec: 4,
    ...overrides,
  };
}

describe("EDL Generator (Phase 4) — full pipeline, no rendering", () => {
  it("produces one EditDecision per beat, in order", () => {
    const edl = generateEDL([
      makeInput({ intent: makeIntent({ beatId: "b0" }), beatVoiceStartSec: 0, beatVoiceDurationSec: 4 }),
      makeInput({ intent: makeIntent({ beatId: "b1" }), beatVoiceStartSec: 4, beatVoiceDurationSec: 4 }),
    ]);
    expect(edl.decisions).toHaveLength(2);
    expect(edl.decisions.map((d) => d.beatId)).toEqual(["b0", "b1"]);
  });

  it("every decision includes every planner's output — shot, camera, transition, clip, pacing all present", () => {
    const edl = generateEDL([makeInput()]);
    const [decision] = edl.decisions;
    expect(decision!.shot.shotType).toBeDefined();
    expect(decision!.camera.movement).toBeDefined();
    expect(decision!.transitionIn.type).toBeDefined();
    expect(decision!.clip.candidateId).toBe("c1");
    expect(decision!.pacing.tone).toBeDefined();
    expect(Array.isArray(decision!.captions)).toBe(true);
    expect(Array.isArray(decision!.motionGraphics)).toBe(true);
    expect(Array.isArray(decision!.effects)).toBe(true);
    expect(Array.isArray(decision!.sounds)).toBe(true);
  });

  it("the first decision in a scene always gets a real, reasoned cut transition (never null)", () => {
    const edl = generateEDL([makeInput()]);
    expect(edl.decisions[0]!.transitionIn.type).toBe("cut");
    expect(edl.decisions[0]!.transitionIn.reason.length).toBeGreaterThan(0);
  });

  it("threads continuity between beats — a person named in beat 1 isn't re-captioned by name in beat 2", () => {
    const edl = generateEDL([
      makeInput({ intent: makeIntent({ beatId: "b0", people: ["Tim Cook"], visualAction: "speaking on stage" }) }),
      makeInput({
        intent: makeIntent({ beatId: "b1", people: ["Tim Cook"], visualAction: "speaking on stage" }),
        beatVoiceStartSec: 4,
      }),
    ]);
    const firstHasName = edl.decisions[0]!.captions.some((c) => c.captionType === "name");
    const secondHasName = edl.decisions[1]!.captions.some((c) => c.captionType === "name");
    expect(firstHasName).toBe(true);
    expect(secondHasName).toBe(false);
  });

  it("threads continuity between beats — a location established in beat 1 gets a wide, not establishing, shot in beat 2", () => {
    const edl = generateEDL([
      makeInput({ intent: makeIntent({ beatId: "b0", visualLocation: "Apple Park" }) }),
      makeInput({ intent: makeIntent({ beatId: "b1", visualLocation: "Apple Park" }), beatVoiceStartSec: 4 }),
    ]);
    expect(edl.decisions[0]!.shot.shotType).toBe("establishing");
    expect(edl.decisions[1]!.shot.shotType).toBe("wide");
  });

  it("computes totalDurationSec from the last clip's end time", () => {
    const edl = generateEDL([
      makeInput({ beatVoiceStartSec: 0, beatVoiceDurationSec: 4 }),
      makeInput({ beatVoiceStartSec: 4, beatVoiceDurationSec: 6 }),
    ]);
    expect(edl.totalDurationSec).toBe(10);
  });

  it("carries the scene's index onto the EDL", () => {
    const edl = generateEDL([makeInput({ scene: makeScene({ index: 3 }) })]);
    expect(edl.sceneIndex).toBe(3);
  });

  it("returns an empty EDL for an empty beat list", () => {
    const edl = generateEDL([]);
    expect(edl.decisions).toEqual([]);
    expect(edl.totalDurationSec).toBe(0);
  });

  it("every planner decision in the EDL carries a non-empty reason (NO RANDOMNESS requirement, end to end)", () => {
    const edl = generateEDL([
      makeInput({ intent: makeIntent({ historicalContext: "WWII", people: ["Eisenhower"], visualLocation: "Normandy" }) }),
    ]);
    const [decision] = edl.decisions;
    expect(decision!.shot.reason.length).toBeGreaterThan(0);
    expect(decision!.camera.reason.length).toBeGreaterThan(0);
    expect(decision!.transitionIn.reason.length).toBeGreaterThan(0);
    expect(decision!.pacing.reason.length).toBeGreaterThan(0);
    for (const c of decision!.captions) expect(c.reason.length).toBeGreaterThan(0);
    for (const e of decision!.effects) expect(e.reason.length).toBeGreaterThan(0);
  });
});
