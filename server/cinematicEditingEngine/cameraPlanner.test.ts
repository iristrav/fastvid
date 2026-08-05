import { describe, expect, it } from "vitest";
import { planCameraMovement } from "./cameraPlanner";
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

function pacing(tone: PacingProfile["tone"], movementIntensity = 0.5): PacingProfile {
  return { tone, cutSpeedMultiplier: 1, movementIntensity, reason: "test" };
}

describe("Camera Planner (Phase 4)", () => {
  it("applies Ken Burns to still images on establishing/wide/archive shots", () => {
    const cam = planCameraMovement(shot("establishing"), makeCandidate({ assetType: "image" }), pacing("neutral"));
    expect(cam.movement).toBe("ken_burns");
    expect(cam.intensity).toBeGreaterThan(0);
  });

  it("holds static for overlay shots regardless of asset type", () => {
    const cam = planCameraMovement(shot("overlay_shot"), makeCandidate(), pacing("exciting"));
    expect(cam.movement).toBe("camera_hold");
    expect(cam.intensity).toBe(0);
  });

  it("holds static for archive video footage to preserve authenticity", () => {
    const cam = planCameraMovement(shot("archive_footage"), makeCandidate({ assetType: "video" }), pacing("dramatic"));
    expect(cam.movement).toBe("camera_hold");
  });

  it("holds static for reaction/cutaway/b_roll video (already has incidental motion)", () => {
    const cam = planCameraMovement(shot("reaction"), makeCandidate({ assetType: "video" }), pacing("neutral"));
    expect(cam.movement).toBe("camera_hold");
  });

  it("holds static on close-ups under educational pacing for readability", () => {
    const cam = planCameraMovement(shot("close_up"), makeCandidate({ assetType: "video" }), pacing("educational"));
    expect(cam.movement).toBe("camera_hold");
  });

  it("chooses tilt_up for a vertical subject in an establishing/wide video shot", () => {
    const cam = planCameraMovement(
      shot("wide"),
      makeCandidate({ assetType: "video", searchQuery: "skyscraper exterior" }),
      pacing("neutral")
    );
    expect(cam.movement).toBe("tilt_up");
  });

  it("chooses tilt_down for an overhead/aerial shot", () => {
    const cam = planCameraMovement(
      shot("establishing"),
      makeCandidate({ assetType: "video", searchQuery: "aerial view of city" }),
      pacing("neutral")
    );
    expect(cam.movement).toBe("tilt_down");
  });

  it("chooses a pan for a horizontal subject, deterministically by candidateId", () => {
    const cam1 = planCameraMovement(
      shot("wide"),
      makeCandidate({ assetType: "video", searchQuery: "city skyline panorama", candidateId: "abc" }),
      pacing("neutral")
    );
    expect(["pan_left", "pan_right"]).toContain(cam1.movement);
    // Same candidateId always yields the same direction (deterministic, not random).
    const cam2 = planCameraMovement(
      shot("wide"),
      makeCandidate({ assetType: "video", searchQuery: "city skyline panorama", candidateId: "abc" }),
      pacing("neutral")
    );
    expect(cam2.movement).toBe(cam1.movement);
  });

  it("chooses slow_push for a dramatic close-up on video", () => {
    const cam = planCameraMovement(shot("close_up"), makeCandidate({ assetType: "video" }), pacing("dramatic"));
    expect(cam.movement).toBe("slow_push");
  });

  it("chooses virtual_dolly for an exciting medium shot on video", () => {
    const cam = planCameraMovement(shot("medium"), makeCandidate({ assetType: "video" }), pacing("exciting"));
    expect(cam.movement).toBe("virtual_dolly");
  });

  it("every decision carries a non-empty reason (NO RANDOMNESS requirement)", () => {
    const cam = planCameraMovement(shot("medium"), makeCandidate(), pacing("neutral"));
    expect(cam.reason.length).toBeGreaterThan(0);
  });
});
