/** Editorial Review Engine V2 — shared test fixtures.
 *  Not itself a test file (no `.test.ts` suffix, so vitest never collects it) — a builder
 *  helper reused by every reviewer's own test file, so the largish EditDecision/DirectorDecision
 *  shape only needs to be filled in once instead of ~10 times.
 */
import type {
  CaptionInstruction,
  EDL,
  EditDecision,
  ShotType,
  TransitionType,
} from "../cinematicEditingEngine/types";
import type { DirectorDecision, DirectorOutput } from "../aiDirector/types";

export function makeDecision(overrides: Partial<EditDecision> = {}): EditDecision {
  return {
    beatId: "b0",
    sceneIndex: 0,
    clip: {
      candidateId: "pexels:c1",
      assetType: "video",
      localPath: "/tmp/c1.mp4",
      remoteUrl: null,
      trimStartSec: 0,
      trimEndSec: 4,
      startSec: 0,
      endSec: 4,
      timingSource: "proportional_estimate",
    },
    shot: { shotType: "medium", reason: "test" },
    camera: { movement: "camera_hold", intensity: 0, reason: "test" },
    transitionIn: { type: "cut", durationSec: 0, reason: "test" },
    captions: [],
    motionGraphics: [],
    effects: [],
    sounds: [],
    pacing: { tone: "neutral", cutSpeedMultiplier: 1, movementIntensity: 0.5, reason: "test" },
    ...overrides,
  };
}

export function makeCaption(overrides: Partial<CaptionInstruction> = {}): CaptionInstruction {
  return {
    captionType: "location",
    text: "text",
    startSec: 0,
    endSec: 2,
    animation: "fade",
    position: "bottom-left",
    reason: "test",
    ...overrides,
  };
}

export function makeEDL(sceneIndex: number, decisions: EditDecision[]): EDL {
  const totalDurationSec = decisions.reduce((max, d) => Math.max(max, d.clip.endSec), 0);
  return { sceneIndex, decisions, totalDurationSec };
}

export function makeDirectorDecision(overrides: Partial<DirectorDecision> = {}): DirectorDecision {
  return {
    sceneIndex: 0,
    primarySubject: "Apple",
    secondarySubject: null,
    narrativeFunction: "explain",
    narrativePurpose: "test",
    emotion: "neutral",
    visualStrategy: "b_roll",
    supportingVisuals: [],
    shotOrder: [],
    pacing: "medium",
    energyTrend: "steady",
    transitionStyle: "cut",
    textOverlaySuggestion: null,
    soundCueSuggestion: null,
    attentionRecommendations: [],
    hookGuidance: { isHookSegment: false, recommendations: [], reason: "test" },
    retentionRisk: { isAtRisk: false, reason: "test", recommendations: [] },
    reason: "test",
    ...overrides,
  };
}

export function makeDirectorOutput(decisions: DirectorDecision[], overrides: Partial<DirectorOutput> = {}): DirectorOutput {
  return {
    decisions,
    hookWindowSec: 30,
    highlightMoments: [],
    retentionRisks: decisions.filter((d) => d.retentionRisk.isAtRisk).map((d) => ({ ...d.retentionRisk, sceneIndex: d.sceneIndex })),
    totalVideoDurationSec: decisions.length * 10,
    ...overrides,
  };
}

export function beatsOfShotTypes(sceneIndex: number, shotTypes: ShotType[]): EditDecision[] {
  return shotTypes.map((shotType, i) =>
    makeDecision({ beatId: `s${sceneIndex}b${i}`, sceneIndex, shot: { shotType, reason: "test" } })
  );
}

export function beatsOfTransitions(sceneIndex: number, types: TransitionType[]): EditDecision[] {
  return types.map((type, i) =>
    makeDecision({ beatId: `s${sceneIndex}b${i}`, sceneIndex, transitionIn: { type, durationSec: type === "cut" ? 0 : 0.5, reason: "test" } })
  );
}
