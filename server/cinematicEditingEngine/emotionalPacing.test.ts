import { describe, expect, it } from "vitest";
import { deriveEmotionalTone } from "./emotionalPacing";
import type { VisualIntent } from "../visualMatchingV2/types";

function makeIntent(overrides: Partial<VisualIntent> = {}): VisualIntent {
  return {
    beatId: "b0",
    spokenText: "The city continued as normal.",
    visualSubject: "city",
    visualAction: "",
    visualLocation: "",
    visualTime: "",
    historicalContext: "",
    emotion: "",
    visualDescription: "",
    primaryKeyword: "city",
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

describe("Emotional Pacing Planner (Phase 4)", () => {
  it("derives dramatic pacing (slower, subtler) from VisualIntent.emotion", () => {
    const profile = deriveEmotionalTone(makeIntent({ emotion: "somber and grim" }));
    expect(profile.tone).toBe("dramatic");
    expect(profile.cutSpeedMultiplier).toBeLessThan(1);
    expect(profile.movementIntensity).toBeLessThan(0.5);
    expect(profile.reason).toContain("somber and grim");
  });

  it("derives exciting pacing (faster, more movement) from VisualIntent.emotion", () => {
    const profile = deriveEmotionalTone(makeIntent({ emotion: "triumphant and energetic" }));
    expect(profile.tone).toBe("exciting");
    expect(profile.cutSpeedMultiplier).toBeGreaterThan(1);
    expect(profile.movementIntensity).toBeGreaterThan(0.5);
  });

  it("derives educational pacing (clean, focused) from VisualIntent.emotion", () => {
    const profile = deriveEmotionalTone(makeIntent({ emotion: "informative" }));
    expect(profile.tone).toBe("educational");
    expect(profile.cutSpeedMultiplier).toBe(1.0);
    expect(profile.movementIntensity).toBeLessThan(0.5);
  });

  it("falls back to scanning the beat's spoken text when emotion is empty", () => {
    const profile = deriveEmotionalTone(
      makeIntent({ emotion: "", spokenText: "It was a tragic and devastating loss for the town." })
    );
    expect(profile.tone).toBe("dramatic");
    expect(profile.reason).toContain("No usable Visual Intent emotion field");
  });

  it("defaults to neutral pacing when no signal is found anywhere", () => {
    const profile = deriveEmotionalTone(makeIntent({ emotion: "", spokenText: "The building has four floors." }));
    expect(profile.tone).toBe("neutral");
    expect(profile.cutSpeedMultiplier).toBe(1.0);
  });

  it("every tone produces a non-empty reason (NO RANDOMNESS requirement)", () => {
    for (const emotion of ["grim", "triumphant", "informative", ""]) {
      const profile = deriveEmotionalTone(makeIntent({ emotion }));
      expect(profile.reason.length).toBeGreaterThan(0);
    }
  });
});
