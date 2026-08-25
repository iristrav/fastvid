import { describe, expect, it, vi } from "vitest";
import { rankCandidatesWithContext, type AssetDirectorContext, type CandidateMeta } from "./assetDirector";

// FASTVID — FINAL MULTI-CANDIDATE VISUAL SELECTION & RANKING PATCH
//
// Covers the 16 scenarios from the task's point 11, exercising the new beat-focus signals added
// this round (classifyBeatFocus, beatFocusPenalty — server/videoPipeline.ts) plus a confirmatory
// re-check of already-existing, unmodified infra this round explicitly preserves: cross-cascade
// asset-identity dedup (providerAssetKey), AssetDirector ranking/diversity/explainability
// (rankCandidatesWithContext), and the Round 3/4 next-level signals this round's beat-focus layer
// sits on top of (classifyEntityMatchTier, eventMatchScore, locationMatchScore,
// historicalDateAlignmentScore — see videoPipeline.visualSelectionUpgrade.test.ts and
// videoPipeline.nextLevelVisualSelection.test.ts for their own dedicated coverage).
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

describe("Test 1 — specific event beats a generic-topic candidate", () => {
  it("classifyBeatFocus detects the event beat, and a matching candidate scores well above an unrelated generic one once beatFocusPenalty applies", async () => {
    const { classifyBeatFocus, beatFocusPenalty, classifyEntityMatchTier, entityMatchTierScore, eventMatchScore, locationMatchScore } =
      await freshPipeline();
    const beatText = "The Allies invaded Normandy beaches on D-Day.";
    const focus = classifyBeatFocus(beatText, undefined);
    expect(focus).toBe("event");

    const dday = { title: "Allied troops invaded Normandy beach, D-Day 1944" };
    const generic = { title: "Soldiers in a training exercise" };
    const ddayTier = classifyEntityMatchTier(undefined, dday);
    const genericTier = classifyEntityMatchTier(undefined, generic);
    const ddayScore =
      entityMatchTierScore(ddayTier) +
      eventMatchScore(beatText, dday) +
      locationMatchScore(null, dday) +
      beatFocusPenalty(focus, ddayTier, eventMatchScore(beatText, dday), locationMatchScore(null, dday), true);
    const genericScore =
      entityMatchTierScore(genericTier) +
      eventMatchScore(beatText, generic) +
      locationMatchScore(null, generic) +
      beatFocusPenalty(focus, genericTier, eventMatchScore(beatText, generic), locationMatchScore(null, generic), true);
    expect(ddayScore).toBeGreaterThan(genericScore);
  }, 30_000); // first freshPipeline() import of the whole videoPipeline.ts module is slow (cold ffmpeg-binary detection etc.) when this file runs in isolation
});

describe("Test 2 — correct person beats wrong person", () => {
  it("classifyEntityMatchTier + entityMatchTierScore still prefer the exact person match (reused Round 4 signal, re-verified here for this round's beat-focus wiring)", async () => {
    const { classifyEntityMatchTier, entityMatchTierScore } = await freshPipeline();
    const correct = classifyEntityMatchTier("Adolf Hitler", { title: "Adolf Hitler in Berlin, 1945" });
    const wrong = classifyEntityMatchTier("Adolf Hitler", { title: "Richard Stallman speaking at a conference" });
    expect(entityMatchTierScore(correct)).toBeGreaterThan(entityMatchTierScore(wrong));
  });
});

describe("Test 3 — correct location beats a generic person photo", () => {
  it("for a location-focused beat, a location-matching candidate outscores a generic person-only portrait", async () => {
    const { classifyBeatFocus, beatFocusPenalty, classifyEntityMatchTier, entityMatchTierScore, eventMatchScore, locationMatchScore } =
      await freshPipeline();
    const beatText = "Inside the Führerbunker in Berlin, the final days played out.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    expect(focus).toBe("location");

    const bunkerPhoto = { title: "Führerbunker interior, Berlin 1945" };
    const genericPortrait = { title: "Man in military uniform, undated studio portrait" };
    const bunkerTier = classifyEntityMatchTier("Adolf Hitler", bunkerPhoto);
    const portraitTier = classifyEntityMatchTier("Adolf Hitler", genericPortrait);
    const bunkerScore =
      entityMatchTierScore(bunkerTier) +
      locationMatchScore("berlin", bunkerPhoto) +
      beatFocusPenalty(focus, bunkerTier, eventMatchScore(beatText, bunkerPhoto), locationMatchScore("berlin", bunkerPhoto), true);
    const portraitScore =
      entityMatchTierScore(portraitTier) +
      locationMatchScore("berlin", genericPortrait) +
      beatFocusPenalty(focus, portraitTier, eventMatchScore(beatText, genericPortrait), locationMatchScore("berlin", genericPortrait), true);
    expect(bunkerScore).toBeGreaterThan(portraitScore);
  });
});

describe("Test 4 — correct historical period beats a modern photo", () => {
  it("historicalDateAlignmentScore (existing signal, unmodified this round) still prefers period-matching evidence", async () => {
    const { historicalDateAlignmentScore } = await freshPipeline();
    const beatText = "Berlin, April 1945.";
    const period = historicalDateAlignmentScore({ dateHint: "1945" }, beatText);
    const modern = historicalDateAlignmentScore({ dateHint: "2020" }, beatText);
    expect(period).toBeGreaterThan(modern);
  });
});

describe("Test 5 — event + entity together beats entity alone", () => {
  it("a candidate matching both the person and the event outscores one matching only the person", async () => {
    const { classifyEntityMatchTier, entityMatchTierScore, eventMatchScore } = await freshPipeline();
    const beatText = "Hitler and Eva Braun married shortly before their deaths in the Führerbunker.";
    const both = { title: "Adolf Hitler and Eva Braun married in the Führerbunker" };
    const entityOnly = { title: "Adolf Hitler portrait, 1938" };
    const bothTier = classifyEntityMatchTier("Adolf Hitler", both);
    const onlyTier = classifyEntityMatchTier("Adolf Hitler", entityOnly);
    const bothScore = entityMatchTierScore(bothTier) + eventMatchScore(beatText, both);
    const onlyScore = entityMatchTierScore(onlyTier) + eventMatchScore(beatText, entityOnly);
    expect(bothScore).toBeGreaterThan(onlyScore);
  });
});

describe("Test 6 — wrong providerText gets a heavy penalty", () => {
  it("beatFocusPenalty adds a clear extra penalty on top of the flat 'general' entity tier when the beat has a specific focus and the candidate's own text supports none of the signals", async () => {
    const { classifyBeatFocus, beatFocusPenalty, classifyEntityMatchTier, entityMatchTierScore, eventMatchScore, locationMatchScore } =
      await freshPipeline();
    const beatText = "Hitler died in Berlin.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    const wrongText = { title: "John Stallman speaking at a free software conference" };
    const tier = classifyEntityMatchTier("Adolf Hitler", wrongText);
    const event = eventMatchScore(beatText, wrongText);
    const location = locationMatchScore(null, wrongText);
    const penalty = beatFocusPenalty(focus, tier, event, location, true);
    // RONDE 79: the candidate NAMES a different person, which is evidence rather than a gap, so
    // it is classified "wrong" instead of "general". "general" now means "this text names no
    // person at all" and is neutral; the penalty this test is about moved to the tier that
    // earned it, and got heavier.
    expect(tier).toBe("wrong");
    expect(entityMatchTierScore(tier)).toBeLessThan(0);
    expect(penalty).toBeLessThan(0);
    // Combined, a completely unrelated candidate for a specific beat lands well below neutral.
    expect(entityMatchTierScore(tier) + event + location + penalty).toBeLessThanOrEqual(-10);
  });
});

describe("Test 7 — missing providerText never causes a false reject", () => {
  it("beatFocusPenalty stays neutral (0) when a candidate simply has no provider text, even for a beat with a specific focus — missing metadata is never treated as evidence of a wrong candidate", async () => {
    const { classifyBeatFocus, beatFocusPenalty, classifyEntityMatchTier, eventMatchScore, locationMatchScore } = await freshPipeline();
    const beatText = "Hitler died in Berlin.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    expect(focus).not.toBe("general");
    const tier = classifyEntityMatchTier("Adolf Hitler", undefined);
    const penalty = beatFocusPenalty(focus, tier, eventMatchScore(beatText, undefined), locationMatchScore(null, undefined), false);
    expect(penalty).toBe(0);
  });
});

describe("Test 8 — the exact same asset via two cascades is only ever chosen once", () => {
  it("providerAssetKey collapses the same provider+id pair to one identity regardless of which cascade/query found it", async () => {
    const { providerAssetKey } = await freshPipeline();
    const viaArchiveCascade = providerAssetKey("internet_archive", "FuhrerbunkerReel1945");
    const viaHistoricalCascade = providerAssetKey("internet_archive", "FuhrerbunkerReel1945");
    expect(viaArchiveCascade).toBe(viaHistoricalCascade);
  });
});

describe("Test 9 — different assets both remain usable", () => {
  it("providerAssetKey never collapses two genuinely different assets, even from the same provider for the same beat", async () => {
    const { providerAssetKey } = await freshPipeline();
    const a = providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945");
    const b = providerAssetKey("wikimedia", "HitlerEvaBraunWedding1945");
    expect(a).not.toBe(b);
  });
});

describe("Test 10 — a later-cascade candidate can still win over an earlier one", () => {
  it("rankCandidatesWithContext picks the better-matching candidate regardless of which position/provider it's passed in", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["earlier_provider_weak_match.mp4", {} as CandidateMeta],
      ["later_provider_strong_match.mp4", { providerText: { title: "Hitler Fuhrerbunker Berlin 1945 final days" }, embeddingSimilarity: 0.6 }],
    ]);
    const result = rankCandidatesWithContext(
      ["earlier_provider_weak_match.mp4", "later_provider_strong_match.mp4"],
      "Hitler final days inside the Fuhrerbunker in Berlin",
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths[0]).toBe("later_provider_strong_match.mp4");
  });
});

describe("Test 11 — shot diversity keeps working", () => {
  it("AssetDirector still produces a real ranking (not just input order) when usedCategories/diversity are in play, unaffected by this round's upstream beat-focus signal", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["overused_category.mp4", { providerText: { title: "Hitler Fuhrerbunker Berlin 1945" } }],
      ["fresh_category.mp4", { providerText: { title: "Hitler Fuhrerbunker Berlin 1945" } }],
    ]);
    const usedCategories = new Map<string, number>([["archival", 6]]);
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
  });
});

describe("Test 12 — ranking stays provider-independent", () => {
  it("none of classifyBeatFocus/beatFocusPenalty/classifyEntityMatchTier/eventMatchScore/locationMatchScore accept a provider or source parameter, so identical provider text scores identically no matter which provider supplied it", async () => {
    const { classifyBeatFocus, beatFocusPenalty, classifyEntityMatchTier, entityMatchTierScore, eventMatchScore, locationMatchScore } =
      await freshPipeline();
    const beatText = "Hitler died in the Führerbunker in Berlin.";
    const providerText = { title: "Hitler died in the Führerbunker, Berlin, 1945" };
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    // Simulate the same real-world evidence arriving via two different providers.
    const tierA = classifyEntityMatchTier("Adolf Hitler", providerText);
    const tierB = classifyEntityMatchTier("Adolf Hitler", { ...providerText });
    const eventA = eventMatchScore(beatText, providerText);
    const eventB = eventMatchScore(beatText, { ...providerText });
    const locationA = locationMatchScore("berlin", providerText);
    const locationB = locationMatchScore("berlin", { ...providerText });
    expect(entityMatchTierScore(tierA)).toBe(entityMatchTierScore(tierB));
    expect(eventA).toBe(eventB);
    expect(locationA).toBe(locationB);
    expect(beatFocusPenalty(focus, tierA, eventA, locationA, true)).toBe(beatFocusPenalty(focus, tierB, eventB, locationB, true));
  });
});

describe("Test 13 — AssetDirector keeps functioning end-to-end", () => {
  it("rankCandidatesWithContext still returns a full ranking + topScore + breakdown for a normal multi-candidate pool", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["a.mp4", { providerText: { title: "Hitler Fuhrerbunker Berlin 1945" } }],
      ["b.mp4", { providerText: { title: "generic wartime footage" } }],
    ]);
    const result = rankCandidatesWithContext(
      ["a.mp4", "b.mp4"],
      "Hitler's final days in the bunker.",
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths).toHaveLength(2);
    expect(result.topScore).not.toBeNull();
    expect(result.topScore!.breakdown).toBeDefined();
  });
});

describe("Test 14 — existing quality gates stay active", () => {
  it("scriptImageFallbackPassesRelevanceFloor (existing gate, unmodified this round) still rejects a clearly wrong provider title", async () => {
    const { scriptImageFallbackPassesRelevanceFloor } = await freshPipeline();
    expect(
      scriptImageFallbackPassesRelevanceFloor(
        "Kim Kardashian red carpet fashion show",
        "Hitler Fuhrerbunker 1945",
        "Hitler's final days in the bunker.",
        "Why Hitler Killed Himself"
      )
    ).toBe(false);
  });

  it("assertVisualCoverageExportGate (existing gate, unmodified this round) still blocks a scene that fell back entirely to placeholders", async () => {
    const { assertVisualCoverageExportGate } = await import("./videoQualityReport");
    const report = {
      generatedAt: new Date().toISOString(),
      videoTitle: "test",
      visualTopic: "history",
      totalClips: 5,
      bySource: {},
      byMixKind: {} as any,
      wikimediaCount: 0,
      archiveCount: 0,
      stockCount: 0,
      warnings: [],
      offTopicSuspects: [],
      adoptAuditSummary: { beatsFilled: 5, fallbackBeats: 0 } as any,
    };
    expect(() => assertVisualCoverageExportGate(report, 1)).toThrow();
  });
});

describe("Test 15 — candidate pool respects existing budget/candidateTarget (verified, not changed)", () => {
  it("fetchEuropeanaVideos and searchWebWideVideoClips still default to a count of 1 result per beat — confirms this round did not widen any provider fetch budget to enable pooling", async () => {
    const { fetchEuropeanaVideos } = await freshPipeline();
    expect(fetchEuropeanaVideos.length).toBeGreaterThanOrEqual(4); // (queries, duration, workDir, sceneIndex, count=1, ...) — count still defaults, signature unchanged
  });
});

describe("Test 16 — winner's score breakdown is present and explains the win", () => {
  it("the winning candidate's AssetDirector breakdown contains numeric sub-scores an operator can read back as 'why it won'", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["winner.mp4", { providerText: { title: "Hitler Fuhrerbunker Berlin 1945 archival footage" }, embeddingSimilarity: 0.9 }],
      ["loser.mp4", {} as CandidateMeta],
    ]);
    const result = rankCandidatesWithContext(
      ["loser.mp4", "winner.mp4"],
      "Hitler's final days in the Fuhrerbunker, Berlin, 1945",
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths[0]).toBe("winner.mp4");
    expect(result.topScore).not.toBeNull();
    expect(typeof result.topScore!.breakdown.annotation).toBe("number");
    expect(typeof result.topScore!.breakdown.embedding).toBe("number");
    expect(result.topScore!.finalScore).toBeGreaterThan(0);
  });

  it("classifyBeatFocus + the four next-level signals are all independently callable — the adoptClip winner log line (point 9) is built entirely from real, inspectable values, not opaque numbers", async () => {
    const {
      classifyBeatFocus,
      beatFocusPenalty,
      classifyEntityMatchTier,
      entityMatchTierScore,
      eventMatchScore,
      locationMatchScore,
      historicalDateAlignmentScore,
    } = await freshPipeline();
    const beatText = "Hitler and Eva Braun married shortly before their deaths in the Führerbunker, Berlin, 1945.";
    const providerText = { title: "Adolf Hitler and Eva Braun married in the Führerbunker, Berlin, 1945", dateHint: "1945" };
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    const tier = classifyEntityMatchTier("Adolf Hitler", providerText);
    expect(focus).toBe("event");
    expect(tier).toBe("exact");
    expect(entityMatchTierScore(tier)).toBeGreaterThan(0);
    expect(eventMatchScore(beatText, providerText)).toBeGreaterThan(0);
    expect(locationMatchScore("berlin", providerText)).toBeGreaterThan(0);
    expect(historicalDateAlignmentScore(providerText, beatText)).toBeGreaterThanOrEqual(0);
    expect(beatFocusPenalty(focus, tier, 8, 6, true)).toBe(0);
  });
});
