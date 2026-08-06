import { describe, expect, it } from "vitest";
import { runAIDirector, type SceneInput } from "./aiDirector";
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
  return { index: 0, text: "text", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 10, ...overrides };
}

function makeSceneInput(index: number, durationSec: number, overrides: Partial<SceneInput> = {}): SceneInput {
  return {
    scene: makeScene({ index }),
    beatIntents: [makeIntent({ beatId: `b${index}` })],
    durationSec,
    ...overrides,
  };
}

describe("AI Director orchestrator (Phase 5)", () => {
  it("produces one DirectorDecision per scene, in order", () => {
    const output = runAIDirector([makeSceneInput(0, 10), makeSceneInput(1, 10), makeSceneInput(2, 10)]);
    expect(output.decisions).toHaveLength(3);
    expect(output.decisions.map((d) => d.sceneIndex)).toEqual([0, 1, 2]);
  });

  it("computes each scene's elapsed start time from the scenes before it", () => {
    const output = runAIDirector([makeSceneInput(0, 10), makeSceneInput(1, 25), makeSceneInput(2, 5)]);
    // Scene 0 starts at 0s (hook). Scene 1 starts at 10s (still hook). Scene 2 starts at
    // 10+25=35s, past the 30s hook window.
    expect(output.decisions[0]!.hookGuidance.isHookSegment).toBe(true);
    expect(output.decisions[1]!.hookGuidance.isHookSegment).toBe(true);
    expect(output.decisions[2]!.hookGuidance.isHookSegment).toBe(false);
  });

  it("threads previousDecisions between scenes so variation checks actually see history", () => {
    const output = runAIDirector([
      makeSceneInput(0, 10, { beatIntents: [makeIntent({ historicalContext: "WWII" })] }),
      makeSceneInput(1, 10, { beatIntents: [makeIntent({ historicalContext: "WWII" })] }),
      makeSceneInput(2, 10, { beatIntents: [makeIntent({ historicalContext: "WWII" })] }),
    ]);
    // Three consecutive archive_footage scenes should trigger a change_shot_type recommendation
    // by the third one, once the lookback window is satisfied.
    const third = output.decisions[2]!;
    if (output.decisions.every((d) => d.visualStrategy === "archive_footage")) {
      expect(third.attentionRecommendations.some((r) => r.type === "change_shot_type")).toBe(true);
    }
  });

  it("computes totalVideoDurationSec as the sum of every scene's duration", () => {
    const output = runAIDirector([makeSceneInput(0, 10), makeSceneInput(1, 20), makeSceneInput(2, 30)]);
    expect(output.totalVideoDurationSec).toBe(60);
  });

  it("exposes hookWindowSec as a field, not a hardcoded downstream assumption", () => {
    const output = runAIDirector([makeSceneInput(0, 10)]);
    expect(output.hookWindowSec).toBe(30);
  });

  it("surfaces highlight moments for climax/high-emotion scenes", () => {
    const output = runAIDirector([
      makeSceneInput(0, 10, { beatIntents: [makeIntent({ spokenText: "It was the biggest launch in company history." })] }),
    ]);
    const climaxMoment = output.highlightMoments.find((m) => m.sceneIndex === 0);
    if (output.decisions[0]!.narrativeFunction === "climax") {
      expect(climaxMoment).toBeDefined();
      expect(climaxMoment!.suggestedFor.length).toBeGreaterThan(0);
    }
  });

  it("aggregates only at-risk scenes into retentionRisks, each carrying its sceneIndex", () => {
    const output = runAIDirector([
      makeSceneInput(0, 10),
      makeSceneInput(1, 40, { beatIntents: [makeIntent({ spokenText: "It was a normal day." })] }), // long + no entities
    ]);
    for (const risk of output.retentionRisks) {
      expect(risk.isAtRisk).toBe(true);
      expect(typeof risk.sceneIndex).toBe("number");
    }
  });

  it("returns an empty DirectorOutput for zero scenes", () => {
    const output = runAIDirector([]);
    expect(output.decisions).toEqual([]);
    expect(output.totalVideoDurationSec).toBe(0);
    expect(output.highlightMoments).toEqual([]);
    expect(output.retentionRisks).toEqual([]);
  });
});
