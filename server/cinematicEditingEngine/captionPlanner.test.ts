import { describe, expect, it } from "vitest";
import { planCaptions } from "./captionPlanner";
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
  return {
    index: 0,
    text: "text",
    visualCue: "",
    pexelsQuery: "",
    aiImagePrompt: "",
    duration: 5,
    ...overrides,
  };
}

describe("Caption Planner (Phase 4)", () => {
  it("emits a chapter_title once, on the first beat of a chapter-card scene", () => {
    const captions = planCaptions(makeIntent(), 0, 4, {
      scene: makeScene({ isChapterCard: true, chapterTitle: "The Beginning" }),
      isFirstBeatOfScene: true,
    });
    const chapter = captions.find((c) => c.captionType === "chapter_title");
    expect(chapter).toBeDefined();
    expect(chapter!.text).toBe("The Beginning");
  });

  it("emits a date caption when the beat's visual time names a year", () => {
    const captions = planCaptions(makeIntent({ visualTime: "1969" }), 0, 4);
    const date = captions.find((c) => c.captionType === "date");
    expect(date).toBeDefined();
    expect(date!.text).toBe("1969");
  });

  it("emits a timeline_label instead of a plain date for a dated historical event", () => {
    const captions = planCaptions(
      makeIntent({ visualTime: "1969", historicalContext: "Moon landing era", events: ["Apollo 11 landing"] }),
      0,
      4
    );
    expect(captions.some((c) => c.captionType === "timeline_label")).toBe(true);
    expect(captions.some((c) => c.captionType === "date")).toBe(false);
  });

  it("emits a location caption when visualLocation is set", () => {
    const captions = planCaptions(makeIntent({ visualLocation: "Apple Park" }), 0, 4);
    expect(captions.find((c) => c.captionType === "location")?.text).toBe("Apple Park");
  });

  it("emits a statistic caption from the scene's statCallout", () => {
    const captions = planCaptions(makeIntent(), 0, 4, { scene: makeScene({ statCallout: "$3,499" }) });
    expect(captions.find((c) => c.captionType === "statistic")?.text).toBe("$3,499");
  });

  it("emits a quote caption, attributed, when the narration contains a direct quote", () => {
    const captions = planCaptions(
      makeIntent({ spokenText: 'He said "this changes everything" on stage.', people: ["Tim Cook"] }),
      0,
      4
    );
    const quote = captions.find((c) => c.captionType === "quote");
    expect(quote?.text).toBe("this changes everything");
    expect(quote?.subtitle).toBe("Tim Cook");
  });

  it("emits a name caption the first time a person appears, not on repeat beats", () => {
    const intent = makeIntent({ people: ["Tim Cook"] });
    const first = planCaptions(intent, 0, 4);
    expect(first.some((c) => c.captionType === "name")).toBe(true);

    const second = planCaptions(intent, 4, 4, {
      continuity: { recentShotTypes: [], recentTransitions: [], establishedSubjects: ["Tim Cook"] },
    });
    expect(second.some((c) => c.captionType === "name")).toBe(false);
  });

  it("emits one animated_text caption per highlight word, spaced across the beat", () => {
    const captions = planCaptions(makeIntent(), 0, 4, { scene: makeScene({ highlightWords: ["never", "before", "seen"] }) });
    const animated = captions.filter((c) => c.captionType === "animated_text");
    expect(animated).toHaveLength(3);
    expect(animated[0]!.startSec).toBe(0);
    expect(animated[2]!.endSec).toBe(4);
  });

  it("does not emit a subtitle by default, but does when explicitly requested", () => {
    const withoutFlag = planCaptions(makeIntent(), 0, 4);
    expect(withoutFlag.some((c) => c.captionType === "subtitle")).toBe(false);

    const withFlag = planCaptions(makeIntent(), 0, 4, { includeSubtitle: true });
    expect(withFlag.some((c) => c.captionType === "subtitle")).toBe(true);
  });

  it("returns an empty array for a beat with no caption-worthy signal", () => {
    const captions = planCaptions(makeIntent({ spokenText: "It was a normal day." }), 0, 4);
    expect(captions).toEqual([]);
  });

  it("every emitted caption carries a non-empty reason (NO RANDOMNESS requirement)", () => {
    const captions = planCaptions(makeIntent({ visualLocation: "Apple Park", visualTime: "1969" }), 0, 4);
    expect(captions.length).toBeGreaterThan(0);
    for (const c of captions) expect(c.reason.length).toBeGreaterThan(0);
  });
});
