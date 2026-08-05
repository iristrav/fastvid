import { describe, expect, it } from "vitest";
import { rankCandidates, DEFAULT_RANKING_CONFIG } from "./candidateRanking";
import type { CandidateAsset, VisualIntent } from "./types";

const intent: VisualIntent = {
  beatId: "b0",
  spokenText: "Elon Musk announced Grok 5",
  visualSubject: "Elon Musk",
  visualAction: "speaking",
  visualLocation: "stage",
  visualTime: "present",
  historicalContext: "",
  emotion: "confident",
  visualDescription: "Elon Musk on stage",
  primaryKeyword: "Elon Musk keynote",
  secondaryKeyword: "Elon Musk stage",
  negativeKeywords: [],
  secondaryVisualSubjects: [],
  objects: ["microphone"],
  brands: [],
  companies: ["xAI"],
  people: ["Elon Musk"],
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
    localPath: "/tmp/clip.mp4",
    remoteUrl: null,
    metadata: null,
    searchQuery: "Elon Musk keynote",
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
    embeddingSimilarity: 0.6,
    keywordScore: 0.5,
    retrievalReasons: ["keyword"],
    retrievalSources: [],
    clipSimilarity: 0.7,
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

describe("Candidate Ranking — Phase 3 new dimensions", () => {
  it("produces identical rankingScore to calling with no options, when no Phase 3 data is present (backwards compatible)", () => {
    const candidate = makeCandidate();
    const withoutOptions = rankCandidates(intent, [candidate], DEFAULT_RANKING_CONFIG);
    const withEmptyOptions = rankCandidates(intent, [candidate], DEFAULT_RANKING_CONFIG, {});
    expect(withoutOptions[0]!.rankingScore).toBeCloseTo(withEmptyOptions[0]!.rankingScore, 10);
  });

  it("rewards higher resolution via resolutionMatch", () => {
    const hd = makeCandidate({ candidateId: "hd", width: 1920, height: 1080 });
    const sd = makeCandidate({ candidateId: "sd", width: 320, height: 240 });
    const [ranked1, ranked2] = rankCandidates(intent, [hd, sd], DEFAULT_RANKING_CONFIG);
    const hdResult = [ranked1, ranked2].find((r) => r.candidate.candidateId === "hd")!;
    const sdResult = [ranked1, ranked2].find((r) => r.candidate.candidateId === "sd")!;
    expect(hdResult.rankingScore).toBeGreaterThan(sdResult.rankingScore);
    expect(hdResult.rankingBreakdown.signalsUsed).toContain("resolutionMatch");
  });

  it("rewards orientation matching the target video orientation", () => {
    const landscape = makeCandidate({ candidateId: "land", width: 1920, height: 1080 });
    const portrait = makeCandidate({ candidateId: "port", width: 1080, height: 1920 });
    const [r1, r2] = rankCandidates(intent, [landscape, portrait], DEFAULT_RANKING_CONFIG, {
      targetOrientation: "landscape",
    });
    const landResult = [r1, r2].find((r) => r.candidate.candidateId === "land")!;
    const portResult = [r1, r2].find((r) => r.candidate.candidateId === "port")!;
    expect(landResult.rankingScore).toBeGreaterThan(portResult.rankingScore);
  });

  it("rewards duration close to the target beat duration", () => {
    const closeMatch = makeCandidate({ candidateId: "close", duration: 5 });
    const farMatch = makeCandidate({ candidateId: "far", duration: 40 });
    const [r1, r2] = rankCandidates(intent, [closeMatch, farMatch], DEFAULT_RANKING_CONFIG, {
      targetDurationSec: 5,
    });
    const closeResult = [r1, r2].find((r) => r.candidate.candidateId === "close")!;
    const farResult = [r1, r2].find((r) => r.candidate.candidateId === "far")!;
    expect(closeResult.rankingScore).toBeGreaterThan(farResult.rankingScore);
  });

  it("rewards candidates whose text mentions the beat's extracted entities (entityMatch text-proxy)", () => {
    const matching = makeCandidate({ candidateId: "match", title: "Elon Musk xAI announcement", tags: ["Elon Musk", "xAI"] });
    const generic = makeCandidate({ candidateId: "generic", title: "office building" });
    const [r1, r2] = rankCandidates(intent, [matching, generic], DEFAULT_RANKING_CONFIG, {
      entityTerms: ["Elon Musk", "xAI", "microphone"],
    });
    const matchResult = [r1, r2].find((r) => r.candidate.candidateId === "match")!;
    const genericResult = [r1, r2].find((r) => r.candidate.candidateId === "generic")!;
    expect(matchResult.rankingScore).toBeGreaterThan(genericResult.rankingScore);
  });

  it("penalizes a candidate whose exact path was already used elsewhere in the video (diversity/no-repetition)", () => {
    const fresh = makeCandidate({ candidateId: "fresh", localPath: "/tmp/fresh.mp4" });
    const reused = makeCandidate({ candidateId: "reused", localPath: "/tmp/already_used.mp4" });
    const [r1, r2] = rankCandidates(intent, [fresh, reused], DEFAULT_RANKING_CONFIG, {
      usedPaths: new Set(["/tmp/already_used.mp4"]),
    });
    const freshResult = [r1, r2].find((r) => r.candidate.candidateId === "fresh")!;
    const reusedResult = [r1, r2].find((r) => r.candidate.candidateId === "reused")!;
    expect(freshResult.rankingScore).toBeGreaterThan(reusedResult.rankingScore);
  });

  it("penalizes over-represented categories gradually rather than excluding them entirely", () => {
    const candidate = makeCandidate({ tags: ["battle"] });
    const [never] = rankCandidates(intent, [candidate], DEFAULT_RANKING_CONFIG, {
      usedCategories: new Map(),
    });
    const [heavilyUsed] = rankCandidates(intent, [candidate], DEFAULT_RANKING_CONFIG, {
      usedCategories: new Map([["battle", 4]]),
    });
    expect(heavilyUsed.rankingScore).toBeLessThan(never.rankingScore);
    expect(heavilyUsed.rankingScore).toBeGreaterThan(0);
  });
});
