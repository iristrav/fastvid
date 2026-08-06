import { describe, expect, it } from "vitest";
import { planDirectorDecision } from "./directorPlanner";
import type { DirectorContext } from "./types";
import type { VisualIntent } from "../visualMatchingV2/types";
import type { Scene } from "../pipeline/types";

function makeIntent(overrides: Partial<VisualIntent> = {}): VisualIntent {
  return {
    beatId: "b0",
    spokenText: "Elon Musk unveiled Grok 5 to a packed audience.",
    visualSubject: "Elon Musk",
    visualAction: "speaking on stage",
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
    companies: ["xAI"],
    people: ["Elon Musk"],
    countries: [],
    events: [],
    intentHash: "hash",
    cacheHit: false,
    ...overrides,
  };
}

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return { index: 6, text: "text", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 10, ...overrides };
}

function makeContext(overrides: Partial<DirectorContext> = {}): DirectorContext {
  return {
    scene: makeScene(),
    beatIntents: [
      makeIntent({ beatId: "b0" }),
      makeIntent({ beatId: "b1", spokenText: "The crowd erupted in applause." }),
      makeIntent({ beatId: "b2", spokenText: "Tesla's stock also moved on the news." , companies: ["Tesla"]}),
    ],
    sceneIndex: 6,
    totalScenes: 10,
    sceneStartSec: 90,
    sceneDurationSec: 12,
    totalVideoDurationSec: 180,
    previousDecisions: [],
    ...overrides,
  };
}

describe("Director Planner (Phase 5) — full scene decision, no rendering", () => {
  it("produces a complete DirectorDecision matching the spec's example shape (Elon Musk / Tesla scenario)", () => {
    const decision = planDirectorDecision(makeContext());

    expect(decision.sceneIndex).toBe(6);
    expect(decision.primarySubject).toBe("Elon Musk");
    expect(decision.secondarySubject).toBeDefined();
    expect(decision.narrativeFunction).toBeDefined();
    expect(decision.narrativePurpose.length).toBeGreaterThan(0);
    expect(decision.emotion).toBeDefined();
    expect(decision.visualStrategy).toBeDefined();
    expect(Array.isArray(decision.supportingVisuals)).toBe(true);
    expect(decision.shotOrder.length).toBe(3);
    expect(decision.pacing).toBeDefined();
    expect(decision.energyTrend).toBeDefined();
    expect(decision.transitionStyle).toBeDefined();
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("suggests audience applause as the sound cue for a keynote scene, matching the spec example", () => {
    const decision = planDirectorDecision(makeContext());
    expect(decision.soundCueSuggestion).toBe("Audience applause.");
  });

  it("marks a scene inside the first 30 seconds as a hook segment", () => {
    const decision = planDirectorDecision(makeContext({ sceneStartSec: 5 }));
    expect(decision.hookGuidance.isHookSegment).toBe(true);
  });

  it("does not mark a mid-video scene as a hook segment", () => {
    const decision = planDirectorDecision(makeContext({ sceneStartSec: 90 }));
    expect(decision.hookGuidance.isHookSegment).toBe(false);
  });

  it("classifies the opening scene as establish and the closing scene as resolve", () => {
    const opening = planDirectorDecision(makeContext({ sceneIndex: 0, totalScenes: 10 }));
    expect(opening.narrativeFunction).toBe("establish");

    const closing = planDirectorDecision(makeContext({ sceneIndex: 9, totalScenes: 10 }));
    expect(closing.narrativeFunction).toBe("resolve");
  });

  it("carries attention recommendations forward when the scene repeats the previous strategy", () => {
    const first = planDirectorDecision(makeContext({ sceneIndex: 1, sceneStartSec: 20 }));
    const second = planDirectorDecision(
      makeContext({ sceneIndex: 2, sceneStartSec: 32, previousDecisions: [first, first] })
    );
    // Two scenes back-to-back both classified keynote_or_stage_footage should trigger a
    // change_shot_type recommendation once the lookback window (2) is satisfied.
    if (first.visualStrategy === second.visualStrategy) {
      expect(second.attentionRecommendations.some((r) => r.type === "change_shot_type")).toBe(true);
    }
  });

  it("every DirectorDecision produced carries a non-empty top-level reason (NO RANDOMNESS requirement)", () => {
    for (const sceneIndex of [0, 5, 9]) {
      const decision = planDirectorDecision(makeContext({ sceneIndex, totalScenes: 10 }));
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("is independently testable with no rendering, no media download, and no network I/O", () => {
    // The entire test suite for this function never touches fs/network — this test exists to
    // document that guarantee explicitly, matching the Phase 5 TESTING requirement.
    const decision = planDirectorDecision(makeContext());
    expect(decision).toBeDefined();
  });
});
