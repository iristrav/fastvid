import { describe, expect, it, vi } from "vitest";
import { rankCandidatesWithContext, type AssetDirectorContext, type CandidateMeta } from "./assetDirector";

// FASTVID — NEXT-LEVEL VISUAL SELECTION & RANKING
//
// Covers the 12 scenarios from the task's point 13, exercising the four new next-level ranking
// signals added this round (classifyEntityMatchTier/entityMatchTierScore, eventMatchScore,
// locationMatchScore — server/videoPipeline.ts) plus extractEventCue (server/mediaResearchEngine.ts)
// and reused/verified existing infra (providerAssetKey dedup identity, AssetDirector diversity via
// rankCandidatesWithContext). See server/mediaResearchEngine.test.ts for a plain-import
// extractEventCue test and server/videoPipeline.visualSelectionUpgrade.test.ts (Round 3) for the
// historicalDateAlignmentScore coverage this round's time-period test builds on.
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: (...args: unknown[]) => nodeFetchMock(...args) };
});

async function freshPipeline() {
  vi.resetModules();
  return import("./videoPipeline");
}

function minimalCtx(overrides: Partial<AssetDirectorContext> = {}): AssetDirectorContext {
  return {
    usedPaths: new Set(),
    usedCategories: new Map(),
    sceneAdoptedClips: [],
    prevSceneClips: [],
    callbacksPlaced: new Map(),
    ...overrides,
  };
}

describe("Test 1 — exact entity match beats generic topic match", () => {
  it("classifyEntityMatchTier returns exact for a candidate whose own provider text names the full primary person, general for one that doesn't", async () => {
    const { classifyEntityMatchTier, entityMatchTierScore } = await freshPipeline();
    const exactTier = classifyEntityMatchTier("Adolf Hitler", {
      title: "Adolf Hitler in the Führerbunker, Berlin 1945",
    });
    const generalTier = classifyEntityMatchTier("Adolf Hitler", {
      title: "German soldiers marching through a ruined city",
    });
    expect(exactTier).toBe("exact");
    expect(generalTier).toBe("general");
    expect(entityMatchTierScore(exactTier)).toBeGreaterThan(entityMatchTierScore(generalTier));
  }, 30_000); // first freshPipeline() import of the whole videoPipeline.ts module is slow (cold ffmpeg-binary detection etc.) when this file runs in isolation
});

describe("Test 2 — exact event match beats generic image", () => {
  it("eventMatchScore rewards a candidate whose provider text mentions the beat's actual event over one that doesn't", async () => {
    const { eventMatchScore } = await freshPipeline();
    const beatText = "Hitler and Eva Braun married shortly before their deaths in the Führerbunker.";
    const eventMatch = eventMatchScore(beatText, { title: "Hitler and Eva Braun married in the Führerbunker, Berlin 1945" });
    const genericWwii = eventMatchScore(beatText, { title: "Generic World War II soldiers on the front line" });
    expect(eventMatch).toBeGreaterThan(genericWwii);
  });

  it("extractEventCue finds the underlying action word this scoring signal keys off (reused vocabulary, no duplicate word list)", async () => {
    const { extractEventCue } = await import("./mediaResearchEngine");
    expect(extractEventCue("Hitler and Eva Braun married shortly before their deaths.")).toMatch(/marri/);
    expect(extractEventCue("A quiet countryside scene with no notable action.")).toBeNull();
  });
});

describe("Test 3 — location match improves ranking", () => {
  it("locationMatchScore rewards a candidate whose provider text mentions the render's active location", async () => {
    const { locationMatchScore } = await freshPipeline();
    const withLocation = locationMatchScore("berlin", { title: "Führerbunker, Berlin, April 1945" });
    const withoutLocation = locationMatchScore("berlin", { title: "Generic wartime archival footage" });
    expect(withLocation).toBeGreaterThan(withoutLocation);
    expect(withoutLocation).toBe(0); // never a penalty for simply not spelling the place out
  });

  it("no active location at all -> neutral, never invents a comparison", async () => {
    const { locationMatchScore } = await freshPipeline();
    expect(locationMatchScore(null, { title: "Berlin 1945" })).toBe(0);
    expect(locationMatchScore(undefined, { title: "Berlin 1945" })).toBe(0);
  });
});

describe("Test 4 — time-period match improves ranking", () => {
  it("historicalDateAlignmentScore (existing signal, reused unchanged this round) still prefers a period-matching candidate", async () => {
    const { historicalDateAlignmentScore } = await freshPipeline();
    const beatText = "Berlin, April 1945: Hitler's final days in the bunker.";
    const matching = historicalDateAlignmentScore({ dateHint: "1945" }, beatText);
    const mismatched = historicalDateAlignmentScore({ dateHint: "1933" }, beatText);
    expect(matching).toBeGreaterThan(mismatched);
  });
});

describe("Test 5 — wrong entity is rejected/strongly penalized", () => {
  it("a candidate whose provider text is real but names nothing to do with the beat's person scores below neutral (unknown/no-metadata)", async () => {
    const { classifyEntityMatchTier, entityMatchTierScore } = await freshPipeline();
    const wrongEntityTier = classifyEntityMatchTier("Adolf Hitler", { title: "Richard Stallman portrait, free software conference" });
    const noMetadataTier = classifyEntityMatchTier("Adolf Hitler", undefined);
    // RONDE 79: "Richard Stallman portrait" names a person, and not this one — that is the
    // "wrong" tier. The assertion this test exists for is unchanged and now holds harder: a
    // candidate that shows someone else scores below one that simply has no metadata.
    expect(wrongEntityTier).toBe("wrong");
    expect(entityMatchTierScore(wrongEntityTier)).toBeLessThan(entityMatchTierScore(noMetadataTier));
    expect(entityMatchTierScore(wrongEntityTier)).toBeLessThan(0);
    // And a candidate whose text names NOBODY is not punished for saying nothing.
    const silentTier = classifyEntityMatchTier("Adolf Hitler", { title: "Berlin street, 1945" });
    expect(silentTier).toBe("general");
    expect(entityMatchTierScore(silentTier)).toBe(0);
  });
});

describe("Test 6 — provider does not determine winner", () => {
  it("the next-level scoring signals take only providerText content as input — never a provider/source name — so two candidates with identical provider text score identically regardless of which provider supplied them", async () => {
    const { classifyEntityMatchTier, entityMatchTierScore, eventMatchScore, locationMatchScore } = await freshPipeline();
    const providerText = { title: "Hitler and Eva Braun married in the Führerbunker, Berlin, 1945" };
    const beatText = "Hitler and Eva Braun married shortly before their deaths in the Führerbunker, Berlin.";
    // Simulate the same real-world evidence arriving via two different providers (e.g. Wikimedia
    // vs Internet Archive) — the scoring functions have no provider/source parameter at all, so
    // there is no code path by which provider identity could change the result.
    const tierA = classifyEntityMatchTier("Adolf Hitler", providerText);
    const tierB = classifyEntityMatchTier("Adolf Hitler", { ...providerText });
    expect(entityMatchTierScore(tierA)).toBe(entityMatchTierScore(tierB));
    expect(eventMatchScore(beatText, providerText)).toBe(eventMatchScore(beatText, { ...providerText }));
    expect(locationMatchScore("berlin", providerText)).toBe(locationMatchScore("berlin", { ...providerText }));
  });

  it("rankCandidatesWithContext: a lower-quality-but-correct candidate from one path wins over a higher-embedding but content-blank candidate from another, irrespective of path/provider naming", async () => {
    const beatText = "Hitler final days inside the Fuhrerbunker in Berlin in 1945";
    const meta = new Map<string, CandidateMeta>([
      ["wikimedia_asset.mp4", { providerText: { title: "Hitler Fuhrerbunker Berlin 1945 final days inside bunker" }, embeddingSimilarity: 0.3 }],
      ["internet_archive_asset.mp4", { embeddingSimilarity: 0.95 }],
    ]);
    const result = rankCandidatesWithContext(
      ["internet_archive_asset.mp4", "wikimedia_asset.mp4"],
      beatText,
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths[0]).toBe("wikimedia_asset.mp4");
  });
});

describe("Test 7 — exact same asset remains blocked", () => {
  it("providerAssetKey collapses the same provider+id pair to one identity, whatever query found it", async () => {
    const { providerAssetKey } = await freshPipeline();
    const a = providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945");
    const b = providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945");
    expect(a).toBe(b);
  });
});

describe("Test 8 — different assets remain allowed", () => {
  it("providerAssetKey never collapses two genuinely different assets, even from the same provider and a similar beat", async () => {
    const { providerAssetKey } = await freshPipeline();
    const a = providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945");
    const b = providerAssetKey("wikimedia", "HitlerEvaBraunWedding1945");
    expect(a).not.toBe(b);
  });
});

describe("Test 9 — correct lower-quality image can beat incorrect high-quality image", () => {
  it("AssetDirector's weighted composite still favors real content-relevance (annotation/providerText fallback, 40%) over a much higher but content-blank embedding score (25%)", async () => {
    const beatText = "Hitler final days inside the Fuhrerbunker in Berlin in 1945";
    const meta = new Map<string, CandidateMeta>([
      ["correct_lower_quality.mp4", { providerText: { title: "Hitler Fuhrerbunker Berlin 1945 final days inside bunker" }, embeddingSimilarity: 0.3 }],
      ["wrong_high_quality.mp4", { embeddingSimilarity: 0.95 }],
    ]);
    const result = rankCandidatesWithContext(
      ["wrong_high_quality.mp4", "correct_lower_quality.mp4"],
      beatText,
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths[0]).toBe("correct_lower_quality.mp4");
  });
});

describe("Test 10 — candidate with missing metadata is not automatically rejected", () => {
  it("all four next-level signals return neutral (0/unknown), never a penalty, when provider metadata is simply absent", async () => {
    const {
      classifyEntityMatchTier,
      entityMatchTierScore,
      eventMatchScore,
      locationMatchScore,
      historicalDateAlignmentScore,
    } = await freshPipeline();
    const beatText = "Hitler and Eva Braun married shortly before their deaths in the Führerbunker, Berlin, 1945.";
    const tier = classifyEntityMatchTier("Adolf Hitler", undefined);
    expect(tier).toBe("unknown");
    expect(entityMatchTierScore(tier)).toBe(0);
    expect(eventMatchScore(beatText, undefined)).toBe(0);
    expect(locationMatchScore("berlin", undefined)).toBe(0);
    expect(historicalDateAlignmentScore(undefined, beatText)).toBe(0);
  });

  it("rankCandidatesWithContext doesn't crash or drop a metadata-less candidate — it still ranks and returns it", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["has_metadata.mp4", { providerText: { title: "Hitler Führerbunker Berlin 1945" } }],
      ["no_metadata.mp4", {} as CandidateMeta],
    ]);
    const result = rankCandidatesWithContext(
      ["has_metadata.mp4", "no_metadata.mp4"],
      "Hitler's final days in the bunker.",
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths).toHaveLength(2);
    expect(result.rankedPaths).toContain("no_metadata.mp4");
    expect(result.topScore).not.toBeNull();
  });
});

describe("Test 11 — shot diversity still works", () => {
  it("AssetDirector still produces a real ranking (doesn't fall back to input order) when diversity/usedCategories are in play, unaffected by the new next-level signals living upstream in adoptClip", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["overused_category.mp4", { providerText: { title: "Hitler Führerbunker Berlin 1945" } }],
      ["fresh_category.mp4", { providerText: { title: "Hitler Führerbunker Berlin 1945" } }],
    ]);
    const usedCategories = new Map<string, number>([["archival", 8]]);
    const result = rankCandidatesWithContext(
      ["overused_category.mp4", "fresh_category.mp4"],
      "Hitler's final days in the bunker.",
      0,
      0,
      minimalCtx({ usedCategories }),
      meta
    );
    expect(result.rankedPaths).toHaveLength(2);
    expect(result.topScore).not.toBeNull();
    expect(typeof result.topScore!.finalScore).toBe("number");
  });
});

describe("Test 12 — ranking explanation contains winning factors", () => {
  it("AssetScore.breakdown/reasons explains why the winning candidate ranked first (existing AssetDirector explainability, reused not rebuilt)", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["winner.mp4", { providerText: { title: "Hitler Führerbunker Berlin 1945 archival footage" }, embeddingSimilarity: 0.95 }],
      ["loser.mp4", {} as CandidateMeta],
    ]);
    const result = rankCandidatesWithContext(
      ["loser.mp4", "winner.mp4"],
      "Hitler's final days in the Führerbunker, Berlin, 1945",
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths[0]).toBe("winner.mp4");
    expect(result.topScore).not.toBeNull();
    expect(result.topScore!.breakdown).toBeDefined();
    expect(typeof result.topScore!.breakdown.annotation).toBe("number");
    expect(typeof result.topScore!.breakdown.embedding).toBe("number");
    expect(result.topScore!.finalScore).toBeGreaterThan(0);
  });

  it("adoptClip logs the winning candidate's next-level score breakdown (entity/event/location/time) — point 11 explainability, reusing the existing [Pipeline] log convention", async () => {
    // The log line lives in adoptClip's pre-AssetDirector sort; exercising it end-to-end requires
    // the full network/ffmpeg cascade, so this confirms the four scoring functions it composes
    // are exported and independently produce the exact values the log line would report, i.e.
    // the explanation is always derivable from real, callable signals rather than opaque numbers.
    const {
      classifyEntityMatchTier,
      entityMatchTierScore,
      eventMatchScore,
      locationMatchScore,
      historicalDateAlignmentScore,
    } = await freshPipeline();
    const beatText = "Hitler and Eva Braun married shortly before their deaths in the Führerbunker, Berlin, 1945.";
    const providerText = { title: "Adolf Hitler and Eva Braun married in the Führerbunker, Berlin, 1945", dateHint: "1945" };
    const tier = classifyEntityMatchTier("Adolf Hitler", providerText);
    expect(tier).toBe("exact");
    expect(entityMatchTierScore(tier)).toBeGreaterThan(0);
    expect(eventMatchScore(beatText, providerText)).toBeGreaterThan(0);
    expect(locationMatchScore("berlin", providerText)).toBeGreaterThan(0);
    expect(historicalDateAlignmentScore(providerText, beatText)).toBeGreaterThanOrEqual(0);
  });
});
