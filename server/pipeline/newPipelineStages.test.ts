import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildVoiceoverMuxCommand, runNewEnginePipelineForScenes, type NewPipelineSceneInput } from "./newPipelineStages";
import type { CuratedCandidatePick } from "./types";
import type { Scene } from "../videoPipeline";
import type { EDL, ReviewDimension } from "../cinematicEditingEngine/types";
import type { ApprovedEDL, DimensionScore, ReviewReport } from "../editorialReviewEngineV2/types";
import type { DirectorOutput } from "../aiDirector";

vi.mock("./newEngineFlags", () => ({
  visualIntelligenceEngineStageEnabled: vi.fn(() => false),
  aiDirectorStageEnabled: vi.fn(() => false),
}));

vi.mock("../visualMatchingV2/v2Pipeline", () => ({
  runV2Pipeline: vi.fn(),
}));

vi.mock("../cinematicEditingEngine/edlGenerator", () => ({
  generateEDL: vi.fn(),
}));

vi.mock("../aiDirector", () => ({
  runAIDirector: vi.fn(),
  toDirectorGuidance: vi.fn(() => ({ pacingTone: "neutral", shotOrder: [] })),
}));

vi.mock("../editorialReviewEngineV2", () => ({
  generateReviewReport: vi.fn(),
  produceApprovedEDL: vi.fn(),
}));

vi.mock("../archiveAssetLoad", () => ({
  loadArchiveAssetFile: vi.fn(),
}));

vi.mock("../professionalRenderEngine/renderPlanner", () => ({
  planScene: vi.fn(),
}));

vi.mock("../professionalRenderEngine/encoder", () => ({
  encode: vi.fn(),
}));

vi.mock("../professionalRenderEngine/renderValidator", () => ({
  validateEDL: vi.fn(() => ({ isValid: true, issues: [] })),
  validateRenderPlan: vi.fn(() => ({ isValid: true, issues: [] })),
  mergeValidationResults: vi.fn((a, b) => ({ isValid: a.isValid && b.isValid, issues: [...a.issues, ...b.issues] })),
}));

import { visualIntelligenceEngineStageEnabled, aiDirectorStageEnabled } from "./newEngineFlags";
import { runV2Pipeline } from "../visualMatchingV2/v2Pipeline";
import { generateEDL } from "../cinematicEditingEngine/edlGenerator";
import { runAIDirector, toDirectorGuidance } from "../aiDirector";
import { generateReviewReport, produceApprovedEDL } from "../editorialReviewEngineV2";
import { loadArchiveAssetFile } from "../archiveAssetLoad";
import { planScene } from "../professionalRenderEngine/renderPlanner";
import { encode } from "../professionalRenderEngine/encoder";

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    index: 0,
    text: "Scene text",
    visualCue: "a relevant shot",
    pexelsQuery: "relevant footage",
    aiImagePrompt: "",
    duration: 4,
    ...overrides,
  };
}

function sceneInput(overrides: Partial<NewPipelineSceneInput> = {}): NewPipelineSceneInput {
  return { scene: scene(), audioPath: "/tmp/audio0.mp3", durationSec: 4, ...overrides };
}

function candidatePick(id = 1): CuratedCandidatePick {
  return {
    asset: {
      id,
      archiveId: 1,
      title: "Clip",
      mediaType: "video",
      mixKind: "real_video",
      mimeType: "video/mp4",
      storageUrl: `https://cdn.example.com/${id}.mp4`,
      storageKey: `assets/${id}.mp4`,
      tags: [],
      sourceNote: null,
      licenseNote: null,
      width: 1920,
      height: 1080,
      durationSec: 10,
      sortOrder: 0,
      isActive: 1,
      hasBakedEditText: 0,
      annotationJson: null,
      editorialScore: null,
      annotationVersion: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as CuratedCandidatePick["asset"],
    archiveName: "Archive",
    score: 5,
  };
}

function fakeEDL(sceneIndex: number): EDL {
  return {
    sceneIndex,
    totalDurationSec: 4,
    decisions: [
      {
        beatId: `s${sceneIndex}-b0`,
        sceneIndex,
        clip: {
          candidateId: `legacy_archive:${sceneIndex + 1}`,
          assetType: "video",
          localPath: `/tmp/scene${sceneIndex}.mp4`,
          remoteUrl: null,
          trimStartSec: 0,
          trimEndSec: 4,
          startSec: 0,
          endSec: 4,
          timingSource: "proportional_estimate",
        },
        shot: { shotType: "medium", reason: "x" },
        camera: { movement: "camera_hold", intensity: 0, reason: "x" },
        transitionIn: { type: "cut", durationSec: 0, reason: "x" },
        captions: [],
        motionGraphics: [],
        effects: [],
        sounds: [],
        pacing: { tone: "neutral", cutSpeedMultiplier: 1, movementIntensity: 0.3, reason: "x" },
      },
    ],
  };
}

function fakeReviewReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  const dims: ReviewDimension[] = [
    "narrativeClarity",
    "visualAccuracy",
    "visualDiversity",
    "pacing",
    "emotionalFlow",
    "viewerRetention",
    "shotVariety",
    "transitionQuality",
    "textUsage",
    "historicalAccuracy",
    "contextConsistency",
    "overallProfessionalQuality",
  ];
  const scoreEntry: DimensionScore = { score: 90, feedback: "fine" };
  const scores = Object.fromEntries(dims.map((d) => [d, scoreEntry])) as Record<ReviewDimension, DimensionScore>;

  return {
    videoId: "vid1",
    videoTitle: "Test Video",
    reviewedAt: new Date().toISOString(),
    scores,
    overallScore: 90,
    problems: [],
    recommendations: [],
    autoFixes: [],
    approvalStatus: "approved",
    confidenceScore: 0.9,
    ...overrides,
  };
}

function fakeDirectorOutput(): DirectorOutput {
  return {
    decisions: [
      {
        sceneIndex: 0,
        narrativeFunction: "development",
        emotion: "neutral" as never,
        shotOrder: [],
        energyTrend: "steady" as never,
        pacing: "medium" as never,
        transitionStyle: "cut" as never,
        supportingVisuals: [],
        subjectFocus: "",
        reason: "x",
      } as never,
    ],
    hookWindowSec: 30,
    highlightMoments: [],
    retentionRisks: [],
    totalVideoDurationSec: 4,
  };
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    videoId: "vid1",
    videoTitle: "Test Video",
    workDir: "/tmp/work",
    outputDir: "/tmp/out",
    correlationId: "corr1",
    legacyMediaSearch: vi.fn(async () => candidatePick()),
    executor: vi.fn(async () => ({ stdout: "", stderr: "" })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(visualIntelligenceEngineStageEnabled).mockReturnValue(false);
  vi.mocked(aiDirectorStageEnabled).mockReturnValue(false);
  vi.mocked(runAIDirector).mockReturnValue(fakeDirectorOutput());
  vi.mocked(toDirectorGuidance).mockReturnValue({ pacingTone: "neutral", shotOrder: [] });
  vi.mocked(generateEDL).mockImplementation((inputs) => fakeEDL(inputs[0]!.scene.index));
  vi.mocked(generateReviewReport).mockReturnValue(fakeReviewReport());
  vi.mocked(loadArchiveAssetFile).mockResolvedValue({
    ok: true,
    result: { localPath: "/tmp/downloaded.mp4", mimeType: "video/mp4", cleanup: vi.fn() },
  });
  vi.mocked(planScene).mockImplementation((edl) => ({
    sceneIndex: edl.sceneIndex,
    steps: [],
    filterComplex: "[0:v]scale=1920:1080[out]",
    outputLabel: "out",
    audioFilterComplex: "",
    audioOutputLabel: "",
    durationSec: 4,
  }));
  vi.mocked(encode).mockResolvedValue({
    outputPath: "/tmp/out/video_only.mp4",
    succeeded: true,
    attempts: [{ attempt: 1, succeeded: true, durationMs: 10 }],
    usedGpu: false,
  });
});

describe("New Pipeline Stages (Phase 8)", () => {
  describe("buildVoiceoverMuxCommand", () => {
    it("builds a copy-video/aac-audio mux command with -shortest", () => {
      const cmd = buildVoiceoverMuxCommand("/tmp/video.mp4", "/tmp/audio.mp3", "/tmp/final.mp4");
      expect(cmd).toBe('ffmpeg -y -i "/tmp/video.mp4" -i "/tmp/audio.mp3" -c:v copy -c:a aac -shortest "/tmp/final.mp4"');
    });
  });

  describe("runNewEnginePipelineForScenes — happy path", () => {
    it("renders a scene end-to-end via the legacy-candidate adapter (Visual Intelligence off)", async () => {
      vi.mocked(produceApprovedEDL).mockReturnValue({
        videoId: "vid1",
        edls: [fakeEDL(0)],
        review: fakeReviewReport(),
        approvedAt: new Date().toISOString(),
      } as ApprovedEDL);

      const result = await runNewEnginePipelineForScenes([sceneInput()], baseOptions());

      expect(result.approved).toBe(true);
      expect(result.outcomes).toEqual([{ sceneIndex: 0, status: "rendered", outputPath: "/tmp/out/scene_0.mp4" }]);
      expect(runAIDirector).toHaveBeenCalledTimes(1);
      expect(generateEDL).toHaveBeenCalledTimes(1);
      expect(generateReviewReport).toHaveBeenCalledTimes(1);
      expect(encode).toHaveBeenCalledTimes(1);
    });

    it("calls AI Director exactly once for the whole video, even with multiple scenes", async () => {
      vi.mocked(produceApprovedEDL).mockReturnValue({
        videoId: "vid1",
        edls: [fakeEDL(0), fakeEDL(1)],
        review: fakeReviewReport(),
        approvedAt: new Date().toISOString(),
      } as ApprovedEDL);

      await runNewEnginePipelineForScenes(
        [sceneInput({ scene: scene({ index: 0 }) }), sceneInput({ scene: scene({ index: 1 }) })],
        baseOptions()
      );

      expect(runAIDirector).toHaveBeenCalledTimes(1);
      expect((vi.mocked(runAIDirector).mock.calls[0]![0] as unknown[]).length).toBe(2);
    });

    it("uses Visual Intelligence Engine's candidate when the stage is enabled", async () => {
      vi.mocked(visualIntelligenceEngineStageEnabled).mockReturnValue(true);
      vi.mocked(runV2Pipeline).mockResolvedValue({
        videoId: "vid1",
        pipelineRunId: "run1",
        videoContext: {} as never,
        beatResults: [
          {
            intent: { beatId: "s0-b0" } as never,
            selectionResult: {
              selectedCandidate: {
                candidate: { candidate: { candidateId: "v2:asset1", width: 1920, height: 1080 } as never, rankingScore: 1, rankingBreakdown: {} as never, position: 1 },
              } as never,
            } as never,
            beatDurationMs: 10,
          },
        ],
        stageTimings: {} as never,
        durationMs: 10,
      });
      vi.mocked(produceApprovedEDL).mockReturnValue({
        videoId: "vid1",
        edls: [fakeEDL(0)],
        review: fakeReviewReport(),
        approvedAt: new Date().toISOString(),
      } as ApprovedEDL);

      const legacyMediaSearch = vi.fn(async () => candidatePick());
      await runNewEnginePipelineForScenes([sceneInput()], baseOptions({ legacyMediaSearch }));

      expect(runV2Pipeline).toHaveBeenCalledTimes(1);
      expect(legacyMediaSearch).not.toHaveBeenCalled();
    });
  });

  describe("failure isolation", () => {
    it("falls back a scene whose legacy Media Search finds no candidate, without affecting others", async () => {
      vi.mocked(produceApprovedEDL).mockReturnValue({
        videoId: "vid1",
        edls: [fakeEDL(1)],
        review: fakeReviewReport(),
        approvedAt: new Date().toISOString(),
      } as ApprovedEDL);

      const legacyMediaSearch = vi.fn(async (s: Scene) => (s.index === 0 ? null : candidatePick()));
      const result = await runNewEnginePipelineForScenes(
        [sceneInput({ scene: scene({ index: 0 }) }), sceneInput({ scene: scene({ index: 1 }), audioPath: "/tmp/a1.mp3" })],
        baseOptions({ legacyMediaSearch })
      );

      const scene0 = result.outcomes.find((o) => o.sceneIndex === 0)!;
      const scene1 = result.outcomes.find((o) => o.sceneIndex === 1)!;
      expect(scene0.status).toBe("fallback");
      expect(scene0.status === "fallback" && scene0.reason).toContain("candidate resolution failed");
      expect(scene1.status).toBe("rendered");
    });

    it("marks every scene as fallback when Editorial Review rejects the video", async () => {
      vi.mocked(generateReviewReport).mockReturnValue(fakeReviewReport({ approvalStatus: "rejected", overallScore: 20 }));
      vi.mocked(produceApprovedEDL).mockReturnValue(null);

      const result = await runNewEnginePipelineForScenes([sceneInput()], baseOptions());

      expect(result.approved).toBe(false);
      expect(result.outcomes).toEqual([
        { sceneIndex: 0, status: "fallback", reason: "Editorial Review rejected the video (rejected)" },
      ]);
      expect(encode).not.toHaveBeenCalled();
    });

    it("falls back only the scene whose Professional Render Engine encode fails", async () => {
      vi.mocked(produceApprovedEDL).mockReturnValue({
        videoId: "vid1",
        edls: [fakeEDL(0), fakeEDL(1)],
        review: fakeReviewReport(),
        approvedAt: new Date().toISOString(),
      } as ApprovedEDL);
      vi.mocked(encode).mockImplementation(async (plan) =>
        plan.scenes[0]!.sceneIndex === 0
          ? { outputPath: "x", succeeded: false, attempts: [{ attempt: 1, succeeded: false, error: "boom", durationMs: 5 }], usedGpu: false }
          : { outputPath: "x", succeeded: true, attempts: [{ attempt: 1, succeeded: true, durationMs: 5 }], usedGpu: false }
      );

      const result = await runNewEnginePipelineForScenes(
        [sceneInput({ scene: scene({ index: 0 }) }), sceneInput({ scene: scene({ index: 1 }), audioPath: "/tmp/a1.mp3" })],
        baseOptions()
      );

      const scene0 = result.outcomes.find((o) => o.sceneIndex === 0)!;
      const scene1 = result.outcomes.find((o) => o.sceneIndex === 1)!;
      expect(scene0.status).toBe("fallback");
      expect(scene0.status === "fallback" && scene0.reason).toContain("Professional Render Engine failed");
      expect(scene1.status).toBe("rendered");
    });

    it("calls the materialized clip's cleanup function after rendering", async () => {
      const cleanup = vi.fn();
      vi.mocked(loadArchiveAssetFile).mockResolvedValue({
        ok: true,
        result: { localPath: "/tmp/downloaded.mp4", mimeType: "video/mp4", cleanup },
      });
      vi.mocked(produceApprovedEDL).mockReturnValue({
        videoId: "vid1",
        edls: [fakeEDL(0)],
        review: fakeReviewReport(),
        approvedAt: new Date().toISOString(),
      } as ApprovedEDL);

      await runNewEnginePipelineForScenes([sceneInput()], baseOptions());

      expect(cleanup).toHaveBeenCalledTimes(1);
    });
  });
});
