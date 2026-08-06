import { describe, expect, it } from "vitest";
import { buildAttentionRecommendations, buildHookGuidance, buildRetentionRisk, HOOK_WINDOW_SEC } from "./attentionManager";
import type { DirectorContext, DirectorDecision } from "./types";
import type { VisualIntent } from "../visualMatchingV2/types";
import type { Scene } from "../pipeline/types";

function makeIntent(overrides: Partial<VisualIntent> = {}): VisualIntent {
  return {
    beatId: "b0",
    spokenText: "text",
    visualSubject: "Apple",
    visualAction: "",
    visualLocation: "",
    visualTime: "present day",
    historicalContext: "",
    emotion: "",
    visualDescription: "",
    primaryKeyword: "",
    secondaryKeyword: "",
    negativeKeywords: [],
    secondaryVisualSubjects: [],
    objects: [],
    brands: [],
    companies: [],
    people: [],
    countries: [],
    events: [],
    intentHash: "hash",
    cacheHit: false,
    ...overrides,
  };
}

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return { index: 2, text: "text", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 10, ...overrides };
}

function makeDecision(overrides: Partial<DirectorDecision> = {}): DirectorDecision {
  return {
    sceneIndex: 0,
    primarySubject: "Apple",
    secondarySubject: null,
    narrativeFunction: "explain",
    narrativePurpose: "test",
    emotion: "neutral",
    visualStrategy: "b_roll",
    supportingVisuals: [],
    shotOrder: [],
    pacing: "medium",
    energyTrend: "steady",
    transitionStyle: "cut",
    textOverlaySuggestion: null,
    soundCueSuggestion: null,
    attentionRecommendations: [],
    hookGuidance: { isHookSegment: false, recommendations: [], reason: "test" },
    retentionRisk: { isAtRisk: false, reason: "test", recommendations: [] },
    reason: "test",
    ...overrides,
  };
}

function makeContext(overrides: Partial<DirectorContext> = {}): DirectorContext {
  return {
    scene: makeScene(),
    beatIntents: [makeIntent()],
    sceneIndex: 2,
    totalScenes: 6,
    sceneStartSec: 60,
    sceneDurationSec: 10,
    totalVideoDurationSec: 60,
    previousDecisions: [],
    ...overrides,
  };
}

describe("buildAttentionRecommendations", () => {
  it("recommends change_shot_type when the same visual strategy repeats twice in a row", () => {
    const context = makeContext({
      previousDecisions: [makeDecision({ visualStrategy: "archive_footage" }), makeDecision({ visualStrategy: "archive_footage" })],
    });
    const recs = buildAttentionRecommendations(context, "explain", "archive_footage", "medium");
    expect(recs.some((r) => r.type === "change_shot_type")).toBe(true);
  });

  it("recommends introduce_contrast after three consecutive slow scenes", () => {
    const context = makeContext({
      previousDecisions: [makeDecision({ pacing: "slow" }), makeDecision({ pacing: "slow" })],
    });
    const recs = buildAttentionRecommendations(context, "explain", "b_roll", "slow");
    expect(recs.some((r) => r.type === "introduce_contrast")).toBe(true);
  });

  it("recommends insert_supporting_visual for a long, plain explanatory scene", () => {
    // avg = 60/6 = 10s; a 15s scene is 1.5x -> long
    const context = makeContext({ sceneDurationSec: 15 });
    const recs = buildAttentionRecommendations(context, "explain", "b_roll", "slow");
    expect(recs.some((r) => r.type === "insert_supporting_visual")).toBe(true);
  });

  it("recommends increase_energy when the previous scene's energy was decreasing", () => {
    const context = makeContext({ previousDecisions: [makeDecision({ energyTrend: "decreasing" })] });
    const recs = buildAttentionRecommendations(context, "explain", "b_roll", "medium");
    expect(recs.some((r) => r.type === "increase_energy")).toBe(true);
  });

  it("returns no recommendations when nothing is repetitive or at risk", () => {
    const context = makeContext({ sceneDurationSec: 10 });
    const recs = buildAttentionRecommendations(context, "climax", "chart", "fast");
    expect(recs).toEqual([]);
  });

  it("every recommendation carries a non-empty reason (NO RANDOMNESS requirement)", () => {
    const context = makeContext({
      previousDecisions: [makeDecision({ visualStrategy: "archive_footage" }), makeDecision({ visualStrategy: "archive_footage" })],
    });
    const recs = buildAttentionRecommendations(context, "explain", "archive_footage", "medium");
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe("buildHookGuidance", () => {
  it("flags a scene inside the first 30 seconds as a hook segment with recommendations", () => {
    const guidance = buildHookGuidance(makeContext({ sceneStartSec: 10 }));
    expect(guidance.isHookSegment).toBe(true);
    expect(guidance.recommendations.length).toBeGreaterThan(0);
  });

  it("does not flag a scene after the hook window", () => {
    const guidance = buildHookGuidance(makeContext({ sceneStartSec: 45 }));
    expect(guidance.isHookSegment).toBe(false);
    expect(guidance.recommendations).toEqual([]);
  });

  it("uses the exported HOOK_WINDOW_SEC constant as the boundary", () => {
    expect(HOOK_WINDOW_SEC).toBe(30);
    const atBoundary = buildHookGuidance(makeContext({ sceneStartSec: 30 }));
    expect(atBoundary.isHookSegment).toBe(false);
  });
});

describe("buildRetentionRisk", () => {
  it("flags a scene as at-risk when multiple risk factors combine", () => {
    // Long duration (1.5x avg) + plain explain + no entities/statCallout = 2+ factors
    const context = makeContext({ sceneDurationSec: 15, beatIntents: [makeIntent({ spokenText: "It was a normal day." })] });
    const risk = buildRetentionRisk(context, "explain", "b_roll", "slow", makeScene());
    expect(risk.isAtRisk).toBe(true);
    expect(risk.recommendations.length).toBeGreaterThan(0);
  });

  it("does not flag a short, entity-rich, fast-paced scene", () => {
    const context = makeContext({
      sceneDurationSec: 8,
      beatIntents: [makeIntent({ people: ["Tim Cook"], companies: ["Apple"] })],
    });
    const risk = buildRetentionRisk(context, "climax", "keynote_or_stage_footage", "fast", makeScene());
    expect(risk.isAtRisk).toBe(false);
    expect(risk.recommendations).toEqual([]);
  });

  it("always carries a non-empty reason regardless of risk (NO RANDOMNESS requirement)", () => {
    const context = makeContext({ sceneDurationSec: 8, beatIntents: [makeIntent({ people: ["Tim Cook"] })] });
    const risk = buildRetentionRisk(context, "climax", "keynote_or_stage_footage", "fast", makeScene());
    expect(risk.reason.length).toBeGreaterThan(0);
  });
});
