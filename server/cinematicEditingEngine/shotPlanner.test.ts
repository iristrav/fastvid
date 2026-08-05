import { describe, expect, it } from "vitest";
import { planShot } from "./shotPlanner";
import type { CandidateAsset, VisualIntent } from "../visualMatchingV2/types";

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
    brands: ["Vision Pro"],
    companies: ["Apple"],
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

describe("Shot Planner (Phase 4)", () => {
  it("chooses archive_footage for historical beats retrieved from an archival source", () => {
    const shot = planShot(
      makeIntent({ historicalContext: "World War II, 1943" }),
      makeCandidate({ source: "internet_archive" })
    );
    expect(shot.shotType).toBe("archive_footage");
    expect(shot.reason).toContain("historical");
  });

  it("chooses reaction for audience/crowd reaction footage", () => {
    const shot = planShot(makeIntent(), makeCandidate({ searchQuery: "audience reaction applause" }));
    expect(shot.shotType).toBe("reaction");
  });

  it("chooses b_roll for footage retrieved via the generic entity fallback tier", () => {
    const shot = planShot(makeIntent(), makeCandidate({ searchQuery: "office workspace" }));
    expect(shot.shotType).toBe("b_roll");
  });

  it("chooses detail for a named object with a hands-on action", () => {
    const shot = planShot(
      makeIntent({ objects: ["headset"], visualAction: "unveil the product" }),
      makeCandidate({ searchQuery: "close-up product reveal" })
    );
    expect(shot.shotType).toBe("detail");
  });

  it("chooses close_up for a named person speaking", () => {
    const shot = planShot(
      makeIntent({ people: ["Tim Cook"], visualAction: "speaking on stage" }),
      makeCandidate()
    );
    expect(shot.shotType).toBe("close_up");
  });

  it("chooses close_up for a portrait-oriented still image even with no action match", () => {
    const shot = planShot(makeIntent(), makeCandidate({ assetType: "image", width: 800, height: 1200 }));
    expect(shot.shotType).toBe("close_up");
  });

  it("chooses establishing the first time a location appears, then wide on repeat", () => {
    const intent = makeIntent({ visualLocation: "Apple Park" });
    const first = planShot(intent, makeCandidate());
    expect(first.shotType).toBe("establishing");

    const second = planShot(intent, makeCandidate(), {
      recentShotTypes: ["establishing"],
      recentTransitions: [],
      establishedSubjects: ["Apple Park"],
    });
    expect(second.shotType).toBe("wide");
  });

  it("falls back to medium when no stronger signal is present", () => {
    const shot = planShot(makeIntent(), makeCandidate());
    expect(shot.shotType).toBe("medium");
  });

  it("every decision carries a non-empty reason (NO RANDOMNESS requirement)", () => {
    const shot = planShot(makeIntent(), makeCandidate());
    expect(shot.reason.length).toBeGreaterThan(0);
  });
});
