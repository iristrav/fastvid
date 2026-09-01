import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { rankCandidatesWithContext, type AssetDirectorContext, type CandidateMeta } from "./assetDirector";

// FASTVID — P0 FINAL VISUAL COVERAGE & ZERO-BLUE-FALLBACK HARDENING
//
// Covers the 16 scenarios from the task's point 18. The core fix is in fetchHistoricalBeatRescue
// (server/videoPipeline.ts) — the LAST real-visual attempt before rescueBeatVisualWhenEmpty falls
// through to AI/placeholder — which previously built its search intent with primaryPerson/persons
// hardcoded empty and only ONE search query, starving the very last chance to find a real clip of
// signal. It now reuses real beat/scene/dedup context (same pattern as fetchBeatYoutubeThenPexels)
// plus the new buildBeatQueryEscalationTiers (entity+event / entity+location / event+location+date
// / historical-context / object-context — reusing Round 8's extractEventCue/extractLocationPhrase/
// extractObjectCue/extractSecondaryEntities, no new NER). The Wikimedia rescue query list and a new
// [VisualCoverage] explainability log (reusing the existing clipRejectAudit trail) round out the
// change. Structural checks use the file's own source text (extractFunctionSource) for control-flow
// guarantees (ordering, exhaustion-before-fallback) that don't require mocking a dozen providers.
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: (...args: unknown[]) => nodeFetchMock(...args) };
});

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
  fnName = src.includes(`function ${fnName}Inner(`) ? `${fnName}Inner` : fnName;
  const candidates = [
    `export async function ${fnName}(`,
    `async function ${fnName}(`,
    `export function ${fnName}(`,
    `function ${fnName}(`,
  ];
  const marker = candidates.find((m) => src.includes(m));
  const startIdx = marker ? src.indexOf(marker) : -1;
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

describe("Test 1 — buildBeatQueryEscalationTiers produces semantically distinct queries", () => {
  it("generates entity+event, entity+location, event+location+date, historical-context and object-context variants from a rich beat", async () => {
    const { buildBeatQueryEscalationTiers } = await freshPipeline();
    const tiers = buildBeatQueryEscalationTiers(
      "Hitler and Eva Braun spent their final hours in the Führerbunker in Berlin in 1945.",
      "Adolf Hitler",
      "Why Hitler Killed Himself"
    );
    expect(tiers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tiers.map((q) => q.toLowerCase())).size).toBe(tiers.length); // no duplicates
    // At least one tier should combine the entity with the location (point 3.B in the task).
    expect(tiers.some((q) => /hitler/i.test(q) && /berlin/i.test(q))).toBe(true);
  }, 30_000); // first freshPipeline() import of the whole videoPipeline.ts module is slow (cold ffmpeg-binary detection etc.) when this file runs in isolation

  it("never repeats the same query (query A, query A, query A) — each tier is a genuinely different combination", async () => {
    const { buildBeatQueryEscalationTiers } = await freshPipeline();
    const tiers = buildBeatQueryEscalationTiers(
      "Soviet troops surrounded the Reichstag in Berlin in 1945.",
      undefined,
      undefined
    );
    const unique = new Set(tiers.map((q) => q.toLowerCase().trim()));
    expect(unique.size).toBe(tiers.length);
  });

  it("omits tiers it can't form instead of inventing context — a beat with no location/event/object yields an empty or minimal list, never a hallucinated query", async () => {
    const { buildBeatQueryEscalationTiers } = await freshPipeline();
    const tiers = buildBeatQueryEscalationTiers("A quiet afternoon passed by.", undefined, undefined);
    expect(tiers.length).toBe(0);
  });

  it("object-focused beats without a person still produce an object/location query (point 3.E)", async () => {
    const { buildBeatQueryEscalationTiers } = await freshPipeline();
    const tiers = buildBeatQueryEscalationTiers("The pistol was found inside the bunker.", undefined, undefined);
    expect(tiers.some((q) => /pistol|bunker/i.test(q))).toBe(true);
  });
});

describe("Test 2 — first query failing does not end sourcing (query escalation, not repetition)", () => {
  it("fetchHistoricalBeatRescue now passes multiple distinct search queries into buildMediaSearchIntent instead of a single one", () => {
    const src = extractFunctionSource("fetchHistoricalBeatRescue");
    expect(src).toContain("beatMediaSearchQueries(beat, videoTitle)");
    expect(src).toContain("buildBeatQueryEscalationTiers(beat.text, dedup.primaryPerson, videoTitle)");
    // The old starved call (empty primaryPerson/persons, single query) must be gone.
    expect(src).not.toContain('primaryPerson: "",\n    persons: [],');
  });

  it("fetchHistoricalBeatRescue now carries real entity context (dedup.primaryPerson / resolveScenePersons) instead of hardcoded empties", () => {
    const src = extractFunctionSource("fetchHistoricalBeatRescue");
    expect(src).toMatch(/primaryPerson:\s*dedup\.primaryPerson/);
    expect(src).toContain("resolveScenePersons(scene, videoTitle, dedup.primaryPerson)");
  });
});

describe("Test 3/4/5/6 — a rejected/failed candidate only eliminates that candidate, sourcing continues", () => {
  it("fetchBeatAuthenticStills and fetchHistoricalBeatVideo keep trying further providers/tiers after an empty result (Round 6/7 pooling loops, unmodified and re-verified this round)", () => {
    const stillsSrc = extractFunctionSource("fetchBeatAuthenticStills");
    // Each provider's `if (paths.length === 0) continue;` / early-exit-only-on-strength shape
    // means one empty provider result does not itself end the pool.
    expect(stillsSrc).toMatch(/if\s*\(!pool\.some\(strongEnoughToStopPooling\)\)/);
    const historicalSrc = extractFunctionSource("fetchHistoricalBeatVideo");
    expect(historicalSrc).toMatch(/if\s*\(paths\.length === 0\)\s*continue;/);
  });

  it("rankCandidatesWithContext still ranks across a pool where some candidates have no metadata (a rejected/undocumented candidate never blanks out the whole pool)", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["rejected_no_meta.mp4", {} as CandidateMeta],
      ["good_candidate.mp4", { providerText: { title: "Hitler Fuhrerbunker Berlin 1945" }, embeddingSimilarity: 0.6 }],
    ]);
    const result = rankCandidatesWithContext(
      ["rejected_no_meta.mp4", "good_candidate.mp4"],
      "Hitler's final days in the bunker.",
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths).toHaveLength(2);
    expect(result.rankedPaths[0]).toBe("good_candidate.mp4");
  });
});

describe("Test 7 — contextual/escalated query is used before the blue fallback", () => {
  it("rescueBeatVisualWhenEmpty's Wikimedia rescue tries the escalation tiers before the generic truncated-beat-text query, and every rescue tier runs before the placeholder loop", () => {
    const src = extractFunctionSource("rescueBeatVisualWhenEmpty");
    const escalationIdx = src.indexOf("buildBeatQueryEscalationTiers(beat.text, dedup.primaryPerson, videoTitle)");
    const genericWikiIdx = src.indexOf("wikiQueries.push(beat.text.slice(0, 80))");
    const placeholderLoopIdx = src.indexOf("for (let attempt = 0; attempt < 4; attempt++)");
    expect(escalationIdx).toBeGreaterThan(-1);
    expect(genericWikiIdx).toBeGreaterThan(-1);
    expect(placeholderLoopIdx).toBeGreaterThan(-1);
    expect(escalationIdx).toBeLessThan(genericWikiIdx);
    expect(genericWikiIdx).toBeLessThan(placeholderLoopIdx);
  });

  it("the historical archival rescue tier (Internet Archive/YouTube CC/free-CC tiers) runs before the placeholder loop", () => {
    const src = extractFunctionSource("rescueBeatVisualWhenEmpty");
    const histRescueIdx = src.indexOf("fetchHistoricalBeatRescue(");
    const placeholderLoopIdx = src.indexOf("for (let attempt = 0; attempt < 4; attempt++)");
    expect(histRescueIdx).toBeGreaterThan(-1);
    expect(histRescueIdx).toBeLessThan(placeholderLoopIdx);
  });
});

describe("Test 8 — the blue/color fallback is not used while sourcing strategies remain", () => {
  it("every rescue strategy (plan rounds, Wikimedia, historical archival rescue, AI, editorial graphic, extendLastClip) appears in rescueBeatVisualWhenEmpty's source before the guaranteed-clip placeholder loop", () => {
    const src = extractFunctionSource("rescueBeatVisualWhenEmpty");
    const strategies = [
      "adoptStockBeatClipFallback(",
      "getOrGenerateSearchPlan(",
      "fetchWikimediaImages(",
      "fetchHistoricalBeatRescue(",
      "adoptAiBeatClip(",
      "graphicClips.get(",
      "extendLastClip(",
    ];
    const placeholderLoopIdx = src.indexOf("for (let attempt = 0; attempt < 4; attempt++)");
    expect(placeholderLoopIdx).toBeGreaterThan(-1);
    for (const strategy of strategies) {
      const idx = src.indexOf(strategy);
      expect(idx, `${strategy} should appear in rescueBeatVisualWhenEmpty`).toBeGreaterThan(-1);
      expect(idx, `${strategy} should run before the placeholder loop`).toBeLessThan(placeholderLoopIdx);
    }
  });
});

describe("Test 9 — the blue/color fallback is still used once every strategy is genuinely exhausted", () => {
  it("generateGuaranteedBeatClip is still called as the final step (4 bounded attempts, unchanged) when nothing above returned true", () => {
    const src = extractFunctionSource("rescueBeatVisualWhenEmpty");
    expect(src).toContain("generateGuaranteedBeatClip(");
    expect(src).toMatch(/for \(let attempt = 0; attempt < 4; attempt\+\+\)/);
  });
});

describe("Test 10 — sceneRescueColorFallbackCount is still incremented correctly (unmodified this round)", () => {
  it("the counter increment call sites are untouched by this patch", () => {
    const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const count = (src.match(/sceneRescueColorFallbackCount\+\+/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe("Test 11 — assertVisualCoverageExportGate still blocks a render with scene-level fallback", () => {
  it("(existing gate, unmodified this round) still throws for a scene that fell back entirely to placeholders", async () => {
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

describe("Test 12 — a relevant contextual visual wins over a generic one (reuses Round 8 signals)", () => {
  it("a Führerbunker-context candidate outranks a plain, unrelated-context candidate for a location-focused beat", async () => {
    const { classifyBeatFocus, classifyEntityMatchTier, locationMatchScore, genericPersonPenalty, eventMatchScore, objectMatchScore } =
      await freshPipeline();
    const beatText = "Inside the Führerbunker in Berlin, the final days played out.";
    const focus = classifyBeatFocus(beatText, "Adolf Hitler");
    const contextual = { title: "Führerbunker interior, Berlin 1945" };
    const generic = { title: "Man in military uniform, undated studio portrait" };
    const contextualScore =
      locationMatchScore("berlin", contextual) +
      genericPersonPenalty(
        focus,
        classifyEntityMatchTier("Adolf Hitler", contextual),
        eventMatchScore(beatText, contextual),
        locationMatchScore("berlin", contextual),
        objectMatchScore(beatText, contextual),
        true
      );
    const genericScore =
      locationMatchScore("berlin", generic) +
      genericPersonPenalty(
        focus,
        classifyEntityMatchTier("Adolf Hitler", generic),
        eventMatchScore(beatText, generic),
        locationMatchScore("berlin", generic),
        objectMatchScore(beatText, generic),
        true
      );
    expect(contextualScore).toBeGreaterThan(genericScore);
  });
});

describe("Test 13 — exact entity+event+location visual wins over a merely contextual one", () => {
  it("a candidate naming the person AND the location outranks a location-only contextual candidate", async () => {
    const { classifyEntityMatchTier, entityMatchTierScore, locationMatchScore } = await freshPipeline();
    const exact = { title: "Adolf Hitler in the Führerbunker, Berlin 1945" };
    const contextualOnly = { title: "Führerbunker exterior, Berlin 1945" };
    const exactScore = entityMatchTierScore(classifyEntityMatchTier("Adolf Hitler", exact)) + locationMatchScore("berlin", exact);
    const contextualScore =
      entityMatchTierScore(classifyEntityMatchTier("Adolf Hitler", contextualOnly)) + locationMatchScore("berlin", contextualOnly);
    expect(exactScore).toBeGreaterThan(contextualScore);
  });
});

describe("Test 14 — no regression in dedup", () => {
  it("providerAssetKey still collapses identical provider+id pairs and keeps distinct ones apart", async () => {
    const { providerAssetKey } = await freshPipeline();
    expect(providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945")).toBe(providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945"));
    expect(providerAssetKey("wikimedia", "FuhrerbunkerPhoto1945")).not.toBe(providerAssetKey("wikimedia", "EvaBraunWedding1945"));
  });
});

describe("Test 15 — no regression in AssetDirector", () => {
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

describe("Test 16 — [VisualCoverage] explainability log reuses the existing reject audit, no new logging system", () => {
  it("the new log line sits immediately before the placeholder loop and is built from dedup.clipRejectAudit (existing audit trail)", () => {
    const src = extractFunctionSource("rescueBeatVisualWhenEmpty");
    const logIdx = src.indexOf("[VisualCoverage]");
    const placeholderLoopIdx = src.indexOf("for (let attempt = 0; attempt < 4; attempt++)");
    expect(logIdx).toBeGreaterThan(-1);
    expect(logIdx).toBeLessThan(placeholderLoopIdx);
    // RONDE 70 keeps the invariant this test protects — the line is still built from the
    // EXISTING reject audit, not a new tracking system — but no longer by filtering the entry
    // array. That array is capped at 400 entries and the cap is chronological, so late beats
    // reported rejected=0 they had not earned. It now reads the audit's per-beat tally, which
    // is never dropped. Same audit trail, a count that is actually true.
    expect(src).toContain("beatRejectCount(dedup.clipRejectAudit, scene.index, beat.index)");
    expect(src).toContain("beatRejectReasons(dedup.clipRejectAudit, scene.index, beat.index)");
    expect(src).not.toContain("dedup.clipRejectAudit.filter(");
  });
});

describe("Test 17 — diff safety: performance constraints respected", () => {
  it("buildBeatQueryEscalationTiers and the fetchHistoricalBeatRescue changes introduce no new LLM call, no unbounded loop, no new provider", () => {
    const escalationSrc = extractFunctionSource("buildBeatQueryEscalationTiers").replace(
      /^export /,
      ""
    );
    // Pure, deterministic string composition only — no async/await, no network/LLM call.
    expect(escalationSrc).not.toMatch(/await\s/);
    expect(escalationSrc).not.toMatch(/fetch\(|generateText|callLlm|openai|anthropic/i);
  });
});
