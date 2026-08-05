import { describe, expect, it } from "vitest";
import { planVisualEffects } from "./effectsPlanner";
import type { ShotInstruction, PacingProfile } from "./types";
import type { CandidateAsset } from "../visualMatchingV2/types";

function makeCandidate(overrides: Partial<CandidateAsset> = {}): CandidateAsset {
  return {
    candidateId: "c1",
    source: "pexels",
    assetType: "video",
    title: null,
    description: null,
    tags: [],
    thumbnail: null,
    localPath: "/tmp/clip.mp4",
    remoteUrl: null,
    metadata: null,
    searchQuery: "",
    retrievalMethod: "search",
    fetchedAt: new Date().toISOString(),
    language: null,
    license: null,
    attribution: null,
    width: 1920,
    height: 1080,
    duration: 8,
    mimeType: null,
    originalSource: null,
    downloadTimeMs: null,
    embeddingSimilarity: null,
    keywordScore: null,
    retrievalReasons: [],
    retrievalSources: [],
    clipSimilarity: null,
    clipModel: null,
    clipEmbeddingVersion: null,
    clipLatencyMs: null,
    editorialScore: null,
    motionLevel: null,
    rankingScore: null,
    rankingBreakdown: null,
    ...overrides,
  };
}

function shot(shotType: ShotInstruction["shotType"]): ShotInstruction {
  return { shotType, reason: "test" };
}

function pacing(tone: PacingProfile["tone"], cutSpeedMultiplier = 1): PacingProfile {
  return { tone, cutSpeedMultiplier, movementIntensity: 0.5, reason: "test" };
}

describe("Visual Effects Planner (Phase 4)", () => {
  it("applies vignette + film_grain + dust for archive footage", () => {
    const effects = planVisualEffects(shot("archive_footage"), makeCandidate(), pacing("neutral"));
    const types = effects.map((e) => e.effectType);
    expect(types).toContain("vignette");
    expect(types).toContain("film_grain");
    expect(types).toContain("dust");
  });

  it("applies a subtle vignette and light film_grain for dramatic pacing on modern footage", () => {
    const effects = planVisualEffects(shot("medium"), makeCandidate(), pacing("dramatic"));
    const vignette = effects.find((e) => e.effectType === "vignette");
    const grain = effects.find((e) => e.effectType === "film_grain");
    expect(vignette).toBeDefined();
    expect(grain?.intensity).toBeLessThan(0.3);
  });

  it("applies letterbox for a dramatic wide/establishing shot", () => {
    const effects = planVisualEffects(shot("establishing"), makeCandidate(), pacing("dramatic"));
    expect(effects.some((e) => e.effectType === "letterbox")).toBe(true);
  });

  it("applies lens_flare for a bright outdoor establishing shot", () => {
    const effects = planVisualEffects(shot("wide"), makeCandidate({ searchQuery: "sunset over the city" }), pacing("neutral"));
    expect(effects.some((e) => e.effectType === "lens_flare")).toBe(true);
  });

  it("applies bloom for bright-light footage without a flare-specific signal", () => {
    const effects = planVisualEffects(shot("close_up"), makeCandidate({ searchQuery: "stage lighting keynote" }), pacing("neutral"));
    expect(effects.some((e) => e.effectType === "bloom")).toBe(true);
  });

  it("applies particles for atmospheric establishing/wide footage", () => {
    const effects = planVisualEffects(shot("wide"), makeCandidate({ searchQuery: "foggy forest at dawn" }), pacing("neutral"));
    expect(effects.some((e) => e.effectType === "particles")).toBe(true);
  });

  it("applies glow for an exciting close-up/detail shot", () => {
    const effects = planVisualEffects(shot("close_up"), makeCandidate(), pacing("exciting"));
    expect(effects.some((e) => e.effectType === "glow")).toBe(true);
  });

  it("applies chromatic_aberration only for fast, exciting pacing", () => {
    const fast = planVisualEffects(shot("medium"), makeCandidate(), pacing("exciting", 1.5));
    expect(fast.some((e) => e.effectType === "chromatic_aberration")).toBe(true);

    const slow = planVisualEffects(shot("medium"), makeCandidate(), pacing("exciting", 1.0));
    expect(slow.some((e) => e.effectType === "chromatic_aberration")).toBe(false);
  });

  it("returns an empty array for a clean neutral medium shot with no effect-worthy signal", () => {
    const effects = planVisualEffects(shot("medium"), makeCandidate(), pacing("neutral"));
    expect(effects).toEqual([]);
  });

  it("every emitted effect carries a non-empty reason and intensity within (0,1] (NO RANDOMNESS requirement)", () => {
    const effects = planVisualEffects(shot("archive_footage"), makeCandidate(), pacing("dramatic"));
    expect(effects.length).toBeGreaterThan(0);
    for (const e of effects) {
      expect(e.reason.length).toBeGreaterThan(0);
      expect(e.intensity).toBeGreaterThan(0);
      expect(e.intensity).toBeLessThanOrEqual(1);
    }
  });
});
