import { describe, expect, it } from "vitest";
import { decideEnergyTrend, decidePacing, decideTransitionStyle, suggestSoundCue, suggestTextOverlay } from "./pacingAdvisor";
import type { DirectorContext } from "./types";
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
  return { index: 1, text: "text", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 10, ...overrides };
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

describe("decidePacing", () => {
  it("chooses fast for a scene noticeably shorter than the video's average scene", () => {
    // avg = 60/6 = 10s; a 5s scene is 0.5x -> fast
    const pacing = decidePacing(makeContext({ sceneDurationSec: 5 }), "explain");
    expect(pacing).toBe("fast");
  });

  it("chooses slow for a scene noticeably longer than average", () => {
    const pacing = decidePacing(makeContext({ sceneDurationSec: 15 }), "explain");
    expect(pacing).toBe("slow");
  });

  it("biases climax scenes of average duration toward fast", () => {
    const pacing = decidePacing(makeContext({ sceneDurationSec: 10 }), "climax");
    expect(pacing).toBe("fast");
  });

  it("biases resolve scenes of average duration toward slow", () => {
    const pacing = decidePacing(makeContext({ sceneDurationSec: 10 }), "resolve");
    expect(pacing).toBe("slow");
  });

  it("biases hook-window scenes of average duration toward fast", () => {
    const pacing = decidePacing(makeContext({ sceneDurationSec: 10, sceneStartSec: 5 }), "explain");
    expect(pacing).toBe("fast");
  });
});

describe("decideEnergyTrend", () => {
  it("is increasing for climax/reveal scenes", () => {
    expect(decideEnergyTrend(makeContext(), "climax")).toBe("increasing");
    expect(decideEnergyTrend(makeContext(), "reveal")).toBe("increasing");
  });

  it("is decreasing for resolve scenes", () => {
    expect(decideEnergyTrend(makeContext(), "resolve")).toBe("decreasing");
  });

  it("is increasing within the hook window regardless of narrative function", () => {
    expect(decideEnergyTrend(makeContext({ sceneStartSec: 10 }), "explain")).toBe("increasing");
  });

  it("is steady otherwise", () => {
    expect(decideEnergyTrend(makeContext({ sceneStartSec: 60 }), "explain")).toBe("steady");
  });
});

describe("decideTransitionStyle", () => {
  it("chooses fade for a transition (chapter card) scene", () => {
    expect(decideTransitionStyle("transition", "b_roll", "medium")).toBe("fade");
  });

  it("chooses cross_dissolve for a resolve scene", () => {
    expect(decideTransitionStyle("resolve", "b_roll", "slow")).toBe("cross_dissolve");
  });

  it("chooses film_burn for an archive_footage strategy scene", () => {
    expect(decideTransitionStyle("explain", "archive_footage", "medium")).toBe("film_burn");
  });

  it("chooses whip for a fast climax scene", () => {
    expect(decideTransitionStyle("climax", "b_roll", "fast")).toBe("whip");
  });

  it("defaults to cut", () => {
    expect(decideTransitionStyle("explain", "b_roll", "medium")).toBe("cut");
  });
});

describe("suggestTextOverlay", () => {
  it("suggests the scene's stat callout first", () => {
    const overlay = suggestTextOverlay(makeScene({ statCallout: "40% growth" }), [makeIntent()]);
    expect(overlay).toBe("Show statistic: 40% growth.");
  });

  it("suggests a year found in the narration", () => {
    const overlay = suggestTextOverlay(makeScene(), [makeIntent({ spokenText: "It happened in 1969." })]);
    expect(overlay).toBe("Show year 1969.");
  });

  it("suggests the chapter title for a chapter-card scene with no other signal", () => {
    const overlay = suggestTextOverlay(makeScene({ isChapterCard: true, chapterTitle: "The Beginning" }), [makeIntent()]);
    expect(overlay).toBe('Show chapter title: "The Beginning".');
  });

  it("returns null when nothing calls for on-screen text", () => {
    expect(suggestTextOverlay(makeScene(), [makeIntent()])).toBeNull();
  });
});

describe("suggestSoundCue", () => {
  it("suggests audience applause for keynote/stage footage — matches the Phase 5 spec example", () => {
    expect(suggestSoundCue("explain", "keynote_or_stage_footage", "neutral")).toBe("Audience applause.");
  });

  it("suggests a tension underscore for tense scenes", () => {
    expect(suggestSoundCue("explain", "b_roll", "tension")).toBe("Dramatic tension underscore.");
  });

  it("returns null when nothing calls for a sound cue", () => {
    expect(suggestSoundCue("explain", "b_roll", "neutral")).toBeNull();
  });
});
