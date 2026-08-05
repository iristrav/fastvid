import { describe, expect, it } from "vitest";
import { isOffTopicForVideoContext } from "./continuity";
import type { CandidateAsset, VisualIntent } from "./types";

const baseIntent: VisualIntent = {
  beatId: "b0",
  spokenText: "Apple unveiled the new iPhone",
  visualSubject: "Apple",
  visualAction: "unveiling a product",
  visualLocation: "Cupertino",
  visualTime: "present day",
  historicalContext: "",
  emotion: "excited",
  visualDescription: "Apple product launch",
  primaryKeyword: "Apple event",
  secondaryKeyword: "Apple keynote",
  negativeKeywords: [],
  secondaryVisualSubjects: [],
  objects: [],
  brands: ["iPhone"],
  companies: ["Apple"],
  people: [],
  countries: [],
  events: [],
  intentHash: "hash",
  cacheHit: false,
};

function makeCandidate(overrides: Partial<CandidateAsset> = {}): CandidateAsset {
  return {
    candidateId: "c1",
    source: "pexels",
    assetType: "video",
    title: null,
    description: null,
    tags: [],
    thumbnail: null,
    localPath: null,
    remoteUrl: null,
    metadata: null,
    searchQuery: "",
    retrievalMethod: "search",
    fetchedAt: new Date().toISOString(),
    language: null,
    license: null,
    attribution: null,
    width: null,
    height: null,
    duration: null,
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

describe("Visual continuity (Phase 3) — brand/company/era generalization", () => {
  it("flags a candidate that reads as a different, unrelated brand (Apple beat, Microsoft candidate)", () => {
    const candidate = makeCandidate({ title: "Microsoft Surface launch event" });
    expect(isOffTopicForVideoContext(candidate, baseIntent)).toBe(true);
  });

  it("does not flag a candidate that matches the beat's own established brand", () => {
    const candidate = makeCandidate({ title: "Apple event Cupertino stage" });
    expect(isOffTopicForVideoContext(candidate, baseIntent)).toBe(false);
  });

  it("does not flag a candidate with no brand signal at all (generic footage)", () => {
    const candidate = makeCandidate({ title: "conference stage with audience" });
    expect(isOffTopicForVideoContext(candidate, baseIntent)).toBe(false);
  });

  it("flags modern-looking footage for a beat with historical/WWII context", () => {
    const historicalIntent: VisualIntent = {
      ...baseIntent,
      brands: [],
      companies: [],
      historicalContext: "World War II, 1943",
      visualTime: "1943",
    };
    const modernCandidate = makeCandidate({ title: "smartphone livestream selfie video" });
    expect(isOffTopicForVideoContext(modernCandidate, historicalIntent)).toBe(true);
  });

  it("does not flag archival-looking footage for a historical beat", () => {
    const historicalIntent: VisualIntent = {
      ...baseIntent,
      brands: [],
      companies: [],
      historicalContext: "World War II, 1943",
      visualTime: "1943",
    };
    const archivalCandidate = makeCandidate({ title: "black and white footage archival newsreel" });
    expect(isOffTopicForVideoContext(archivalCandidate, historicalIntent)).toBe(false);
  });
});
