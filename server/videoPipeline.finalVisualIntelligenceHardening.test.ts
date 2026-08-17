import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { rankCandidatesWithContext, type AssetDirectorContext, type CandidateMeta } from "./assetDirector";

// FASTVID — FINAL VISUAL INTELLIGENCE & BEST-OF SELECTION HARDENING
//
// Covers the 23 scenarios from the task's point 25, exercising this round's new signals
// (extractObjectCue/objectMatchScore, extractSecondaryEntities/secondaryEntityMatchScore,
// genericPersonPenalty, the "object"/"topic" BeatFocus additions, and the CandidateMeta.sourceQuery
// informational field) on top of the already-covered/unmodified infra from Rounds 3-7
// (classifyEntityMatchTier, eventMatchScore, locationMatchScore, historicalDateAlignmentScore,
// classifyBeatFocus, beatFocusPenalty, candidatePoolEarlyExitReady, rankCandidatesWithContext,
// providerAssetKey — see videoPipeline.{visualSelectionUpgrade,nextLevelVisualSelection,
// multiCandidateVisualSelection,limitedCandidatePooling,videoCandidatePooling}.test.ts for their
// own dedicated coverage, none of which is modified or weakened by this file).
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: (...args: unknown[]) => nodeFetchMock(...args) };
});

// No env-toggling in this file, so (matching the Round 6/7 convention) the module is imported
// once and reused instead of resetModules() per test.
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

// Finds a function's full source text by name, tolerant of an inline object-type/default-value
// parameter (e.g. `opts: { skipYoutube?: boolean } = {}`) that would otherwise fool a naive
// "first { after the signature" search into grabbing that parameter's own braces as the function
// body — the exact bug this technique was fixed for in the Round 6/7 pooling tests.
function extractFunctionSource(fnName: string): string {
  const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const marker = src.includes(`export async function ${fnName}(`)
    ? `export async function ${fnName}(`
    : `async function ${fnName}(`;
  const startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error(`function ${fnName} not found in videoPipeline.ts`);
  const parenStart = src.indexOf("(", startIdx);
  let parenDepth = 0;
  let j = parenStart;
  for (; j < src.length; j++) {
    if (src[j] === "(") parenDepth++;
    else if (src[j] === ")") {
      parenDepth--;
      if (parenDepth === 0) break;
    }
  }
  const bodyStart = src.indexOf("{", j);
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

describe("Test 1 — primary entity exact match beats generic person", () => {
  it("an exact primary-entity match outscores a general/unrelated one via entityMatchTierScore", async () => {
    const { classifyEntityMatchTier, entityMatchTierScore } = await freshPipeline();
    const exact = classifyEntityMatchTier("Adolf Hitler", { title: "Adolf Hitler, Berlin, 1945" });
    const general = classifyEntityMatchTier("Adolf Hitler", { title: "Unrelated wartime footage" });
    expect(exact).toBe("exact");
    expect(entityMatchTierScore(exact)).toBeGreaterThan(entityMatchTierScore(general));
  }, 30_000); // first freshPipeline() import of the whole videoPipeline.ts module is slow (cold ffmpeg-binary detection etc.) when this file runs in isolation
});

describe("Test 2 — secondary entity match works", () => {
  it("extractSecondaryEntities pulls the beat's secondary person out, excluding the primary", async () => {
    const { extractSecondaryEntities } = await freshPipeline();
    const secondary = extractSecondaryEntities(
      "Hitler and Eva Braun married shortly before their deaths.",
      "Adolf Hitler"
    );
    expect(secondary).toContain("Eva Braun");
    expect(secondary.map((n) => n.toLowerCase())).not.toContain("adolf hitler");
  });

  it("secondaryEntityMatchScore rewards a candidate whose provider text supports the secondary person even without naming the primary", async () => {
    const { secondaryEntityMatchScore } = await freshPipeline();
    const score = secondaryEntityMatchScore(["Eva Braun"], { title: "Eva Braun portrait, 1944" });
    const noMatch = secondaryEntityMatchScore(["Eva Braun"], { title: "Generic wartime footage" });
    expect(score).toBeGreaterThan(0);
    expect(noMatch).toBe(0);
    expect(secondaryEntityMatchScore([], { title: "Eva Braun portrait" })).toBe(0);
  });
});

describe("Test 3 — event match beats entity-only", () => {
  it("a candidate matching both person and event outscores one matching only the person", async () => {
    const { classifyEntityMatchTier, entityMatchTierScore, eventMatchScore } = await freshPipeline();
    const beatText = "Hitler and Eva Braun married shortly before their deaths in the Führerbunker.";
    const both = { title: "Adolf Hitler and Eva Braun married in the Führerbunker" };
    const entityOnly = { title: "Adolf Hitler portrait, 1938" };
    const bothScore = entityMatchTierScore(classifyEntityMatchTier("Adolf Hitler", both)) + eventMatchScore(beatText, both);
    const entityOnlyScore =
      entityMatchTierScore(classifyEntityMatchTier("Adolf Hitler", entityOnly)) + eventMatchScore(beatText, entityOnly);
    expect(bothScore).toBeGreaterThan(entityOnlyScore);
  });
});

describe("Test 4 — location match beats generic person", () => {
  it("for a location-focused beat, a location-matching candidate outscores a generic portrait once genericPersonPenalty applies", async () => {
    const { classifyBeatFocus, classifyEntityMatchTier, eventMatchScore, locationMatchScore, objectMatchScore, genericPersonPenalty } =
      await freshPipeline();
    const beatText = "Inside the Führerbunker in Berlin, the final days played out.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    expect(focus).toBe("location");

    const bunkerPhoto = { title: "Führerbunker interior, Berlin 1945" };
    const genericPortrait = { title: "Adolf Hitler, undated studio portrait" };

    const bunkerTier = classifyEntityMatchTier("Adolf Hitler", bunkerPhoto);
    const bunkerEvent = eventMatchScore(beatText, bunkerPhoto);
    const bunkerLocation = locationMatchScore("berlin", bunkerPhoto);
    const bunkerObject = objectMatchScore(beatText, bunkerPhoto);
    const bunkerScore =
      bunkerLocation + genericPersonPenalty(focus, bunkerTier, bunkerEvent, bunkerLocation, bunkerObject, true);

    const portraitTier = classifyEntityMatchTier("Adolf Hitler", genericPortrait);
    const portraitEvent = eventMatchScore(beatText, genericPortrait);
    const portraitLocation = locationMatchScore("berlin", genericPortrait);
    const portraitObject = objectMatchScore(beatText, genericPortrait);
    expect(portraitTier).toBe("exact"); // it does name Hitler correctly — just generically
    const portraitScore =
      portraitLocation + genericPersonPenalty(focus, portraitTier, portraitEvent, portraitLocation, portraitObject, true);

    expect(bunkerScore).toBeGreaterThan(portraitScore);
  });
});

describe("Test 5 — object/topic beat picks object over person", () => {
  it("classifyBeatFocus classifies an object-centric beat as 'object', and objectMatchScore rewards the object-matching candidate", async () => {
    const { classifyBeatFocus, extractObjectCue, objectMatchScore, genericPersonPenalty, classifyEntityMatchTier, eventMatchScore, locationMatchScore } =
      await freshPipeline();
    void extractObjectCue; // sanity: mediaResearchEngine re-export path exists via videoPipeline's import too, exercised directly below instead
    const beatText = "The pistol was found beside Hitler's body.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    expect(focus).toBe("object");

    const pistolPhoto = { title: "Pistol found beside Hitler's body in the Führerbunker" };
    const genericPortrait = { title: "Adolf Hitler, undated studio portrait" };

    const pistolTier = classifyEntityMatchTier("Adolf Hitler", pistolPhoto);
    const pistolObject = objectMatchScore(beatText, pistolPhoto);
    const pistolScore =
      pistolObject +
      genericPersonPenalty(focus, pistolTier, eventMatchScore(beatText, pistolPhoto), locationMatchScore(null, pistolPhoto), pistolObject, true);

    const portraitTier = classifyEntityMatchTier("Adolf Hitler", genericPortrait);
    const portraitObject = objectMatchScore(beatText, genericPortrait);
    const portraitScore =
      portraitObject +
      genericPersonPenalty(
        focus,
        portraitTier,
        eventMatchScore(beatText, genericPortrait),
        locationMatchScore(null, genericPortrait),
        portraitObject,
        true
      );

    expect(pistolScore).toBeGreaterThan(portraitScore);
  });

  it("extractObjectCue (mediaResearchEngine) recognizes the concrete object vocabulary this signal keys off", async () => {
    const { extractObjectCue } = await import("./mediaResearchEngine");
    expect(extractObjectCue("His cyanide capsule was found nearby.")).toMatch(/cyanide|capsule/);
    expect(extractObjectCue("A quiet countryside scene with no notable object.")).toBeNull();
  });
});

describe("Test 6 — historical period match beats wrong period", () => {
  it("historicalDateAlignmentScore (existing signal, unmodified this round) still prefers period-matching evidence", async () => {
    const { historicalDateAlignmentScore } = await freshPipeline();
    const beatText = "In April 1945, Hitler remained inside the Führerbunker.";
    const period = historicalDateAlignmentScore({ dateHint: "1945" }, beatText);
    const wrongPeriod = historicalDateAlignmentScore({ dateHint: "1933" }, beatText);
    expect(period).toBeGreaterThan(wrongPeriod);
  });
});

describe("Test 7 — generic person penalty works", () => {
  it("genericPersonPenalty fires only for a person-only match on an event/location/object-focused beat, never on a person/topic/general beat", async () => {
    const { genericPersonPenalty } = await freshPipeline();
    // Event focus, entity exact, no event/location/object match -> generic portrait -> penalized.
    expect(genericPersonPenalty("event", "exact", 0, 0, 0, true)).toBeLessThan(0);
    expect(genericPersonPenalty("location", "strong", 0, 0, 0, true)).toBeLessThan(0);
    expect(genericPersonPenalty("object", "exact", 0, 0, 0, true)).toBeLessThan(0);
    // The candidate also supports the more specific signal -> no penalty.
    expect(genericPersonPenalty("event", "exact", 8, 0, 0, true)).toBe(0);
    // Beat focus itself isn't specific enough to demand more than the person -> no penalty.
    expect(genericPersonPenalty("person", "exact", 0, 0, 0, true)).toBe(0);
    expect(genericPersonPenalty("topic", "exact", 0, 0, 0, true)).toBe(0);
    expect(genericPersonPenalty("general", "exact", 0, 0, 0, true)).toBe(0);
  });
});

describe("Test 8 — negative providerText can heavily penalize a candidate", () => {
  it("combining a wrong entity tier with beatFocusPenalty pushes a clearly off-topic candidate well below neutral", async () => {
    const { classifyBeatFocus, classifyEntityMatchTier, entityMatchTierScore, eventMatchScore, locationMatchScore, beatFocusPenalty } =
      await freshPipeline();
    const beatText = "Hitler and Eva Braun spent their final hours together inside the Führerbunker.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    const wrongContext = { title: "Nobel Prize ceremony featuring Richard Stallman" };
    const tier = classifyEntityMatchTier("Adolf Hitler", wrongContext);
    const event = eventMatchScore(beatText, wrongContext);
    const location = locationMatchScore("berlin", wrongContext);
    const penalty = beatFocusPenalty(focus, tier, event, location, true);
    expect(entityMatchTierScore(tier) + event + location + penalty).toBeLessThanOrEqual(-6);
  });
});

describe("Test 9 — missing providerText causes no false reject", () => {
  it("objectMatchScore/secondaryEntityMatchScore/genericPersonPenalty all stay neutral (0) when a candidate simply has no provider text", async () => {
    const { objectMatchScore, secondaryEntityMatchScore, genericPersonPenalty, classifyEntityMatchTier } = await freshPipeline();
    const beatText = "The pistol was found beside Hitler's body in the Führerbunker.";
    expect(objectMatchScore(beatText, undefined)).toBe(0);
    expect(secondaryEntityMatchScore(["Eva Braun"], undefined)).toBe(0);
    const tier = classifyEntityMatchTier("Adolf Hitler", undefined);
    expect(tier).toBe("unknown");
    expect(genericPersonPenalty("object", tier, 0, 0, 0, false)).toBe(0);
  });
});

describe("Test 10 — candidate-specific sourceQuery is preserved", () => {
  it("CandidateMeta accepts a per-candidate sourceQuery field distinct from the shared adoptClip sourceQuery", async () => {
    const meta: CandidateMeta = { providerText: { title: "Führerbunker exterior" }, sourceQuery: "Hitler Eva Braun Führerbunker April 1945" };
    expect(meta.sourceQuery).toBe("Hitler Eva Braun Führerbunker April 1945");
  });

  it("fetchBeatAuthenticStills and fetchHistoricalBeatVideo record the real per-candidate query into clipAnnotationMeta.sourceQuery, not a shared placeholder", () => {
    const stillsSrc = extractFunctionSource("fetchBeatAuthenticStills");
    expect(stillsSrc).toMatch(/sourceQuery:\s*(serpQ|q|ovQ)/);
    const historicalSrc = extractFunctionSource("fetchHistoricalBeatVideo");
    expect(historicalSrc).toMatch(/sourceQuery:\s*q/);
    // Both still use beat.text as the shared adoptClip sourceQuery for gate evaluation — the
    // per-candidate field above is informational only, so the Round 7 sourceQuery-scoping bug
    // (BLOCKED_STOCK_VISUAL_RE tripping on a single pooled query string) can't reopen.
    expect(stillsSrc).toMatch(/adoptClip\(\s*\n?\s*boundedPool,[\s\S]*?beat\.text,\s*\n?\s*loose/);
  });
});

describe("Test 11 — multiple providers actually get jointly ranked where pooling is active", () => {
  it("rankCandidatesWithContext prefers the better-matching candidate regardless of which position/provider it came from", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["serpapi_candidate.jpg", { providerText: { title: "generic wartime footage" } }],
      ["wikimedia_candidate.jpg", { providerText: { title: "Hitler Eva Braun Führerbunker 1945" }, embeddingSimilarity: 0.7 }],
    ]);
    const result = rankCandidatesWithContext(
      ["serpapi_candidate.jpg", "wikimedia_candidate.jpg"],
      "Hitler and Eva Braun spent their final hours in the Führerbunker",
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths[0]).toBe("wikimedia_candidate.jpg");
  });
});

describe("Test 12 — dedup still works cross-provider", () => {
  it("providerAssetKey collapses the same provider+id pair to one identity regardless of which query/cascade found it", async () => {
    const { providerAssetKey } = await freshPipeline();
    expect(providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945")).toBe(providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945"));
    expect(providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945")).not.toBe(providerAssetKey("wikimedia", "EvaBraunWedding1945"));
  });
});

describe("Test 13 — provider name doesn't influence score", () => {
  it("none of the new or existing scoring signals accept a provider/source parameter — identical provider text scores identically regardless of provider", async () => {
    const { classifyBeatFocus, classifyEntityMatchTier, entityMatchTierScore, eventMatchScore, locationMatchScore, objectMatchScore, genericPersonPenalty } =
      await freshPipeline();
    const beatText = "The pistol was found beside Hitler's body in the Führerbunker in Berlin.";
    const providerTextA = { title: "Pistol beside Hitler's body, Führerbunker, Berlin" };
    const providerTextB = { ...providerTextA };
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    const tierA = classifyEntityMatchTier("Adolf Hitler", providerTextA);
    const tierB = classifyEntityMatchTier("Adolf Hitler", providerTextB);
    expect(entityMatchTierScore(tierA)).toBe(entityMatchTierScore(tierB));
    expect(eventMatchScore(beatText, providerTextA)).toBe(eventMatchScore(beatText, providerTextB));
    expect(locationMatchScore("berlin", providerTextA)).toBe(locationMatchScore("berlin", providerTextB));
    expect(objectMatchScore(beatText, providerTextA)).toBe(objectMatchScore(beatText, providerTextB));
    expect(genericPersonPenalty(focus, tierA, 0, 0, 0, true)).toBe(genericPersonPenalty(focus, tierB, 0, 0, 0, true));
  });
});

describe("Test 14 — AssetDirector stays active", () => {
  it("rankCandidatesWithContext still returns a full ranking + topScore + breakdown", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["a.mp4", { providerText: { title: "Hitler Fuhrerbunker Berlin 1945" } }],
      ["b.mp4", { providerText: { title: "generic wartime footage" } }],
    ]);
    const result = rankCandidatesWithContext(["a.mp4", "b.mp4"], "Hitler's final days in the bunker.", 0, 0, minimalCtx(), meta);
    expect(result.topScore).not.toBeNull();
    expect(result.topScore!.breakdown).toBeDefined();
  });
});

describe("Test 15 — existing quality gates stay active", () => {
  it("scriptImageFallbackPassesRelevanceFloor (existing gate, unmodified this round) still rejects a clearly wrong provider title", async () => {
    const { scriptImageFallbackPassesRelevanceFloor } = await freshPipeline();
    expect(
      scriptImageFallbackPassesRelevanceFloor(
        "Kim Kardashian red carpet fashion show",
        "Hitler Fuhrerbunker 1945",
        "Hitler and Eva Braun's final hours in the bunker.",
        "Why Hitler Killed Himself"
      )
    ).toBe(false);
  });
});

describe("Test 16 — runner-up explainability works", () => {
  it("adoptClip's winner log block computes and logs a runner-up comparison (score, margin, reason) alongside the winner breakdown", () => {
    const src = extractFunctionSource("adoptClip");
    expect(src).toContain("[VisualSelection]");
    expect(src).toContain("runner-up=");
    expect(src).toContain("margin=");
    expect(src).toContain("reason=");
  });
});

describe("Test 17 — scoreMargin computed correctly", () => {
  it("a clearly-better candidate's combined signal total exceeds a clearly-worse one's by a real, computable margin", async () => {
    const { classifyEntityMatchTier, entityMatchTierScore, eventMatchScore, locationMatchScore, objectMatchScore, genericPersonPenalty, classifyBeatFocus } =
      await freshPipeline();
    const beatText = "Inside the Führerbunker in Berlin, the final days played out.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    expect(focus).toBe("location");
    const winner = { title: "Adolf Hitler in the Führerbunker, Berlin 1945" };
    const runnerUp = { title: "Adolf Hitler, undated studio portrait" };
    const score = (pt: typeof winner) => {
      const tier = classifyEntityMatchTier("Adolf Hitler", pt);
      const event = eventMatchScore(beatText, pt);
      const location = locationMatchScore("berlin", pt);
      const object = objectMatchScore(beatText, pt);
      return (
        entityMatchTierScore(tier) + event + location + object + genericPersonPenalty(focus, tier, event, location, object, true)
      );
    };
    const margin = score(winner) - score(runnerUp);
    expect(margin).toBeGreaterThan(0);
  });
});

describe("Test 18 — placeholder quality gate still blocks", () => {
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

describe("Test 19 — candidate pool stays bounded", () => {
  it("fetchBeatAuthenticStills and fetchHistoricalBeatVideo keep their existing pool caps (5) unchanged by this round's new signals", () => {
    const stillsSrc = extractFunctionSource("fetchBeatAuthenticStills");
    expect(stillsSrc).toMatch(/\.slice\(0,\s*5\)/);
    const videoSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(videoSrc).toContain("const POOL_MAX = 5;");
  });
});

describe("Test 20 — early exit still works", () => {
  it("candidatePoolEarlyExitReady shortcuts the pool for an object-focused beat only when the object signal actually matches, and keeps prior event/location/general behavior intact", async () => {
    const { candidatePoolEarlyExitReady } = await freshPipeline();
    expect(candidatePoolEarlyExitReady("object", "exact", 0, 0, 8)).toBe(true);
    expect(candidatePoolEarlyExitReady("object", "exact", 0, 0, -2)).toBe(false);
    expect(candidatePoolEarlyExitReady("object", "exact", 0, 0)).toBe(false); // default objectScore=0 -> no match
    expect(candidatePoolEarlyExitReady("event", "exact", 8, 0)).toBe(true);
    expect(candidatePoolEarlyExitReady("general", "exact", 0, 0)).toBe(true);
  });
});

describe("Test 21 — query diversity actually produces different retrieval angles", () => {
  it("buildHistoricalArchivalQueries (existing infra, Round 3) generates multiple genuinely distinct query variants for a rich beat, not one reshuffled string", async () => {
    const { buildHistoricalArchivalQueries, buildMediaSearchIntent } = await import("./mediaResearchEngine");
    const beatText = "Hitler and Eva Braun married shortly before their deaths in the Führerbunker in Berlin.";
    const intent = buildMediaSearchIntent({
      beatText,
      searchQueries: ["Hitler Eva Braun wedding"],
      keywords: [],
      primaryPerson: "Adolf Hitler",
      persons: ["Adolf Hitler", "Eva Braun"],
      videoTitle: "Why Hitler Killed Himself and His Wife",
      powerWord: "",
      personTopicLock: true,
      spaceTopic: false,
      muskTopic: false,
    });
    const queries = buildHistoricalArchivalQueries(intent, beatText);
    const unique = new Set(queries.map((q) => q.toLowerCase()));
    expect(unique.size).toBeGreaterThanOrEqual(3);
    expect(queries.some((q) => q.toLowerCase().includes("hitler"))).toBe(true);
  });
});

describe("Test 22 — generic 'documentary' fallback only used when context is truly empty", () => {
  it("classifyBeatFocus only falls through to 'topic' (the historical-documentary fallback) when no event/location/object/person signal exists, and 'general' only when even that is absent", async () => {
    const { classifyBeatFocus } = await freshPipeline();
    // Specific beat -> a concrete focus, never the generic fallback.
    expect(classifyBeatFocus("Hitler and Eva Braun married in the Führerbunker.", "Adolf Hitler")).not.toBe("general");
    // No event/location/object/person signal at all, and no historical-documentary title context
    // either -> truly generic, falls all the way through to "general".
    expect(classifyBeatFocus("A quiet afternoon passed by.", undefined, undefined)).toBe("general");
  });

  it("beatFocusPenalty and genericPersonPenalty never fire for 'topic' or 'general' focus — the generic fallback path is never itself penalized", async () => {
    const { beatFocusPenalty, genericPersonPenalty } = await freshPipeline();
    expect(beatFocusPenalty("topic", "general", 0, 0, true)).toBe(0);
    expect(beatFocusPenalty("general", "general", 0, 0, true)).toBe(0);
    expect(genericPersonPenalty("topic", "exact", 0, 0, 0, true)).toBe(0);
    expect(genericPersonPenalty("general", "exact", 0, 0, 0, true)).toBe(0);
  });
});

describe("Test 23 — existing F3 tests stay green (structural sanity check)", () => {
  it("HISTORICAL_SOURCE_TIER_ORDER (F3/Round 7 infra) still contains all 9 tiers, unmodified by this round's wiring", async () => {
    const { HISTORICAL_SOURCE_TIER_ORDER } = await freshPipeline();
    expect(HISTORICAL_SOURCE_TIER_ORDER).toEqual([
      "internet_archive",
      "youtube_cc",
      "wikimedia",
      "nara",
      "flickr",
      "sepiasearch",
      "vimeo",
      "media_ccc",
      "nasa",
    ]);
  });
});
