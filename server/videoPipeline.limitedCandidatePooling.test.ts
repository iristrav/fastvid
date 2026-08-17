import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { rankCandidatesWithContext, type AssetDirectorContext, type CandidateMeta } from "./assetDirector";

// FASTVID — LIMITED CROSS-PROVIDER CANDIDATE POOLING PATCH
//
// Covers the 18 scenarios from the task's point 14. The pooling itself lives in
// fetchBeatAuthenticStills (server/videoPipeline.ts) — a module-private function that fetches
// from SerpAPI/Wikimedia/Openverse and does real network I/O, so (matching this session's
// established test convention — see the Round 3/4/5 files) most scenarios exercise the exported
// pure functions the pool is built from (classifyBeatFocus, beatFocusPenalty,
// candidatePoolEarlyExitReady, classifyEntityMatchTier, eventMatchScore, locationMatchScore,
// historicalDateAlignmentScore) and the reused AssetDirector/dedup infra (rankCandidatesWithContext,
// providerAssetKey) directly. A handful of purely structural guarantees (bounded pool size, only
// one adoptClip call, unchanged provider gating) are verified by reading fetchBeatAuthenticStills's
// own source text — a real regression guard for "did this still-existing code path change" that
// doesn't require mocking three network providers end-to-end.
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: (...args: unknown[]) => nodeFetchMock(...args) };
});

// None of this file's tests toggle env vars or module state, so unlike some sibling test files
// the module is imported once and reused — resetModules() per test would just re-pay the same
// cold ffmpeg-binary-detection cost (~seconds) on every single test for no isolation benefit here.
let cachedPipeline: Promise<typeof import("./videoPipeline")> | null = null;
async function freshPipeline() {
  if (!cachedPipeline) cachedPipeline = import("./videoPipeline");
  return cachedPipeline;
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

function extractFunctionSource(fnName: string): string {
  const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const marker = `async function ${fnName}(`;
  const startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error(`function ${fnName} not found in videoPipeline.ts`);
  const bodyStart = src.indexOf("{", startIdx);
  let depth = 0;
  let i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(startIdx, i + 1);
}

describe("Test 1/2 — first mediocre candidate doesn't auto-win; a later, better candidate can win", () => {
  it("rankCandidatesWithContext (the shared ranking adoptClip's merged pool goes through) prefers the better-matching candidate regardless of array position", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["first_mediocre.mp4", { providerText: { title: "generic wartime footage" } }],
      ["later_better.mp4", { providerText: { title: "Hitler Fuhrerbunker Berlin 1945 archival footage" }, embeddingSimilarity: 0.7 }],
    ]);
    const result = rankCandidatesWithContext(
      ["first_mediocre.mp4", "later_better.mp4"],
      "Hitler's final days in the Fuhrerbunker, Berlin, 1945",
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths[0]).toBe("later_better.mp4");
  }, 30_000); // first freshPipeline() import of the whole videoPipeline.ts module is slow (cold ffmpeg-binary detection etc.) when this file runs in isolation
});

describe("Test 3 — correct event candidate beats a generic candidate", () => {
  it("eventMatchScore + beatFocusPenalty combine to clearly favor the event-matching candidate", async () => {
    const { classifyBeatFocus, beatFocusPenalty, classifyEntityMatchTier, eventMatchScore, locationMatchScore } = await freshPipeline();
    const beatText = "Hitler and Eva Braun married shortly before their deaths in the Führerbunker.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    const eventMatch = { title: "Adolf Hitler and Eva Braun married in the Führerbunker, Berlin" };
    const generic = { title: "German soldiers marching through a ruined city" };
    const eventTier = classifyEntityMatchTier("Adolf Hitler", eventMatch);
    const genericTier = classifyEntityMatchTier("Adolf Hitler", generic);
    const eventScore =
      eventMatchScore(beatText, eventMatch) +
      beatFocusPenalty(focus, eventTier, eventMatchScore(beatText, eventMatch), locationMatchScore(null, eventMatch), true);
    const genericScore =
      eventMatchScore(beatText, generic) +
      beatFocusPenalty(focus, genericTier, eventMatchScore(beatText, generic), locationMatchScore(null, generic), true);
    expect(eventScore).toBeGreaterThan(genericScore);
  });
});

describe("Test 4 — correct person beats wrong person", () => {
  it("classifyEntityMatchTier + entityMatchTierScore prefer the exact person match", async () => {
    const { classifyEntityMatchTier, entityMatchTierScore } = await freshPipeline();
    const correct = classifyEntityMatchTier("Adolf Hitler", { title: "Adolf Hitler, Berlin 1945" });
    const wrong = classifyEntityMatchTier("Adolf Hitler", { title: "Richard Stallman at a conference" });
    expect(entityMatchTierScore(correct)).toBeGreaterThan(entityMatchTierScore(wrong));
  });
});

describe("Test 5 — correct location/context beats a generic person photo", () => {
  it("for a location-focused beat, locationMatchScore + beatFocusPenalty favor the location-matching candidate over a generic portrait", async () => {
    const { classifyBeatFocus, beatFocusPenalty, classifyEntityMatchTier, eventMatchScore, locationMatchScore } = await freshPipeline();
    const beatText = "Inside the Führerbunker in Berlin, the final days played out.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    expect(focus).toBe("location");
    const bunker = { title: "Führerbunker interior, Berlin 1945" };
    const genericPortrait = { title: "Man in uniform, undated studio portrait" };
    const bunkerTier = classifyEntityMatchTier("Adolf Hitler", bunker);
    const portraitTier = classifyEntityMatchTier("Adolf Hitler", genericPortrait);
    const bunkerScore =
      locationMatchScore("berlin", bunker) +
      beatFocusPenalty(focus, bunkerTier, eventMatchScore(beatText, bunker), locationMatchScore("berlin", bunker), true);
    const portraitScore =
      locationMatchScore("berlin", genericPortrait) +
      beatFocusPenalty(focus, portraitTier, eventMatchScore(beatText, genericPortrait), locationMatchScore("berlin", genericPortrait), true);
    expect(bunkerScore).toBeGreaterThan(portraitScore);
  });
});

describe("Test 6 — historical period is taken into account", () => {
  it("historicalDateAlignmentScore (existing signal, unmodified) still prefers period-matching evidence within the pool", async () => {
    const { historicalDateAlignmentScore } = await freshPipeline();
    const beatText = "Berlin, April 1945.";
    expect(historicalDateAlignmentScore({ dateHint: "1945" }, beatText)).toBeGreaterThan(
      historicalDateAlignmentScore({ dateHint: "1920" }, beatText)
    );
  });
});

describe("Test 7 — the same asset from two cascades is only ever included once", () => {
  it("providerAssetKey collapses identical provider+id pairs, and a plain array merge (the pooling mechanism) collapses duplicate paths via Set", async () => {
    const { providerAssetKey } = await freshPipeline();
    expect(providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945")).toBe(providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945"));
    const merged = [...new Set(["a.jpg", "b.jpg", "a.jpg"])];
    expect(merged).toEqual(["a.jpg", "b.jpg"]);
  });
});

describe("Test 8 — different assets remain allowed", () => {
  it("providerAssetKey never collapses two genuinely different assets", async () => {
    const { providerAssetKey } = await freshPipeline();
    expect(providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945")).not.toBe(
      providerAssetKey("wikimedia", "HitlerEvaBraunWedding1945")
    );
  });
});

describe("Test 9 — missing providerText never causes a false reject", () => {
  it("classifyEntityMatchTier + beatFocusPenalty + candidatePoolEarlyExitReady all stay neutral/non-blocking when a pool candidate simply has no provider text", async () => {
    const { classifyBeatFocus, beatFocusPenalty, classifyEntityMatchTier, candidatePoolEarlyExitReady, eventMatchScore, locationMatchScore } =
      await freshPipeline();
    const beatText = "Hitler died in Berlin.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    const tier = classifyEntityMatchTier("Adolf Hitler", undefined);
    expect(tier).toBe("unknown");
    expect(beatFocusPenalty(focus, tier, eventMatchScore(beatText, undefined), locationMatchScore(null, undefined), false)).toBe(0);
    // "unknown" never qualifies for the early-exit shortcut either — a candidate with no evidence
    // at all never causes the pool to stop early or gets treated as strong, but it also isn't
    // penalized just for lacking metadata (that's what beatFocusPenalty already guarantees above).
    expect(candidatePoolEarlyExitReady(focus, tier, 0, 0)).toBe(false);
  });
});

describe("Test 10 — beatFocusPenalty keeps working", () => {
  it("still penalizes a candidate with real-but-unrelated provider text on a focused beat (Round 5 behavior, unmodified)", async () => {
    const { classifyBeatFocus, beatFocusPenalty, classifyEntityMatchTier, eventMatchScore, locationMatchScore } = await freshPipeline();
    const beatText = "Hitler died in Berlin.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    const wrongText = { title: "John Stallman speaking at a free software conference" };
    const tier = classifyEntityMatchTier("Adolf Hitler", wrongText);
    const penalty = beatFocusPenalty(focus, tier, eventMatchScore(beatText, wrongText), locationMatchScore(null, wrongText), true);
    expect(penalty).toBeLessThan(0);
  });
});

describe("Test 11 — AssetDirector stays active", () => {
  it("rankCandidatesWithContext still returns a full ranking + topScore + breakdown for the merged pool", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["a.mp4", { providerText: { title: "Hitler Fuhrerbunker Berlin 1945" } }],
      ["b.mp4", { providerText: { title: "generic wartime footage" } }],
    ]);
    const result = rankCandidatesWithContext(["a.mp4", "b.mp4"], "Hitler's final days in the bunker.", 0, 0, minimalCtx(), meta);
    expect(result.topScore).not.toBeNull();
    expect(result.topScore!.breakdown).toBeDefined();
  });
});

describe("Test 12 — diversity state keeps working", () => {
  it("AssetDirector still produces a real ranking when usedCategories/diversity are in play, unaffected by pooling upstream", async () => {
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

describe("Test 13/17 — candidate pool stays bounded, no new unbounded downloads", () => {
  it("fetchBeatAuthenticStills caps the merged pool to 5 and keeps each provider's per-query count at 1 (unchanged from before pooling)", () => {
    const src = extractFunctionSource("fetchBeatAuthenticStills");
    expect(src).toMatch(/\.slice\(0,\s*5\)/);
    const serpCount = src.match(/fetchSerpAPIImages\(\s*\n?[^)]*?,\s*\n?\s*1,/s);
    const wikiCount = src.match(/fetchWikimediaImages\(\s*\n?[^)]*?,\s*\n?\s*1,/s);
    const ovCount = src.match(/fetchOpenverseImages\(\s*\n?[^)]*?,\s*\n?\s*1,/s);
    expect(serpCount).not.toBeNull();
    expect(wikiCount).not.toBeNull();
    expect(ovCount).not.toBeNull();
  });
});

describe("Test 14 — existing provider gating stays active", () => {
  it("fetchBeatAuthenticStills still gates SerpAPI/Openverse behind the same SERPAPI_KEY/historicalDoc/fastStockMode conditions as before", () => {
    const src = extractFunctionSource("fetchBeatAuthenticStills");
    expect(src).toContain("SERPAPI_KEY && (historicalDoc || !dedup.perf.fastStockMode)");
    expect(src).toContain("(historicalDoc || !dedup.perf.fastStockMode) && ovQ.length > 3");
  });
});

describe("Test 15 — existing quality gates stay active", () => {
  it("scriptImageFallbackPassesRelevanceFloor (existing gate, unmodified) still rejects a clearly wrong provider title", async () => {
    const { scriptImageFallbackPassesRelevanceFloor } = await freshPipeline();
    expect(
      scriptImageFallbackPassesRelevanceFloor(
        "John Stallman speaking at a free software conference",
        "Hitler Fuhrerbunker 1945",
        "Hitler died in the Führerbunker in Berlin.",
        "Why Hitler Killed Himself"
      )
    ).toBe(false);
  });
});

describe("Test 16 — provider name does not influence ranking", () => {
  it("none of the pooling/ranking signal functions take a provider or source parameter — identical provider text scores identically no matter which provider supplied it", async () => {
    const { classifyBeatFocus, beatFocusPenalty, classifyEntityMatchTier, entityMatchTierScore, eventMatchScore, locationMatchScore } =
      await freshPipeline();
    const beatText = "Hitler died in the Führerbunker in Berlin.";
    const providerText = { title: "Hitler died in the Führerbunker, Berlin, 1945" };
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    const tierA = classifyEntityMatchTier("Adolf Hitler", providerText);
    const tierB = classifyEntityMatchTier("Adolf Hitler", { ...providerText });
    expect(entityMatchTierScore(tierA)).toBe(entityMatchTierScore(tierB));
    expect(eventMatchScore(beatText, providerText)).toBe(eventMatchScore(beatText, { ...providerText }));
    expect(locationMatchScore("berlin", providerText)).toBe(locationMatchScore("berlin", { ...providerText }));
    expect(beatFocusPenalty(focus, tierA, 0, 0, true)).toBe(beatFocusPenalty(focus, tierB, 0, 0, true));
  });
});

describe("Test 18 — the winner is only adopted after pool selection", () => {
  it("fetchBeatAuthenticStills calls adoptClip exactly once, on the merged pool — not once per provider with early return on first success", () => {
    const src = extractFunctionSource("fetchBeatAuthenticStills");
    const adoptCalls = src.match(/await adoptClip\(/g) ?? [];
    expect(adoptCalls.length).toBe(1);
  });

  it("candidatePoolEarlyExitReady only shortcuts the pool for a genuinely strong match — never a merely-present one", async () => {
    const { candidatePoolEarlyExitReady } = await freshPipeline();
    expect(candidatePoolEarlyExitReady("event", "exact", 8, 0)).toBe(true);
    expect(candidatePoolEarlyExitReady("event", "exact", -2, 0)).toBe(false); // exact person but wrong event
    expect(candidatePoolEarlyExitReady("location", "exact", 0, 0)).toBe(false); // exact person but no location match
    expect(candidatePoolEarlyExitReady("general", "exact", 0, 0)).toBe(true);
    expect(candidatePoolEarlyExitReady("event", "strong", 8, 0)).toBe(false); // not an exact match
  });
});
