import { resolveSoundEffect } from "../audioAssetSource";
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
  /**
   * The catalogue has no whoosh recording (`SOUND_EFFECT_TO_CATEGORY.whoosh = null`), so the
   * planner does not ask for one: the render would only drop it as SFX_NOT_AVAILABLE.
   */
  it("plans no whoosh on a fast transition while FastVid has no whoosh recording", () => {
    const sounds = planSoundEffects(makeIntent(), pacing("neutral"), 0, 4, "whip");
    expect(sounds.some((s) => s.soundType === "whoosh")).toBe(false);
  });

  it("plans only sounds the catalogue can deliver — impact, typing, page turn, camera and ambience stay", () => {
    const sounds = planSoundEffects(
      makeIntent({ spokenText: "Photographers took a photo of the collision while rain fell; he typed a message and turned the page." }),
      pacing("dramatic"),
      0,
      4,
      "whip"
    );
    const types = sounds.map((s) => s.soundType);
    expect(types).toEqual(expect.arrayContaining(["camera_click", "impact", "rain", "typing", "page_turn"]));
    for (const t of types) expect(resolveSoundEffect(t).ok, t).toBe(true);
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

  it("plans no heartbeat while FastVid has no heartbeat recording, dramatic or not", () => {
    for (const tone of ["dramatic", "neutral"] as const) {
      const sounds = planSoundEffects(makeIntent({ spokenText: "The tension in the room was unbearable." }), pacing(tone), 0, 4);
      expect(sounds.some((s) => s.soundType === "heartbeat")).toBe(false);
    }
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
