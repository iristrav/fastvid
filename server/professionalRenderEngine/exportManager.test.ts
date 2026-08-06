import { describe, expect, it, vi } from "vitest";
import { exportVideo, type ExportDependencies } from "./exportManager";
import type {
  ApprovedEDL,
  CameraInstruction,
  ClipInstruction,
  EDL,
  EditDecision,
  ExportRequest,
  RenderPlan,
} from "./types";

const CAMERA_HOLD: CameraInstruction = { movement: "camera_hold", intensity: 0, reason: "static" };

function clip(overrides: Partial<ClipInstruction> = {}): ClipInstruction {
  return {
    candidateId: "c0",
    assetType: "video",
    localPath: "/tmp/c0.mp4",
    remoteUrl: null,
    trimStartSec: 0,
    trimEndSec: 4,
    startSec: 0,
    endSec: 4,
    timingSource: "tts_word_alignment",
    ...overrides,
  };
}

function decision(overrides: Partial<EditDecision> = {}): EditDecision {
  return {
    beatId: "s0-b0",
    sceneIndex: 0,
    clip: clip(),
    shot: { shotType: "medium", reason: "test" },
    camera: CAMERA_HOLD,
    transitionIn: { type: "cut", durationSec: 0, reason: "cut" },
    captions: [],
    motionGraphics: [],
    effects: [],
    sounds: [],
    pacing: { tone: "neutral", cutSpeedMultiplier: 1, movementIntensity: 0.3, reason: "test" },
    ...overrides,
  };
}

function approvedEdl(decisions: EditDecision[]): ApprovedEDL {
  const edl: EDL = { sceneIndex: 0, decisions, totalDurationSec: decisions.reduce((m, d) => Math.max(m, d.clip.endSec), 0) };
  return { videoId: "vid1", edls: [edl] } as unknown as ApprovedEDL;
}

function request(overrides: Partial<ExportRequest> = {}): ExportRequest {
  return {
    videoId: "vid1",
    approvedEDL: approvedEdl([decision()]),
    formats: ["16:9"],
    outputDir: "/tmp/exports",
    ...overrides,
  };
}

function deps(overrides: Partial<ExportDependencies> = {}): ExportDependencies {
  return {
    resolveClipAsset: () => ({ inputLabel: "0:v", sourceDims: { width: 1920, height: 1080 } }),
    resolveInputFiles: (_plan: RenderPlan) => ["/tmp/c0.mp4"],
    executor: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    ...overrides,
  };
}

describe("Export Manager (Phase 7)", () => {
  it("exports a valid single-format request successfully", async () => {
    const result = await exportVideo(request(), deps());
    expect(result.videoId).toBe("vid1");
    expect(result.allSucceeded).toBe(true);
    expect(result.formats).toHaveLength(1);
    expect(result.formats[0]!.format).toBe("16:9");
    expect(result.formats[0]!.result.succeeded).toBe(true);
    expect(result.formats[0]!.result.encode?.succeeded).toBe(true);
    expect(result.formats[0]!.result.plan).not.toBeNull();
  });

  it("never reaches the encoder for a plan that fails validation", async () => {
    const executor = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const invalidEdl = approvedEdl([decision({ clip: clip({ localPath: null, remoteUrl: null }) })]);
    const result = await exportVideo(request({ approvedEDL: invalidEdl }), deps({ executor }));

    expect(result.allSucceeded).toBe(false);
    expect(result.formats[0]!.result.succeeded).toBe(false);
    expect(result.formats[0]!.result.encode).toBeNull();
    expect(result.formats[0]!.result.validation.isValid).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });

  it("exports every requested format independently", async () => {
    const result = await exportVideo(request({ formats: ["16:9", "9:16", "1:1"] }), deps());
    expect(result.formats.map((f) => f.format)).toEqual(["16:9", "9:16", "1:1"]);
    for (const f of result.formats) {
      expect(f.result.plan?.aspectRatio).toBe(f.format);
    }
  });

  it("builds a distinct, sanitized output path per format", async () => {
    const executor = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await exportVideo(request({ formats: ["16:9", "9:16"], outputDir: "/tmp/exports" }), deps({ executor }));
    const calls = executor.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toContain("/tmp/exports/vid1_16x9.mp4");
    expect(calls[1]).toContain("/tmp/exports/vid1_9x16.mp4");
  });

  it("propagates an encode failure without marking validation as the cause", async () => {
    const executor = vi.fn().mockRejectedValue(new Error("ffmpeg: invalid argument"));
    const result = await exportVideo(request(), deps({ executor }));
    expect(result.allSucceeded).toBe(false);
    expect(result.formats[0]!.result.validation.isValid).toBe(true);
    expect(result.formats[0]!.result.encode?.succeeded).toBe(false);
  });

  it("allSucceeded is false if any one format fails, even when others succeed", async () => {
    let call = 0;
    const executor = vi.fn().mockImplementation(() => {
      call++;
      return call === 1 ? Promise.resolve({ stdout: "", stderr: "" }) : Promise.reject(new Error("boom"));
    });
    const result = await exportVideo(request({ formats: ["16:9", "9:16"] }), deps({ executor }));
    expect(result.formats[0]!.result.succeeded).toBe(true);
    expect(result.formats[1]!.result.succeeded).toBe(false);
    expect(result.allSucceeded).toBe(false);
  });

  it("passes through custom encode options like crf/preset", async () => {
    const executor = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await exportVideo(request(), deps({ executor, encodeOptions: { crf: 18, preset: "slow" } }));
    const cmd = executor.mock.calls[0]![0] as string;
    expect(cmd).toContain("-crf 18");
    expect(cmd).toContain("-preset slow");
  });
});
