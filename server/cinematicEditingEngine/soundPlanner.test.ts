import { describe, expect, it } from "vitest";
import { planSoundEffects } from "./soundPlanner";
import type { PacingProfile } from "./types";
import type { VisualIntent } from "../visualMatchingV2/types";

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

function pacing(tone: PacingProfile["tone"]): PacingProfile {
  return { tone, cutSpeedMultiplier: 1, movementIntensity: 0.5, reason: "test" };
}

describe("Sound Effects Planner (Phase 4)", () => {
  it("plans a whoosh when the beat opens on a fast transition", () => {
    const sounds = planSoundEffects(makeIntent(), pacing("neutral"), 0, 4, "whip");
    expect(sounds.some((s) => s.soundType === "whoosh")).toBe(true);
  });

  it("does not plan a whoosh for a plain cut", () => {
    const sounds = planSoundEffects(makeIntent(), pacing("neutral"), 0, 4, "cut");
    expect(sounds.some((s) => s.soundType === "whoosh")).toBe(false);
  });

  it("plans an applause cue for crowd applause content", () => {
    const sounds = planSoundEffects(makeIntent({ spokenText: "The crowd erupted in applause." }), pacing("neutral"), 0, 4);
    expect(sounds.some((s) => s.soundType === "applause")).toBe(true);
  });

  it("plans a camera_click cue for press photography content", () => {
    const sounds = planSoundEffects(makeIntent({ spokenText: "Press photographers captured the moment." }), pacing("neutral"), 0, 4);
    expect(sounds.some((s) => s.soundType === "camera_click")).toBe(true);
  });

  it("plans an ambient rain cue with longer fades than a cue-type sound", () => {
    const sounds = planSoundEffects(makeIntent({ visualDescription: "heavy rain falling" }), pacing("neutral"), 0, 4);
    const rain = sounds.find((s) => s.soundType === "rain");
    expect(rain).toBeDefined();
    expect(rain!.fadeInSec).toBeGreaterThan(0.3);
  });

  it("plans a heartbeat only under dramatic pacing with a tension signal", () => {
    const dramatic = planSoundEffects(
      makeIntent({ spokenText: "The tension in the room was unbearable." }),
      pacing("dramatic"),
      0,
      4
    );
    expect(dramatic.some((s) => s.soundType === "heartbeat")).toBe(true);

    const neutral = planSoundEffects(
      makeIntent({ spokenText: "The tension in the room was unbearable." }),
      pacing("neutral"),
      0,
      4
    );
    expect(neutral.some((s) => s.soundType === "heartbeat")).toBe(false);
  });

  it("returns an empty array for a beat with no sound-worthy signal", () => {
    const sounds = planSoundEffects(makeIntent({ spokenText: "The building has four floors." }), pacing("neutral"), 0, 4);
    expect(sounds).toEqual([]);
  });

  it("every emitted sound carries a non-empty reason and volume in (0,1] (NO RANDOMNESS requirement)", () => {
    const sounds = planSoundEffects(makeIntent({ spokenText: "The crowd erupted in applause." }), pacing("neutral"), 0, 4);
    expect(sounds.length).toBeGreaterThan(0);
    for (const s of sounds) {
      expect(s.reason.length).toBeGreaterThan(0);
      expect(s.volume).toBeGreaterThan(0);
      expect(s.volume).toBeLessThanOrEqual(1);
    }
  });
});
