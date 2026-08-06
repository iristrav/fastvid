import { describe, expect, it } from "vitest";
import { planEditDecision, planRender, planScene, type ClipAssetResolver } from "./renderPlanner";
import type {
  ApprovedEDL,
  CameraInstruction,
  CaptionInstruction,
  ClipInstruction,
  EDL,
  EditDecision,
  MotionGraphicInstruction,
} from "./types";

const CAMERA_HOLD: CameraInstruction = { movement: "camera_hold", intensity: 0, reason: "static" };
const DIMS_16_9 = { width: 1920, height: 1080 };

const resolveClipAsset: ClipAssetResolver = (clip) => ({
  inputLabel: `${clip.candidateId}:v`,
  sourceDims: { width: 1920, height: 1080 },
});

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

function caption(overrides: Partial<CaptionInstruction> = {}): CaptionInstruction {
  return {
    captionType: "title",
    text: "Hello",
    startSec: 0.5,
    endSec: 3,
    animation: "fade",
    position: "center",
    reason: "test",
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

describe("Render Planner (Phase 7)", () => {
  describe("planEditDecision", () => {
    it("produces a clip step combining clip and camera fragments", () => {
      const { steps } = planEditDecision(decision({ camera: { movement: "zoom_in", intensity: 0.5, reason: "push in" } }), "16:9", DIMS_16_9, resolveClipAsset);
      const clipStep = steps.find((s) => s.stepType === "clip")!;
      expect(clipStep.filterFragments.length).toBeGreaterThan(1);
      expect(clipStep.filterFragments.some((f) => f.filter.includes("zoompan"))).toBe(true);
      expect(clipStep.filterFragments.some((f) => f.filter.includes("scale="))).toBe(true);
    });

    it("always emits a transition step with no fragments (the join happens in timelineRenderer)", () => {
      const { steps } = planEditDecision(decision(), "16:9", DIMS_16_9, resolveClipAsset);
      const transitionStep = steps.find((s) => s.stepType === "transition")!;
      expect(transitionStep.filterFragments).toEqual([]);
    });

    it("emits one caption step per caption instruction, with real filter fragments", () => {
      const { steps } = planEditDecision(
        decision({ captions: [caption({ text: "A" }), caption({ text: "B", captionType: "subtitle" })] }),
        "16:9",
        DIMS_16_9,
        resolveClipAsset
      );
      const captionSteps = steps.filter((s) => s.stepType === "caption");
      expect(captionSteps).toHaveLength(2);
      expect(captionSteps[0]!.filterFragments[0]!.filter).toContain("drawtext=text='A'");
      expect(captionSteps[1]!.filterFragments[0]!.filter).toContain("drawtext=text='B'");
    });

    it("emits one effect step per effect instruction", () => {
      const { steps } = planEditDecision(
        decision({ effects: [{ effectType: "vignette", intensity: 1, reason: "x" }, { effectType: "film_grain", intensity: 1, reason: "x" }] }),
        "16:9",
        DIMS_16_9,
        resolveClipAsset
      );
      expect(steps.filter((s) => s.stepType === "effect")).toHaveLength(2);
    });

    it("non-asset motion graphics get real fragments; asset-based ones are planned with none", () => {
      const graphics: MotionGraphicInstruction[] = [
        { graphicType: "progress_bar", data: {}, startSec: 0, durationSec: 2, reason: "x" },
        { graphicType: "map", data: {}, startSec: 0, durationSec: 2, reason: "x" },
      ];
      const { steps } = planEditDecision(decision({ motionGraphics: graphics }), "16:9", DIMS_16_9, resolveClipAsset);
      const graphicSteps = steps.filter((s) => s.stepType === "motion_graphic");
      expect(graphicSteps).toHaveLength(2);
      const progressStep = graphicSteps.find((s) => s.description.includes("progress_bar"))!;
      const mapStep = graphicSteps.find((s) => s.description.includes("map"))!;
      expect(progressStep.filterFragments.length).toBeGreaterThan(0);
      expect(mapStep.filterFragments).toEqual([]);
      expect(mapStep.description).toContain("not yet resolved");
    });

    it("emits one audio step per sound instruction, currently with no fragments (SFX asset gap)", () => {
      const { steps } = planEditDecision(
        decision({ sounds: [{ soundType: "whoosh", timeSec: 1, volume: 0.5, fadeInSec: 0, fadeOutSec: 0, reason: "x" }] }),
        "16:9",
        DIMS_16_9,
        resolveClipAsset
      );
      const audioSteps = steps.filter((s) => s.stepType === "audio");
      expect(audioSteps).toHaveLength(1);
      expect(audioSteps[0]!.filterFragments).toEqual([]);
    });

    it("returns fragments in visual order: clip, camera, effects, captions, graphics", () => {
      const { fragments } = planEditDecision(
        decision({
          camera: { movement: "zoom_in", intensity: 0.5, reason: "x" },
          effects: [{ effectType: "vignette", intensity: 1, reason: "x" }],
          captions: [caption()],
          motionGraphics: [{ graphicType: "progress_bar", data: {}, startSec: 0, durationSec: 2, reason: "x" }],
        }),
        "16:9",
        DIMS_16_9,
        resolveClipAsset
      );
      const kinds = fragments.map((f) =>
        f.filter.includes("zoompan")
          ? "camera"
          : f.filter.includes("vignette")
            ? "effect"
            : f.filter.includes("drawtext=text='Hello'")
              ? "caption"
              : f.filter.includes("drawbox")
                ? "graphic"
                : "clip"
      );
      expect(kinds.indexOf("clip")).toBeLessThan(kinds.indexOf("camera"));
      expect(kinds.indexOf("camera")).toBeLessThan(kinds.indexOf("effect"));
      expect(kinds.indexOf("effect")).toBeLessThan(kinds.indexOf("caption"));
    });
  });

  describe("planScene", () => {
    function edl(decisions: EditDecision[]): EDL {
      return { sceneIndex: 0, decisions, totalDurationSec: decisions.reduce((m, d) => Math.max(m, d.clip.endSec), 0) };
    }

    it("aggregates steps across every beat in the scene", () => {
      const d0 = decision({ beatId: "s0-b0", clip: clip({ candidateId: "c0", startSec: 0, endSec: 4 }) });
      const d1 = decision({
        beatId: "s0-b1",
        clip: clip({ candidateId: "c1", startSec: 4, endSec: 7 }),
        transitionIn: { type: "cross_dissolve", durationSec: 0.5, reason: "x" },
      });
      const scenePlan = planScene(edl([d0, d1]), "16:9", DIMS_16_9, resolveClipAsset);
      expect(scenePlan.steps.filter((s) => s.beatId === "s0-b0").length).toBeGreaterThan(0);
      expect(scenePlan.steps.filter((s) => s.beatId === "s0-b1").length).toBeGreaterThan(0);
    });

    it("produces a non-empty filterComplex joining beats via the EDL's transition choice", () => {
      const d0 = decision({ beatId: "s0-b0", clip: clip({ candidateId: "c0", startSec: 0, endSec: 4 }) });
      const d1 = decision({
        beatId: "s0-b1",
        clip: clip({ candidateId: "c1", startSec: 4, endSec: 7 }),
        transitionIn: { type: "cross_dissolve", durationSec: 0.5, reason: "x" },
      });
      const scenePlan = planScene(edl([d0, d1]), "16:9", DIMS_16_9, resolveClipAsset);
      expect(scenePlan.filterComplex).toContain("xfade=transition=dissolve");
      expect(scenePlan.outputLabel.length).toBeGreaterThan(0);
      expect(scenePlan.durationSec).toBeGreaterThan(0);
    });

    it("audioFilterComplex stays empty — the honest, documented SFX-asset gap", () => {
      const d0 = decision({ sounds: [{ soundType: "whoosh", timeSec: 1, volume: 0.5, fadeInSec: 0, fadeOutSec: 0, reason: "x" }] });
      const scenePlan = planScene(edl([d0]), "16:9", DIMS_16_9, resolveClipAsset);
      expect(scenePlan.audioFilterComplex).toBe("");
    });
  });

  describe("planRender", () => {
    function approvedEdl(edls: EDL[]): ApprovedEDL {
      return { videoId: "vid123", edls } as unknown as ApprovedEDL;
    }

    it("plans every scene in the EDL and sums their durations", () => {
      const scene0 = { sceneIndex: 0, decisions: [decision({ beatId: "s0-b0" })], totalDurationSec: 4 };
      const scene1 = {
        sceneIndex: 1,
        decisions: [decision({ beatId: "s1-b0", sceneIndex: 1, clip: clip({ candidateId: "c1" }) })],
        totalDurationSec: 4,
      };
      const plan = planRender(approvedEdl([scene0, scene1]), "16:9", resolveClipAsset);
      expect(plan.videoId).toBe("vid123");
      expect(plan.aspectRatio).toBe("16:9");
      expect(plan.dimensions).toEqual(DIMS_16_9);
      expect(plan.scenes).toHaveLength(2);
      expect(plan.totalDurationSec).toBeCloseTo(8, 5);
    });

    it("uses the correct dimensions for a non-16:9 target", () => {
      const scene0 = { sceneIndex: 0, decisions: [decision()], totalDurationSec: 4 };
      const plan = planRender(approvedEdl([scene0]), "9:16", resolveClipAsset);
      expect(plan.dimensions).toEqual({ width: 1080, height: 1920 });
    });
  });
});
