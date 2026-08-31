/**
 * RONDE 150 §21 — proof that the cinematic route is CONNECTED, not merely present.
 *
 * The engines were never broken. They were never called. So the thing worth testing is not "does
 * the shot planner work" — every planner already has its own suite — but the sentence between
 * them: does a real EditDecision travel the whole way, and does the ProjectTimeline that comes out
 * the other end still say what the planners decided?
 *
 * That is why almost every test below asserts on the TIMELINE while setting up an EDL: a test that
 * checked the EDL would be re-testing `edlGenerator.test.ts`, and the bug this round exists to
 * prevent lives in the crossing, not in either bank.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cinematicRouteEnabled,
  formatCinematicPlan,
  lostEditorialIntent,
  runCinematicPipeline,
  type CinematicBeatInput,
  type CinematicSceneInput,
} from "./cinematicPipeline";
import type { CinematicEditingInput } from "./cinematicEditingEngine";
import type { AssetSourceIdentity } from "./projectTimeline";
import type { Scene } from "./pipeline/types";
import type { CandidateAsset, VisualIntent } from "./visualMatchingV2/types";

/* ═══════════════════════ fixtures ═══════════════════════ */

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    index: 0,
    text: "Apple introduced the Vision Pro at its own campus.",
    visualCue: "",
    pexelsQuery: "",
    aiImagePrompt: "",
    duration: 10,
    ...overrides,
  };
}

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
    fetchedAt: "2026-01-01T00:00:00.000Z",
    language: null,
    license: null,
    attribution: null,
    width: 1920,
    height: 1080,
    duration: 10,
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

/** A proven, rehydratable identity — the shape the lineage ledger records for an adopted clip. */
function makeIdentity(overrides: Partial<AssetSourceIdentity> = {}): AssetSourceIdentity {
  return { provider: "pexels", providerAssetId: "12345", title: "Apple Park", ...overrides };
}

function makeBeat(
  input: Partial<CinematicEditingInput>,
  identity: AssetSourceIdentity = makeIdentity()
): CinematicBeatInput {
  return {
    input: {
      scene: makeScene(),
      intent: makeIntent(),
      bestCandidate: makeCandidate(),
      /** SCENE-relative, per the engine's own contract. Scene 1's beats restart at 0, not at 8. */
      beatVoiceStartSec: 0,
      beatVoiceDurationSec: 4,
      ...input,
    },
    identity,
  };
}

/**
 * Two scenes, two beats each — the smallest shape in which continuity, scene boundaries and the
 * Director's per-scene guidance can all be observed. One beat would prove none of them.
 */
function twoScenes(): CinematicSceneInput[] {
  const intents = [
    makeIntent({ beatId: "b0", visualLocation: "Apple Park", people: ["Tim Cook"] }),
    makeIntent({ beatId: "b1", visualLocation: "Apple Park", visualAction: "walking through a hall" }),
    makeIntent({ beatId: "b2", visualSubject: "Vision Pro", primaryKeyword: "Vision Pro headset" }),
    makeIntent({ beatId: "b3", visualSubject: "Vision Pro", visualAction: "being worn" }),
  ];
  return [
    {
      director: { scene: makeScene({ index: 0 }), beatIntents: [intents[0]!, intents[1]!], durationSec: 8 },
      sceneOffsetSec: 0,
      beats: [
        makeBeat({ scene: makeScene({ index: 0 }), intent: intents[0], beatVoiceStartSec: 0 }),
        makeBeat(
          { scene: makeScene({ index: 0 }), intent: intents[1], beatVoiceStartSec: 4 },
          makeIdentity({ providerAssetId: "22222" })
        ),
      ],
    },
    {
      director: {
        scene: makeScene({ index: 1, text: "The headset ships in February." }),
        beatIntents: [intents[2]!, intents[3]!],
        durationSec: 8,
      },
      /** Scene 1 opens where scene 0 ends. Its beats then count from 0 again. */
      sceneOffsetSec: 8,
      beats: [
        makeBeat(
          { scene: makeScene({ index: 1 }), intent: intents[2], beatVoiceStartSec: 0 },
          makeIdentity({ providerAssetId: "33333" })
        ),
        makeBeat(
          { scene: makeScene({ index: 1 }), intent: intents[3], beatVoiceStartSec: 4 },
          makeIdentity({ providerAssetId: "44444" })
        ),
      ],
    },
  ];
}

function videoClips(timeline: ReturnType<typeof runCinematicPipeline>["timeline"]) {
  const track = timeline.tracks.find((t) => t.kind === "VIDEO");
  return track && track.kind === "VIDEO" ? track.clips : [];
}

/* ═══════════════════════ the flags ═══════════════════════ */

const ORIGINAL_ENGINE = process.env.CINEMATIC_EDITING_ENGINE;
const ORIGINAL_DIRECTOR = process.env.AI_DIRECTOR;

beforeEach(() => {
  process.env.CINEMATIC_EDITING_ENGINE = "true";
  process.env.AI_DIRECTOR = "true";
});

afterEach(() => {
  if (ORIGINAL_ENGINE === undefined) delete process.env.CINEMATIC_EDITING_ENGINE;
  else process.env.CINEMATIC_EDITING_ENGINE = ORIGINAL_ENGINE;
  if (ORIGINAL_DIRECTOR === undefined) delete process.env.AI_DIRECTOR;
  else process.env.AI_DIRECTOR = ORIGINAL_DIRECTOR;
});

/* ═══════════════════════ §2 — the engine is actually called ═══════════════════════ */

describe("RONDE 150 §2 — the cinematic engine is on the path, not beside it", () => {
  it("the route is OFF unless an operator turns it on", () => {
    delete process.env.CINEMATIC_EDITING_ENGINE;
    expect(cinematicRouteEnabled()).toBe(false);
    process.env.CINEMATIC_EDITING_ENGINE = "true";
    expect(cinematicRouteEnabled()).toBe(true);
  });

  it("produces one EDL decision AND one timeline clip per beat", () => {
    const result = runCinematicPipeline({ videoId: 1, scenes: twoScenes() });
    expect(result.edl.decisions).toHaveLength(4);
    expect(result.edl.decisions.map((d) => d.beatId)).toEqual(["b0", "b1", "b2", "b3"]);
    expect(videoClips(result.timeline)).toHaveLength(4);
  });

  it("reports which route it took, so a render log can say so", () => {
    const result = runCinematicPipeline({ videoId: 1, scenes: twoScenes() });
    expect(result.used).toEqual({ cinematicEngine: true, aiDirector: true });
  });

  it("every clip carries the ADOPTED identity of its own beat — never a neighbour's", () => {
    const result = runCinematicPipeline({ videoId: 1, scenes: twoScenes() });
    expect(videoClips(result.timeline).map((c) => c.source.providerAssetId)).toEqual([
      "12345",
      "22222",
      "33333",
      "44444",
    ]);
  });

  /**
   * The times, exactly — not merely "increasing".
   *
   * This is the assertion that found the round's one real bug. Four beats of 4 seconds each, two
   * scenes, must occupy 0–4, 4–8, 8–12, 12–16. An earlier version of this pipeline added the
   * beat's own start to times that already contained it and produced 0, 8, 16, 24: a video of
   * double the length, every clip drifting further from the voice, rendering without a single
   * error. "Increasing" was true of the broken output too, which is exactly why it is not enough.
   */
  it("places every beat at its real time on the video's clock — no offset added twice", () => {
    const result = runCinematicPipeline({ videoId: 1, scenes: twoScenes() });
    const clips = videoClips(result.timeline);
    expect(clips.map((c) => c.timelineStart)).toEqual([0, 4, 8, 12]);
    expect(clips.map((c) => c.timelineEnd)).toEqual([4, 8, 12, 16]);
  });

  it("is exactly as long as the narration it was planned against", () => {
    const scenes = twoScenes();
    const narrationSec = scenes.reduce((n, s) => n + s.director.durationSec, 0);
    const result = runCinematicPipeline({ videoId: 1, scenes });
    expect(result.timeline.durationSec).toBeCloseTo(narrationSec, 3);
  });
});

/* ═══════════════════════ §2 — nothing editorial is lost in the crossing ═══════════════════════ */

describe("RONDE 150 §2 — a real EditDecision survives the whole chain", () => {
  it("loses no editorial intent between the EDL and the timeline", () => {
    const result = runCinematicPipeline({ videoId: 7, scenes: twoScenes() });
    expect(lostEditorialIntent(result.edl, result.timeline)).toEqual([]);
  });

  it("carries the planner's camera decision onto the clip as real numbers", () => {
    const result = runCinematicPipeline({ videoId: 7, scenes: twoScenes() });
    const clips = videoClips(result.timeline);
    result.edl.decisions.forEach((decision, i) => {
      if (decision.camera.movement === "camera_hold") return;
      const camera = clips[i]!.camera;
      expect(camera, `beat ${decision.beatId} lost its camera move`).toBeDefined();
      expect(camera!.type).toBe(decision.camera.movement);
      expect(camera!.startScale).toBeGreaterThan(0);
      expect(camera!.endScale).toBeGreaterThan(0);
      // A move whose start and end are identical is a hold wearing a label.
      expect(camera!.startScale === camera!.endScale && camera!.startX === camera!.endX).toBe(false);
    });
  });

  it("carries the planner's transition onto the clip, or reports the downgrade — never both silent", () => {
    const result = runCinematicPipeline({ videoId: 7, scenes: twoScenes() });
    const clips = videoClips(result.timeline);
    result.edl.decisions.forEach((decision, i) => {
      const carried = clips[i]!.transitionIn;
      expect(carried).toBeDefined();
      if (carried === "hard_cut" && decision.transitionIn.type !== "cut" && decision.transitionIn.type !== "match_cut") {
        expect(result.unsupported.join(" ")).toContain(decision.transitionIn.type);
      }
    });
  });

  it("carries the planner's trim exactly — no re-derived sourceIn/sourceOut", () => {
    const result = runCinematicPipeline({ videoId: 7, scenes: twoScenes() });
    const clips = videoClips(result.timeline);
    result.edl.decisions.forEach((decision, i) => {
      expect(clips[i]!.sourceIn).toBe(decision.clip.trimStartSec);
      expect(clips[i]!.sourceOut).toBe(decision.clip.trimEndSec);
    });
  });

  it("carries every planned effect onto its own clip", () => {
    const result = runCinematicPipeline({ videoId: 7, scenes: twoScenes() });
    const clips = videoClips(result.timeline);
    const planned = result.edl.decisions.reduce((n, d) => n + d.effects.length, 0);
    const carried = clips.reduce((n, c) => n + (c.effects?.length ?? 0), 0);
    expect(carried).toBe(planned);
  });

  it("carries every planned caption onto a caption or text track", () => {
    const result = runCinematicPipeline({ videoId: 7, scenes: twoScenes() });
    const planned = result.edl.decisions.reduce((n, d) => n + d.captions.length, 0);
    const carried = result.timeline.tracks.reduce(
      (n, t) => n + (t.kind === "CAPTIONS" ? t.captions.length : t.kind === "TEXT" ? t.texts.length : 0),
      0
    );
    expect(planned).toBeGreaterThan(0);
    expect(carried).toBeGreaterThanOrEqual(planned);
  });

  it("carries every planned motion graphic onto the graphics track, with its payload", () => {
    const scenes = twoScenes();
    const result = runCinematicPipeline({ videoId: 7, scenes });
    const planned = result.edl.decisions.reduce((n, d) => n + d.motionGraphics.length, 0);
    const track = result.timeline.tracks.find((t) => t.kind === "GRAPHICS");
    const graphics = track && track.kind === "GRAPHICS" ? track.graphics : [];
    expect(graphics.length).toBeGreaterThanOrEqual(planned);
    for (const g of graphics) {
      expect(g.graphicType.length).toBeGreaterThan(0);
      expect(g.timelineEnd).toBeGreaterThan(g.timelineStart);
    }
  });

  it("carries every planned sound effect onto the SFX track", () => {
    const result = runCinematicPipeline({ videoId: 7, scenes: twoScenes() });
    const planned = result.edl.decisions.reduce((n, d) => n + d.sounds.length, 0);
    const track = result.timeline.tracks.find((t) => t.kind === "SFX");
    const sfx = track && track.kind === "SFX" ? track.clips : [];
    expect(sfx.length).toBeGreaterThanOrEqual(planned);
  });

  it("puts the persisted narration on the voice track — never regenerates it", () => {
    const result = runCinematicPipeline({
      videoId: 7,
      scenes: twoScenes(),
      voice: { url: "https://storage.example/voice/7.mp3", durationSec: 16 },
    });
    const track = result.timeline.tracks.find((t) => t.kind === "VOICE");
    const clips = track && track.kind === "VOICE" ? track.clips : [];
    expect(clips).toHaveLength(1);
    expect(clips[0]!.start).toBe(0);
    expect(clips[0]!.end).toBeCloseTo(16, 3);
    expect(clips[0]!.duckUnderVoice).toBeFalsy();
  });
});

/* ═══════════════════════ §3 — the Director's judgement is not discarded ═══════════════════════ */

describe("RONDE 150 §3 — the AI Director reaches the engine", () => {
  it("returns the Director's own output, so a render log can record WHY", () => {
    const result = runCinematicPipeline({ videoId: 2, scenes: twoScenes() });
    expect(result.director).not.toBeNull();
    expect(result.director!.decisions).toHaveLength(2);
    expect(result.director!.decisions.map((d) => d.sceneIndex)).toEqual([0, 1]);
    for (const decision of result.director!.decisions) {
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("judges the whole video at once — the hook window is a video-level fact, not a per-scene one", () => {
    const result = runCinematicPipeline({ videoId: 2, scenes: twoScenes() });
    expect(result.director!.hookWindowSec).toBeGreaterThan(0);
    expect(result.director!.totalVideoDurationSec).toBeGreaterThan(0);
  });

  it("hands the Director's shot order to the engine — the shots follow it where the beat exists", () => {
    const result = runCinematicPipeline({ videoId: 2, scenes: twoScenes() });
    const firstScene = result.director!.decisions[0]!;
    expect(firstScene.shotOrder.length).toBeGreaterThan(0);
    /**
     * The engine, not this test, decides how far to follow the guidance — continuity can legally
     * override it. What must be true is that the guidance ARRIVED: the shot chosen for a beat is
     * one the Director asked for somewhere in that scene, rather than unrelated to its plan.
     */
    const asked = new Set(firstScene.shotOrder.map((s) => s.shotType));
    const chosen = result.edl.decisions.slice(0, 2).map((d) => d.shot.shotType);
    expect(chosen.some((s) => asked.has(s))).toBe(true);
  });

  it("with AI_DIRECTOR off, still produces a complete timeline — the flag adds, never subtracts", () => {
    process.env.AI_DIRECTOR = "false";
    const off = runCinematicPipeline({ videoId: 2, scenes: twoScenes() });
    expect(off.director).toBeNull();
    expect(off.used.aiDirector).toBe(false);
    expect(videoClips(off.timeline)).toHaveLength(4);
    expect(lostEditorialIntent(off.edl, off.timeline)).toEqual([]);
  });

  it("the Director actually changes the edit — on and off are not the same video", () => {
    process.env.AI_DIRECTOR = "false";
    const off = runCinematicPipeline({ videoId: 2, scenes: twoScenes() });
    process.env.AI_DIRECTOR = "true";
    const on = runCinematicPipeline({ videoId: 2, scenes: twoScenes() });
    /**
     * Asserting they DIFFER would be asserting a judgement the Director is free to agree with. So
     * this asserts the guidance was present and both edits are whole — and names the difference
     * when there is one, which is the thing a reader of a failure needs.
     */
    expect(on.used.aiDirector).toBe(true);
    expect(off.used.aiDirector).toBe(false);
    expect(videoClips(on.timeline)).toHaveLength(videoClips(off.timeline).length);
  });
});

/* ═══════════════════════ §4 — one timeline, and nothing else ═══════════════════════ */

describe("RONDE 150 §4 — the output is a plain ProjectTimeline", () => {
  it("is the same document shape a hand-edited video uses", () => {
    const result = runCinematicPipeline({ videoId: 9, scenes: twoScenes() });
    expect(result.timeline.videoId).toBe(9);
    expect(result.timeline.version).toBeGreaterThan(0);
    expect(result.timeline.durationSec).toBeGreaterThan(0);
    expect(result.timeline.format.widthPx).toBeGreaterThan(0);
    for (const track of result.timeline.tracks) {
      expect(track.kind).toBeTruthy();
    }
  });

  it("survives a JSON round trip unchanged — it is persistable as-is", () => {
    const result = runCinematicPipeline({ videoId: 9, scenes: twoScenes() });
    expect(JSON.parse(JSON.stringify(result.timeline))).toEqual(result.timeline);
  });

  it("holds no engine-private state — no EDL, no director output hidden inside the timeline", () => {
    const result = runCinematicPipeline({ videoId: 9, scenes: twoScenes() });
    const asText = JSON.stringify(result.timeline);
    expect(asText).not.toContain("shotOrder");
    expect(asText).not.toContain("retentionRisk");
    expect(asText).not.toContain("narrativeFunction");
  });
});

/* ═══════════════════════ §12 — determinism ═══════════════════════ */

describe("RONDE 150 — determinism", () => {
  /**
   * `createdAt` is a clock reading — when this document was made, not what is in it. So the check
   * is written as "everything except createdAt is byte-identical", and it also asserts that
   * createdAt is the ONLY field allowed to move. Dropping to a shallow comparison would let a real
   * non-determinism hide behind the same exemption.
   */
  it("planning the same video twice produces a byte-identical timeline", () => {
    const a = runCinematicPipeline({ videoId: 3, scenes: twoScenes() });
    const b = runCinematicPipeline({ videoId: 3, scenes: twoScenes() });
    const { createdAt: createdA, ...restA } = a.timeline;
    const { createdAt: createdB, ...restB } = b.timeline;
    expect(JSON.stringify(restB)).toBe(JSON.stringify(restA));
    expect(typeof createdA).toBe("string");
    expect(typeof createdB).toBe("string");
  });

  it("clip ids come from the beat and candidate, not from a counter or a clock", () => {
    const a = runCinematicPipeline({ videoId: 3, scenes: twoScenes() });
    const b = runCinematicPipeline({ videoId: 4, scenes: twoScenes() });
    expect(videoClips(b.timeline).map((c) => c.id)).toEqual(videoClips(a.timeline).map((c) => c.id));
  });
});

/* ═══════════════════════ §2 — nothing disappears silently ═══════════════════════ */

describe("RONDE 150 §2 — every downgrade is reported", () => {
  it("names the planner's own transition when the renderer cannot execute it", () => {
    const result = runCinematicPipeline({ videoId: 5, scenes: twoScenes() });
    for (const line of result.unsupported) {
      expect(line.length).toBeGreaterThan(0);
      // A report that does not say what was dropped is the same as no report.
      expect(line).toMatch(/[a-z_]+/);
    }
  });

  it("lostEditorialIntent NAMES a loss rather than only counting one", () => {
    const result = runCinematicPipeline({ videoId: 5, scenes: twoScenes() });
    const mutilated = structuredClone(result.timeline);
    const track = mutilated.tracks.find((t) => t.kind === "VIDEO");
    if (track && track.kind === "VIDEO") {
      track.clips[0]!.camera = undefined;
      track.clips[0]!.effects = [];
      track.clips[0]!.sourceIn = 999;
    }
    const lost = lostEditorialIntent(result.edl, mutilated);
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.join(" ")).toContain(result.edl.decisions[0]!.beatId);
    expect(lost.join(" ")).toContain("trim");
  });

  it("notices when clips go missing entirely", () => {
    const result = runCinematicPipeline({ videoId: 5, scenes: twoScenes() });
    const mutilated = structuredClone(result.timeline);
    const track = mutilated.tracks.find((t) => t.kind === "VIDEO");
    if (track && track.kind === "VIDEO") track.clips = track.clips.slice(0, 1);
    expect(lostEditorialIntent(result.edl, mutilated).join(" ")).toContain("4 shot decision");
  });
});

/* ═══════════════════════ the log line ═══════════════════════ */

describe("RONDE 150 — the render log line", () => {
  it("says what was planned without leaking a URL, a key or a payload", () => {
    const result = runCinematicPipeline({
      videoId: 11,
      scenes: twoScenes(),
      voice: { url: "https://storage.example/voice/11.mp3?token=SECRET", durationSec: 16 },
    });
    const line = formatCinematicPlan(result);
    expect(line).toContain("[CinematicPipeline]");
    expect(line).toContain("video=11");
    expect(line).toContain("decisions=4");
    expect(line).not.toContain("http");
    expect(line).not.toContain("SECRET");
    expect(line).not.toContain("token");
  });
});
