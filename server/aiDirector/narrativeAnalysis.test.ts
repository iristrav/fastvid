import { describe, expect, it } from "vitest";
import {
  classifyNarrative,
  classifySceneEmotion,
  classifyVisualStrategy,
  deriveSupportingVisuals,
  directorEmotionToPacingTone,
  pickSubjectFocus,
} from "./narrativeAnalysis";
import type { DirectorContext } from "./types";
import type { VisualIntent } from "../visualMatchingV2/types";
import type { Scene } from "../pipeline/types";

function makeIntent(overrides: Partial<VisualIntent> = {}): VisualIntent {
  return {
    beatId: "b0",
    spokenText: "Apple introduced the Vision Pro.",
    visualSubject: "Apple",
    visualAction: "",
    visualLocation: "",
    visualTime: "present day",
    historicalContext: "",
    emotion: "",
    visualDescription: "",
    primaryKeyword: "Apple Vision Pro",
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
  return { index: 1, text: "text", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 10, ...overrides };
}

function makeContext(overrides: Partial<DirectorContext> = {}): DirectorContext {
  return {
    scene: makeScene(),
    beatIntents: [makeIntent()],
    sceneIndex: 1,
    totalScenes: 5,
    sceneStartSec: 40,
    sceneDurationSec: 10,
    totalVideoDurationSec: 120,
    previousDecisions: [],
    ...overrides,
  };
}

describe("pickSubjectFocus", () => {
  it("picks the most frequently mentioned entity across all beats as primary", () => {
    const context = makeContext({
      beatIntents: [
        makeIntent({ companies: ["Apple"] }),
        makeIntent({ companies: ["Apple"], brands: ["Vision Pro"] }),
        makeIntent({ companies: ["Apple"] }),
      ],
    });
    const focus = pickSubjectFocus(context);
    expect(focus.primary).toBe("Apple");
    expect(focus.secondary).toBe("Vision Pro");
  });

  it("falls back to the first beat's visualSubject when no named entities exist", () => {
    const focus = pickSubjectFocus(makeContext({ beatIntents: [makeIntent({ visualSubject: "the city" })] }));
    expect(focus.primary).toBe("the city");
    expect(focus.secondary).toBeNull();
  });
});

describe("classifyNarrative", () => {
  it("classifies a chapter-card scene as transition regardless of content", () => {
    const context = makeContext({ scene: makeScene({ isChapterCard: true }), sceneIndex: 2 });
    const result = classifyNarrative(context, "Apple");
    expect(result.narrativeFunction).toBe("transition");
  });

  it("classifies scene 0 as establish", () => {
    const context = makeContext({ sceneIndex: 0 });
    expect(classifyNarrative(context, "Apple").narrativeFunction).toBe("establish");
  });

  it("classifies the last scene as resolve", () => {
    const context = makeContext({ sceneIndex: 4, totalScenes: 5 });
    expect(classifyNarrative(context, "Apple").narrativeFunction).toBe("resolve");
  });

  it("classifies a scale/superlative signal as climax", () => {
    const context = makeContext({ beatIntents: [makeIntent({ spokenText: "This was the biggest launch in company history." })] });
    expect(classifyNarrative(context, "Apple").narrativeFunction).toBe("climax");
  });

  it("classifies a contrast signal as contrast", () => {
    const context = makeContext({ beatIntents: [makeIntent({ spokenText: "Unlike its competitors, Apple took a different approach." })] });
    expect(classifyNarrative(context, "Apple").narrativeFunction).toBe("contrast");
  });

  it("defaults to explain with no stronger signal", () => {
    const context = makeContext({ beatIntents: [makeIntent({ spokenText: "The device has a new display." })] });
    expect(classifyNarrative(context, "Apple").narrativeFunction).toBe("explain");
  });
});

describe("classifySceneEmotion", () => {
  it("detects triumph from narration content", () => {
    const context = makeContext({ beatIntents: [makeIntent({ spokenText: "The team achieved a historic victory." })] });
    expect(classifySceneEmotion(context)).toBe("triumph");
  });

  it("reuses VisualIntent.emotion as a signal source", () => {
    const context = makeContext({ beatIntents: [makeIntent({ emotion: "curious and wondering" })] });
    expect(classifySceneEmotion(context)).toBe("curiosity");
  });

  it("defaults to neutral with no signal", () => {
    const context = makeContext({ beatIntents: [makeIntent({ spokenText: "The building has four floors." })] });
    expect(classifySceneEmotion(context)).toBe("neutral");
  });
});

describe("directorEmotionToPacingTone", () => {
  it("maps every DirectorEmotion to a valid EmotionalTone", () => {
    expect(directorEmotionToPacingTone("tension")).toBe("dramatic");
    expect(directorEmotionToPacingTone("excitement")).toBe("exciting");
    expect(directorEmotionToPacingTone("curiosity")).toBe("educational");
    expect(directorEmotionToPacingTone("neutral")).toBe("neutral");
  });
});

describe("classifyVisualStrategy", () => {
  it("chooses archive_footage when most beats have historical context", () => {
    const context = makeContext({
      beatIntents: [makeIntent({ historicalContext: "WWII" }), makeIntent({ historicalContext: "WWII" })],
    });
    expect(classifyVisualStrategy(context)).toBe("archive_footage");
  });

  it("chooses interview when a person is quoted directly", () => {
    const context = makeContext({
      beatIntents: [makeIntent({ people: ["Tim Cook"], spokenText: 'He said "this changes everything."' })],
    });
    expect(classifyVisualStrategy(context)).toBe("interview");
  });

  it("chooses keynote_or_stage_footage for a person speaking on stage without a direct quote", () => {
    const context = makeContext({
      beatIntents: [makeIntent({ people: ["Tim Cook"], spokenText: "Tim Cook took the stage to present the new device." })],
    });
    expect(classifyVisualStrategy(context)).toBe("keynote_or_stage_footage");
  });

  it("chooses map when countries are referenced", () => {
    const context = makeContext({ beatIntents: [makeIntent({ countries: ["Japan"] })] });
    expect(classifyVisualStrategy(context)).toBe("map");
  });

  it("chooses chart when the scene carries a stat callout", () => {
    const context = makeContext({ scene: makeScene({ statCallout: "40% growth" }) });
    expect(classifyVisualStrategy(context)).toBe("chart");
  });

  it("chooses close_up_product for a named object with a hands-on action", () => {
    const context = makeContext({ beatIntents: [makeIntent({ objects: ["headset"], spokenText: "He began to unveil the headset." })] });
    expect(classifyVisualStrategy(context)).toBe("close_up_product");
  });

  it("falls back to b_roll with no stronger signal", () => {
    const context = makeContext({ beatIntents: [makeIntent({ spokenText: "The office was quiet that morning." })] });
    expect(classifyVisualStrategy(context)).toBe("b_roll");
  });
});

describe("deriveSupportingVisuals", () => {
  it("suggests secondary-subject B-roll, audience reactions, and a close-up when applicable", () => {
    const context = makeContext({
      beatIntents: [
        makeIntent({ people: ["Tim Cook"], objects: ["headset"], spokenText: "Tim Cook took the stage to present." }),
      ],
    });
    const visuals = deriveSupportingVisuals(context, "Apple", "Tesla");
    expect(visuals).toContain("Tesla B-roll.");
    expect(visuals).toContain("Audience reactions.");
    expect(visuals).toContain("Close-up of headset.");
  });

  it("caps suggestions at 3", () => {
    const context = makeContext({
      beatIntents: [
        makeIntent({
          people: ["Tim Cook"],
          objects: ["headset"],
          companies: ["Nvidia"],
          spokenText: "Tim Cook took the stage to present.",
        }),
      ],
    });
    const visuals = deriveSupportingVisuals(context, "Apple", "Tesla");
    expect(visuals.length).toBeLessThanOrEqual(3);
  });
});
