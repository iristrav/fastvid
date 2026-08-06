import { describe, expect, it } from "vitest";
import { toDirectorGuidance } from "./integration";
import { planDirectorDecision } from "./directorPlanner";
import { generateEDL } from "../cinematicEditingEngine/edlGenerator";
import type { DirectorContext } from "./types";
import type { CinematicEditingInput } from "../cinematicEditingEngine/types";
import type { CandidateAsset, VisualIntent } from "../visualMatchingV2/types";
import type { Scene } from "../pipeline/types";

function makeIntent(overrides: Partial<VisualIntent> = {}): VisualIntent {
  return {
    beatId: "b0",
    spokenText: "The team continued its work quietly.",
    visualSubject: "the team",
    visualAction: "",
    visualLocation: "",
    visualTime: "present day",
    historicalContext: "",
    emotion: "",
    visualDescription: "",
    primaryKeyword: "",
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

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return { index: 3, text: "text", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 10, ...overrides };
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
    duration: 8,
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

function makeDirectorContext(overrides: Partial<DirectorContext> = {}): DirectorContext {
  return {
    scene: makeScene(),
    beatIntents: [makeIntent()],
    sceneIndex: 3,
    totalScenes: 8,
    sceneStartSec: 60,
    sceneDurationSec: 10,
    totalVideoDurationSec: 160,
    previousDecisions: [],
    ...overrides,
  };
}

describe("toDirectorGuidance", () => {
  it("maps the Director's emotion onto Cinematic Editing Engine's pacing tone", () => {
    const decision = planDirectorDecision(makeDirectorContext({ beatIntents: [makeIntent({ spokenText: "A historic victory." })] }));
    const guidance = toDirectorGuidance(decision);
    expect(["dramatic", "exciting", "educational", "neutral"]).toContain(guidance.pacingTone);
  });

  it("carries the shot order over 1:1, order and shotType preserved", () => {
    const decision = planDirectorDecision(makeDirectorContext());
    const guidance = toDirectorGuidance(decision);
    expect(guidance.shotOrder).toHaveLength(decision.shotOrder.length);
    expect(guidance.shotOrder![0]).toEqual({ order: decision.shotOrder[0]!.order, shotType: decision.shotOrder[0]!.shotType });
  });
});

describe("End-to-end: AI Director guidance flowing into Cinematic Editing Engine's EDL", () => {
  it("a beat with no local shot signal falls back to the Director's shot-order suggestion when guidance is supplied", () => {
    const decision = planDirectorDecision(makeDirectorContext());
    const guidance = toDirectorGuidance(decision);

    const input: CinematicEditingInput = {
      scene: makeScene(),
      intent: makeIntent(), // deliberately no historical/person/object/location signal
      bestCandidate: makeCandidate(), // deliberately generic, no search-text signal
      beatVoiceStartSec: 0,
      beatVoiceDurationSec: 4,
      beatIndexInScene: 0,
      directorGuidance: guidance,
    };

    const edl = generateEDL([input]);
    const shotType = edl.decisions[0]!.shot.shotType;
    expect(shotType).toBe(decision.shotOrder[0]!.shotType);
    expect(edl.decisions[0]!.shot.reason).toContain("AI Director");
  });

  it("the same beat falls back to plain medium when no directorGuidance is supplied — unchanged, backward-compatible behavior", () => {
    const input: CinematicEditingInput = {
      scene: makeScene(),
      intent: makeIntent(),
      bestCandidate: makeCandidate(),
      beatVoiceStartSec: 0,
      beatVoiceDurationSec: 4,
    };

    const edl = generateEDL([input]);
    expect(edl.decisions[0]!.shot.shotType).toBe("medium");
    expect(edl.decisions[0]!.shot.reason).not.toContain("AI Director");
  });
});
