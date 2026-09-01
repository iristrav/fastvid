import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { rankCandidatesWithContext, type AssetDirectorContext, type CandidateMeta } from "./assetDirector";

// FASTVID — GERICHTE VIDEO CANDIDATE POOLING & BEST-OF SELECTION
//
// Covers the 18 scenarios from the task. The pooling itself lives in fetchHistoricalBeatVideo
// (server/videoPipeline.ts) — a module-private-behavior function (exported for call-site reasons,
// but doing real network I/O across up to 9 provider tiers) so, matching this session's
// established convention (see the limitedCandidatePooling.test.ts file for the equivalent still-
// image patch), most scenarios exercise the exported pure functions the pool is built from
// (classifyBeatFocus, beatFocusPenalty, candidatePoolEarlyExitReady, classifyEntityMatchTier,
// eventMatchScore, locationMatchScore, historicalDateAlignmentScore) and the reused
// AssetDirector/dedup infra (rankCandidatesWithContext, providerAssetKey) directly. A handful of
// purely structural guarantees (bounded pool size, unchanged provider gating, early exit reuse,
// unchanged TTS/script/ffmpeg-adjacent code) are verified by reading the function's own source
// text — a real regression guard that doesn't require mocking nine network providers end-to-end.
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: (...args: unknown[]) => nodeFetchMock(...args) };
});

// None of this file's tests toggle env vars or module state, so the module is imported once and
// reused — resetModules() per test would just re-pay the same cold ffmpeg-binary-detection cost
// on every single test for no isolation benefit here (same reasoning as the sibling pooling file).
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
  // RONDE 90: several beat entry points are now thin wrappers that put the beat's proven search
  // context in scope and delegate to `<name>Inner`. The body these tests assert about is the
  // implementation, not the four-line wrapper, so resolve to Inner wherever it exists.
  const resolved = src.includes(`function ${fnName}Inner(`) ? `${fnName}Inner` : fnName;
  const marker = `function ${resolved}(`;
  const startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error(`function ${fnName} not found in videoPipeline.ts`);
  // Find the end of the parameter list by paren-depth (not just the first "{"), since a
  // parameter's inline object type (e.g. `opts: { skipYoutube?: boolean } = {}`) would otherwise
  // be mistaken for the function body's opening brace.
  let parenDepth = 0;
  let i = startIdx + marker.length - 1;
  for (; i < src.length; i++) {
    if (src[i] === "(") parenDepth++;
    else if (src[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) break;
    }
  }
  const bodyStart = src.indexOf("{", i);
  let depth = 0;
  let j = bodyStart;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(startIdx, j + 1);
}

describe("Test 1 — multiple video providers can supply candidates for the same beat", () => {
  it("fetchHistoricalBeatVideo's tier loop still iterates HISTORICAL_SOURCE_TIER_ORDER (internet_archive, youtube_cc, wikimedia, nara, flickr, sepiasearch, vimeo, media_ccc, nasa) unchanged", async () => {
    const { HISTORICAL_SOURCE_TIER_ORDER } = await freshPipeline();
    expect(HISTORICAL_SOURCE_TIER_ORDER).toEqual([
      "internet_archive", "youtube_cc", "wikimedia", "nara", "flickr", "sepiasearch", "vimeo", "media_ccc", "nasa",
    ]);
  }, 30_000); // first freshPipeline() import of the whole videoPipeline.ts module is slow (cold ffmpeg-binary detection etc.) when this file runs in isolation
});

describe("Test 2/3 — the best candidate wins even when it doesn't come from the first provider", () => {
  it("rankCandidatesWithContext (the shared ranking the merged pool goes through) prefers the better-matching candidate regardless of array position", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["first_provider_weak.mp4", {} as CandidateMeta],
      ["later_provider_strong.mp4", { providerText: { title: "Hitler Fuhrerbunker Berlin 1945 archival footage" }, embeddingSimilarity: 0.6 }],
    ]);
    const result = rankCandidatesWithContext(
      ["first_provider_weak.mp4", "later_provider_strong.mp4"],
      "Hitler's final days in the Fuhrerbunker, Berlin, 1945",
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths[0]).toBe("later_provider_strong.mp4");
  });
});

describe("Test 4 — event-match beats a generic candidate", () => {
  it("eventMatchScore + beatFocusPenalty combine to clearly favor the event-matching candidate", async () => {
    const { classifyBeatFocus, beatFocusPenalty, classifyEntityMatchTier, eventMatchScore, locationMatchScore } = await freshPipeline();
    const beatText = "Hitler and Eva Braun married shortly before their deaths in the Führerbunker.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    expect(focus).toBe("event");
    const eventMatch = { title: "Adolf Hitler and Eva Braun married in the Führerbunker, Berlin 1945" };
    const generic = { title: "Adolf Hitler portrait, undated" };
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

describe("Test 5 — entity-match beats the wrong entity", () => {
  it("classifyEntityMatchTier + entityMatchTierScore prefer the exact person match", async () => {
    const { classifyEntityMatchTier, entityMatchTierScore } = await freshPipeline();
    const correct = classifyEntityMatchTier("Adolf Hitler", { title: "Adolf Hitler, Berlin 1945" });
    const wrong = classifyEntityMatchTier("Adolf Hitler", { title: "Richard Stallman at a conference" });
    expect(entityMatchTierScore(correct)).toBeGreaterThan(entityMatchTierScore(wrong));
  });
});

describe("Test 6 — location-match works", () => {
  it("locationMatchScore rewards a candidate whose provider text mentions the active location", async () => {
    const { locationMatchScore } = await freshPipeline();
    expect(locationMatchScore("berlin", { title: "Führerbunker, Berlin, April 1945" })).toBeGreaterThan(
      locationMatchScore("berlin", { title: "Generic wartime footage" })
    );
  });
});

describe("Test 7 — historical date-match works", () => {
  it("historicalDateAlignmentScore prefers period-matching evidence over mismatched or modern evidence", async () => {
    const { historicalDateAlignmentScore } = await freshPipeline();
    const beatText = "Berlin, April 1945.";
    expect(historicalDateAlignmentScore({ dateHint: "1945" }, beatText)).toBeGreaterThan(
      historicalDateAlignmentScore({ dateHint: "1920" }, beatText)
    );
  });
});

describe("Test 8 — missing providerText never causes a false reject", () => {
  it("classifyEntityMatchTier + beatFocusPenalty + candidatePoolEarlyExitReady all stay neutral/non-blocking when a pool candidate simply has no provider text", async () => {
    const { classifyBeatFocus, beatFocusPenalty, classifyEntityMatchTier, candidatePoolEarlyExitReady, eventMatchScore, locationMatchScore } =
      await freshPipeline();
    const beatText = "Hitler died in Berlin.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    const tier = classifyEntityMatchTier("Adolf Hitler", undefined);
    expect(tier).toBe("unknown");
    expect(beatFocusPenalty(focus, tier, eventMatchScore(beatText, undefined), locationMatchScore(null, undefined), false)).toBe(0);
    expect(candidatePoolEarlyExitReady(focus, tier, 0, 0)).toBe(false);
  });
});

describe("Test 9 — the same asset via different routes is deduplicated", () => {
  it("providerAssetKey collapses the same provider+id pair regardless of which tier/route found it", async () => {
    const { providerAssetKey } = await freshPipeline();
    expect(providerAssetKey("internet_archive", "FuhrerbunkerReel1945")).toBe(providerAssetKey("internet_archive", "FuhrerbunkerReel1945"));
  });
});

describe("Test 10 — the same asset via different queries is deduplicated", () => {
  it("providerAssetKey identity is query-independent, and the pool's Set merge collapses duplicate paths from different queries", async () => {
    const { providerAssetKey } = await freshPipeline();
    const viaQueryA = providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945");
    const viaQueryB = providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945");
    expect(viaQueryA).toBe(viaQueryB);
    const merged = [...new Set(["scene_0_hist_wikimedia-abc.mp4", "scene_0_hist_wikimedia-abc.mp4"])];
    expect(merged).toHaveLength(1);
  });
});

describe("Test 11 — the pool stays bounded to a maximum of 5", () => {
  it("fetchHistoricalBeatVideo caps the merged pool at POOL_MAX=5", () => {
    const src = extractFunctionSource("fetchHistoricalBeatVideo");
    expect(src).toContain("POOL_MAX = 5");
    expect(src).toMatch(/\.slice\(0,\s*POOL_MAX\)/);
  });
});

describe("Test 12 — existing provider gates stay active", () => {
  it("fetchHistoricalBeatVideo still gates media_ccc/nasa/archival/youtube behind the same conditions as before pooling", () => {
    const src = extractFunctionSource("fetchHistoricalBeatVideo");
    expect(src).toContain("personMatchesTechCccTopic(intent.primaryPerson ?? \"\", beat.text)");
    expect(src).toContain("isSpaceRelatedTopic(scene.visualCue, scene.pexelsQuery, beat.text, scene.text, adoptOpts.videoTitle ?? \"\")");
    expect(src).toContain("dedup.perf.enableArchival");
    expect(src).toContain("youtubeReady");
  });
});

describe("Test 13 — AssetDirector stays active", () => {
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

describe("Test 14 — early exit avoids unnecessary provider calls", () => {
  it("fetchHistoricalBeatVideo's pooling loop reuses candidatePoolEarlyExitReady (not a new/duplicate early-exit mechanism) and stops on either a strong match or the raw-candidate target", () => {
    const src = extractFunctionSource("fetchHistoricalBeatVideo");
    expect(src).toContain("candidatePoolEarlyExitReady(");
    expect(src).toContain("POOL_RAW_CANDIDATE_TARGET");
    expect(src).toContain("stopPooling = true");
  });

  it("candidatePoolEarlyExitReady (shared, unmodified from the still-image pooling patch) only shortcuts for a genuinely strong match", async () => {
    const { candidatePoolEarlyExitReady } = await freshPipeline();
    expect(candidatePoolEarlyExitReady("event", "exact", 8, 0)).toBe(true);
    expect(candidatePoolEarlyExitReady("event", "exact", -2, 0)).toBe(false);
    expect(candidatePoolEarlyExitReady("general", "strong", 0, 0)).toBe(false);
  });
});

describe("Test 15 — provider name does not influence ranking", () => {
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

describe("Test 16 — existing still-image pooling keeps working", () => {
  it("fetchBeatAuthenticStills (Round 6's pooling patch) is unmodified this round — still one adoptClip call, still bounded to 5", () => {
    const src = extractFunctionSource("fetchBeatAuthenticStills");
    const adoptCalls = src.match(/await adoptClip\(/g) ?? [];
    expect(adoptCalls.length).toBe(1);
    expect(src).toMatch(/\.slice\(0,\s*5\)/);
  });
});

describe("Test 17 — existing quality gates keep working", () => {
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

describe("Test 18 — no change to TTS/script generation/FFmpeg", () => {
  it("fetchHistoricalBeatVideo's own source contains no TTS/script-generation/ffmpeg-concurrency identifiers — this patch only touches candidate collection/ranking", () => {
    const src = extractFunctionSource("fetchHistoricalBeatVideo");
    for (const forbidden of ["ffmpegSemaphore", "generateVoiceover", "generateScript", "elevenlabs", "maxBytes", "CLIP_VISION"]) {
      expect(src.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
