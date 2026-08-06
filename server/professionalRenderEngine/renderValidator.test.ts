import { describe, expect, it } from "vitest";
import { mergeValidationResults, validateEDL, validateRenderPlan } from "./renderValidator";
import type {
  ApprovedEDL,
  CameraInstruction,
  CaptionInstruction,
  ClipInstruction,
  EDL,
  EditDecision,
  RenderPlan,
  SceneRenderPlan,
  TransitionInstruction,
} from "./types";

const CAMERA_HOLD: CameraInstruction = { movement: "camera_hold", intensity: 0, reason: "static" };

function clip(overrides: Partial<ClipInstruction> = {}): ClipInstruction {
  return {
    candidateId: "c1",
    assetType: "video",
    localPath: "/tmp/c1.mp4",
    remoteUrl: null,
    trimStartSec: 0,
    trimEndSec: 4,
    startSec: 0,
    endSec: 4,
    timingSource: "tts_word_alignment",
    ...overrides,
  };
}

function cutIn(durationSec = 0): TransitionInstruction {
  return { type: "cut", durationSec, reason: "cut" };
}

function decision(overrides: Partial<EditDecision> = {}): EditDecision {
  return {
    beatId: "s0-b0",
    sceneIndex: 0,
    clip: clip(),
    shot: { shotType: "medium", reason: "test" },
    camera: CAMERA_HOLD,
    transitionIn: cutIn(),
    captions: [],
    motionGraphics: [],
    effects: [],
    sounds: [],
    pacing: { tone: "neutral", cutSpeedMultiplier: 1, movementIntensity: 0.3, reason: "test" },
    ...overrides,
  };
}

function edl(decisions: EditDecision[], sceneIndex = 0): EDL {
  const totalDurationSec = decisions.reduce((max, d) => Math.max(max, d.clip.endSec), 0);
  return { sceneIndex, decisions, totalDurationSec };
}

function approvedEdl(edls: EDL[]): ApprovedEDL {
  return { edls } as unknown as ApprovedEDL;
}

function caption(overrides: Partial<CaptionInstruction> = {}): CaptionInstruction {
  return {
    captionType: "title",
    text: "Hello",
    startSec: 0,
    endSec: 2,
    animation: "fade",
    position: "center",
    reason: "test",
    ...overrides,
  };
}

describe("Render Validator (Phase 7)", () => {
  describe("validateEDL", () => {
    it("passes a well-formed single-scene EDL", () => {
      const result = validateEDL(approvedEdl([edl([decision()])]));
      expect(result.isValid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it("flags a missing clip when neither localPath nor remoteUrl is set", () => {
      const result = validateEDL(approvedEdl([edl([decision({ clip: clip({ localPath: null, remoteUrl: null }) })])]));
      expect(result.isValid).toBe(false);
      expect(result.issues.some((i) => i.type === "missing_clip")).toBe(true);
    });

    it("does not flag missing_clip when only remoteUrl is set", () => {
      const result = validateEDL(
        approvedEdl([edl([decision({ clip: clip({ localPath: null, remoteUrl: "https://example.com/c1.mp4" }) })])])
      );
      expect(result.issues.some((i) => i.type === "missing_clip")).toBe(false);
    });

    it("flags invalid timestamps when endSec <= startSec", () => {
      const result = validateEDL(approvedEdl([edl([decision({ clip: clip({ startSec: 3, endSec: 3 }) })])]));
      expect(result.issues.some((i) => i.type === "invalid_timestamp")).toBe(true);
    });

    it("flags invalid timestamps for a negative or empty video trim span", () => {
      const result = validateEDL(approvedEdl([edl([decision({ clip: clip({ trimStartSec: 5, trimEndSec: 5 }) })])]));
      expect(result.issues.some((i) => i.type === "invalid_timestamp")).toBe(true);
    });

    it("does not check trim span for images", () => {
      const result = validateEDL(
        approvedEdl([edl([decision({ clip: clip({ assetType: "image", trimStartSec: 0, trimEndSec: 0 }) })])])
      );
      expect(result.issues.some((i) => i.type === "invalid_timestamp")).toBe(false);
    });

    it("flags a broken transition when its duration is longer than the beat itself", () => {
      const result = validateEDL(
        approvedEdl([
          edl([decision({ clip: clip({ startSec: 0, endSec: 1 }), transitionIn: { type: "fade", durationSec: 3, reason: "x" } })]),
        ])
      );
      expect(result.issues.some((i) => i.type === "broken_transition")).toBe(true);
    });

    it("flags a broken transition for a negative duration", () => {
      const result = validateEDL(
        approvedEdl([edl([decision({ transitionIn: { type: "fade", durationSec: -1, reason: "x" } })])])
      );
      expect(result.issues.some((i) => i.type === "broken_transition")).toBe(true);
    });

    it("flags a missing caption when caption text is blank", () => {
      const result = validateEDL(approvedEdl([edl([decision({ captions: [caption({ text: "   " })] })])]));
      expect(result.issues.some((i) => i.type === "missing_caption")).toBe(true);
    });

    it("flags overlapping edits beyond what the transition duration allows", () => {
      const b0 = decision({ beatId: "s0-b0", clip: clip({ startSec: 0, endSec: 4 }) });
      const b1 = decision({
        beatId: "s0-b1",
        clip: clip({ startSec: 1, endSec: 5 }), // 3s overlap
        transitionIn: { type: "fade", durationSec: 0.5, reason: "x" }, // only 0.5s allowed
      });
      const result = validateEDL(approvedEdl([edl([b0, b1])]));
      expect(result.issues.some((i) => i.type === "overlapping_edit")).toBe(true);
    });

    it("does not flag the expected crossfade overlap as an overlapping edit", () => {
      const b0 = decision({ beatId: "s0-b0", clip: clip({ startSec: 0, endSec: 4 }) });
      const b1 = decision({
        beatId: "s0-b1",
        clip: clip({ startSec: 3.5, endSec: 7.5 }), // 0.5s overlap
        transitionIn: { type: "fade", durationSec: 0.5, reason: "x" },
      });
      const result = validateEDL(approvedEdl([edl([b0, b1])]));
      expect(result.issues.some((i) => i.type === "overlapping_edit")).toBe(false);
    });
  });

  describe("validateRenderPlan", () => {
    function scenePlan(overrides: Partial<SceneRenderPlan> = {}): SceneRenderPlan {
      return {
        sceneIndex: 0,
        steps: [],
        filterComplex: "[0:v]scale=1920:1080[out]",
        outputLabel: "out",
        audioFilterComplex: "[0:a]volume=1.0[aout]",
        audioOutputLabel: "aout",
        durationSec: 4,
        ...overrides,
      };
    }

    function renderPlan(scenes: SceneRenderPlan[]): RenderPlan {
      return {
        videoId: "v1",
        aspectRatio: "16:9",
        dimensions: { width: 1920, height: 1080 },
        scenes,
        totalDurationSec: scenes.reduce((s, sc) => s + sc.durationSec, 0),
      };
    }

    it("passes a well-formed render plan with matching captions and audio", () => {
      const d = decision({ captions: [caption()] });
      const plan = renderPlan([
        scenePlan({
          steps: [{ stepType: "caption", sceneIndex: 0, beatId: "s0-b0", description: "title", filterFragments: [], startSec: 0, endSec: 2 }],
        }),
      ]);
      const result = validateRenderPlan(approvedEdl([edl([d])]), plan);
      expect(result.isValid).toBe(true);
    });

    it("flags a scene missing from the RenderPlan entirely", () => {
      const result = validateRenderPlan(approvedEdl([edl([decision()])]), renderPlan([]));
      expect(result.issues.some((i) => i.type === "invalid_filter" && i.description.includes("No RenderPlan entry"))).toBe(true);
    });

    it("flags unbalanced brackets in filterComplex", () => {
      const plan = renderPlan([scenePlan({ filterComplex: "[0:v]scale=1920:1080[out" })]);
      const result = validateRenderPlan(approvedEdl([edl([decision()])]), plan);
      expect(result.issues.some((i) => i.type === "invalid_filter")).toBe(true);
    });

    it("does not flag a quoted expression containing brackets as unbalanced", () => {
      const plan = renderPlan([scenePlan({ filterComplex: "[0:v]drawtext=text='[test]':x=0[out]" })]);
      const result = validateRenderPlan(approvedEdl([edl([decision()])]), plan);
      expect(result.issues.some((i) => i.type === "invalid_filter")).toBe(false);
    });

    it("flags a caption in the EDL with no matching caption RenderStep", () => {
      const d = decision({ captions: [caption()] });
      const plan = renderPlan([scenePlan({ steps: [] })]);
      const result = validateRenderPlan(approvedEdl([edl([d])]), plan);
      expect(result.issues.some((i) => i.type === "missing_caption")).toBe(true);
    });

    it("flags audio desync when the EDL has sounds but the scene's audioFilterComplex is empty", () => {
      const d = decision({ sounds: [{ soundType: "whoosh", timeSec: 1, volume: 0.5, fadeInSec: 0, fadeOutSec: 0, reason: "x" }] });
      const plan = renderPlan([scenePlan({ audioFilterComplex: "" })]);
      const result = validateRenderPlan(approvedEdl([edl([d])]), plan);
      expect(result.issues.some((i) => i.type === "audio_desync")).toBe(true);
    });
  });

  describe("mergeValidationResults", () => {
    it("combines issues from both results and is valid only if both were valid", () => {
      const a = validateEDL(approvedEdl([edl([decision()])]));
      const b = validateEDL(approvedEdl([edl([decision({ clip: clip({ localPath: null, remoteUrl: null }) })])]));
      const merged = mergeValidationResults(a, b);
      expect(merged.isValid).toBe(false);
      expect(merged.issues.length).toBe(a.issues.length + b.issues.length);
    });
  });
});
