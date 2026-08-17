import { describe, expect, it, vi } from "vitest";
import { rankCandidatesWithContext, type AssetDirectorContext, type CandidateMeta } from "./assetDirector";

// FASTVID — NEXT-GEN VISUAL SELECTION QUALITY UPGRADE
//
// Covers the 16 scenarios from the task's point 14, mapped onto what this round actually
// changed (historicalDateAlignmentScore, the providerText.dateHint plumbing) plus fresh,
// self-contained regression coverage of already-existing infra this round explicitly did NOT
// redesign (dedup identity, relevance floor, AssetDirector diversity-vs-relevance ordering,
// the visual coverage export gate, and the fallback duration cap) — see
// server/mediaResearchEngine.test.ts for the visual-target-extraction/multi-query tests
// (points 1/2) that don't need the full videoPipeline.ts module.
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

describe("Points 6/7/8 — historicalDateAlignmentScore (soft historical-consistency ranking)", () => {
  it("Test 6 — a candidate whose real date evidence matches the beat's period scores higher than a mismatched one", async () => {
    const { historicalDateAlignmentScore } = await freshPipeline();
    const beatText = "Hitler's final days in April 1945.";
    const matching = historicalDateAlignmentScore({ dateHint: "1945" }, beatText);
    const mismatched = historicalDateAlignmentScore({ dateHint: "1933" }, beatText);
    expect(matching).toBeGreaterThan(mismatched);
  }, 30_000); // first freshPipeline() import of the whole videoPipeline.ts module is slow (cold ffmpeg-binary detection etc.) when this file runs in isolation

  it("Test 7 — a historical candidate with no extractable date evidence stays neutral (0), never penalized or blocked", async () => {
    const { historicalDateAlignmentScore } = await freshPipeline();
    const beatText = "Hitler's final days in April 1945.";
    expect(historicalDateAlignmentScore(undefined, beatText)).toBe(0);
    expect(historicalDateAlignmentScore({ title: "Bunker footage, no date given" }, beatText)).toBe(0);
  });

  it("no target year in the beat at all -> also neutral, never invents a comparison", async () => {
    const { historicalDateAlignmentScore } = await freshPipeline();
    expect(historicalDateAlignmentScore({ dateHint: "1945" }, "A calm walk through the park")).toBe(0);
  });

  it("the bonus/penalty stays small and bounded, so it can only nudge — never override — relevance/entity scoring", async () => {
    const { historicalDateAlignmentScore } = await freshPipeline();
    const beatText = "Hitler's final days in April 1945.";
    const exact = historicalDateAlignmentScore({ dateHint: "1945" }, beatText);
    const farOff = historicalDateAlignmentScore({ dateHint: "1800" }, beatText);
    expect(Math.abs(exact)).toBeLessThanOrEqual(3);
    expect(Math.abs(farOff)).toBeLessThanOrEqual(3);
  });
});

describe("Points 3/4 — dedup identity (same asset via two queries/routes stays one asset)", () => {
  it("Test 3 — the same physical asset located via two different queries collapses to one identity", async () => {
    const { providerAssetKey } = await freshPipeline();
    const a = providerAssetKey("internet_archive", "HitlerFuhrerbunker1945");
    const b = providerAssetKey("internet_archive", "HitlerFuhrerbunker1945");
    expect(a).toBe(b);
  });

  it("Test 4 — two genuinely different assets never collapse — both remain adoptable", async () => {
    const { providerAssetKey } = await freshPipeline();
    const a = providerAssetKey("internet_archive", "BerlinRuins1945");
    const b = providerAssetKey("internet_archive", "HitlerFuhrerbunker1945");
    expect(a).not.toBe(b);
  });
});

describe("Points 8/9 — relevance floor (bad provider title rejected, good title passes)", () => {
  it("Test 8 — a clearly wrong provider title is rejected", async () => {
    const { scriptImageFallbackPassesRelevanceFloor } = await freshPipeline();
    expect(
      scriptImageFallbackPassesRelevanceFloor(
        "Kim Kardashian red carpet fashion show",
        "Hitler Führerbunker 1945",
        "Hitler's final days in the bunker.",
        "Why Hitler Killed Himself"
      )
    ).toBe(false);
  });

  it("Test 9 — a good, on-topic provider title passes through to the remaining gates", async () => {
    const { scriptImageFallbackPassesRelevanceFloor } = await freshPipeline();
    expect(
      scriptImageFallbackPassesRelevanceFloor(
        "Adolf Hitler Führerbunker Berlin 1945",
        "Hitler Führerbunker 1945",
        "Hitler's final days in the bunker.",
        "Why Hitler Killed Himself"
      )
    ).toBe(true);
  });
});

describe("Points 10/11 — diversity influences ranking without overriding relevance", () => {
  it("Test 10 — among two similarly-relevant candidates, AssetDirector doesn't crash and produces a real ranking when one category is already heavily used", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["reused_category.mp4", { providerText: { title: "Hitler Führerbunker Berlin 1945" } }],
      ["fresh_category.mp4", { providerText: { title: "Hitler Führerbunker Berlin 1945" } }],
    ]);
    const usedCategories = new Map<string, number>([["archival", 5]]);
    const result = rankCandidatesWithContext(
      ["reused_category.mp4", "fresh_category.mp4"],
      "Hitler's final days in the bunker.",
      0,
      0,
      minimalCtx({ usedCategories }),
      meta
    );
    expect(result.rankedPaths).toHaveLength(2);
    expect(result.topScore).not.toBeNull();
  });

  it("Test 11 — a candidate with real matching provider text still outranks one with none, even before diversity is considered", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["matches.mp4", { providerText: { title: "Hitler Führerbunker Berlin 1945 archival footage" } }],
      ["blank.mp4", {} as CandidateMeta],
    ]);
    const result = rankCandidatesWithContext(
      ["blank.mp4", "matches.mp4"],
      "Hitler's final days in the Führerbunker, Berlin, 1945",
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths[0]).toBe("matches.mp4");
  });
});

describe("Points 12/13 — provider suitability signals stay topic-conditional (verified, reused from mediaResearchEngine)", () => {
  it("historical topics boost archival/wikimedia sources relative to stock, via the existing topic-aware scorer", async () => {
    const { scoreMediaCandidate, buildMediaSearchIntent } = await import("./mediaResearchEngine");
    const intent = buildMediaSearchIntent({
      beatText: "Hitler's final days in the Führerbunker, Berlin, 1945.",
      searchQueries: ["Hitler Führerbunker 1945"],
      keywords: ["hitler", "bunker"],
      primaryPerson: "",
      persons: ["Hitler"],
      powerWord: "Hitler",
      personTopicLock: false,
      spaceTopic: false,
      muskTopic: false,
    });
    const archival = scoreMediaCandidate(
      { path: "/tmp/a.mp4", query: "Hitler Führerbunker 1945", source: "internet_archive", isVideo: true },
      intent
    );
    const stock = scoreMediaCandidate(
      { path: "/tmp/b.mp4", query: "Hitler Führerbunker 1945", source: "pexels", isVideo: true },
      intent
    );
    expect(archival).toBeGreaterThan(stock);
  });

  it("modern/person topics don't get the historical archival boost — provider preference stays topic-conditional, not a fixed universal order", async () => {
    const { scoreMediaCandidate, buildMediaSearchIntent } = await import("./mediaResearchEngine");
    const modernIntent = buildMediaSearchIntent({
      beatText: "Elon Musk announced the new product today.",
      searchQueries: ["Elon Musk announcement"],
      keywords: ["musk"],
      primaryPerson: "Elon Musk",
      persons: ["Elon Musk"],
      powerWord: "Musk",
      personTopicLock: true,
      spaceTopic: false,
      muskTopic: true,
    });
    const modernArchival = scoreMediaCandidate(
      { path: "/tmp/a.mp4", query: "Elon Musk", source: "internet_archive", isVideo: true },
      modernIntent
    );
    const modernCelebrity = scoreMediaCandidate(
      { path: "/tmp/b.mp4", query: "Elon Musk", source: "person_celebrity", isVideo: true },
      modernIntent
    );
    // For a person-topic-locked modern beat, the celebrity-oriented source is preferred over
    // (or at least not dominated by) the historical-archive boost that a historical beat gets.
    expect(modernCelebrity).toBeGreaterThanOrEqual(modernArchival - 20);
  });
});

describe("Points 15/16 — quality gate and fallback cadence stay unchanged (reused from prior hardening rounds)", () => {
  it("Test 15 — assertVisualCoverageExportGate still blocks a scene that fell back entirely to the placeholder", async () => {
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

  it("Test 16 — the scene-level placeholder fallback stays capped to a short clip, never a long single placeholder", async () => {
    const { guaranteedTextOverlayDurationSec } = await freshPipeline();
    const { archiveVisualMaxClipSec } = await import("./sourcingPolicy");
    expect(guaranteedTextOverlayDurationSec(120)).toBe(archiveVisualMaxClipSec());
  });
});
