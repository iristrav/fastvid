/**
 * RENDER 574 — TWO CLIPS ON ONE SECOND THREW AWAY THE WHOLE FILM.
 *
 * ── What the render did ──────────────────────────────────────────────────────────────────────
 *
 *     [VoiceAlign] 3 beats aligned to 14.1s VO (windows: 5.3s, 6.1s, 2.7s)
 *     [CinematicPipeline] inputs scenes=3 beats=13 planned=12 laidOut=13
 *     [CinematicSelected] scene=2 beat=0 start=0.00 duration=5.00
 *     [Validator] BLOCKING VIDEO/vc_70fbcd27ae [16.677s → 21.677s] video_overlap:
 *       overlaps vc_42d8ac831e by 3.323s
 *     [Validator] BLOCKING VIDEO/vc_97f5fc740a [50.437s → 55.437s] … by 0.905s
 *     [CinematicPipeline] video=574 plan NOT stored code=CINEMATIC_TIMELINE_INVALID
 *     [RenderJob] video=574 route=legacy_compose RENDER_FALLBACK_USED
 *     [Graphics] render=… planned=14 rendered=11 explicitRendered=10 renderer=remotion
 *
 * Eleven graphics were in that plan. The delivered film has none, because the compose route does
 * not know the plan — and the validator was right to refuse it: two clips cannot both be on screen
 * on a concatenated track.
 *
 * ── The two defects, which are one story ────────────────────────────────────────────────────
 *
 * FIRST, the measurement was taken and discarded. `applyBeatVoiceAlignments` had every beat's
 * spoken window in hand and read one number out of it — the LENGTH — which it then clamped to
 * [minClipSec, maxClipSec] and redistributed. `startSec`/`endSec`, the two numbers that say WHERE,
 * went nowhere, though `SceneBeat` has carried fields for them all along and the cinematic planner
 * reads exactly those. Hence `laidOut=13` of 13 in a render whose narration had been measured beat
 * by beat, and hence scene 2's 5.3/6.1/2.7 arriving as 5.00/5.22/5.00.
 *
 * SECOND, laid-out lengths were free to run past their own scene. `buildCinematicSceneInputs` puts
 * the next scene at `sceneOffsetSec + scene.duration` and then let this scene's beats cross that
 * very line. Four five-second budgets do not fit in 16.677s of narration, so scene 1's first shot
 * began 3.323s inside scene 0's last one — an impossible plan, produced by the function that knew
 * both numbers.
 *
 * Neither fix touches the validator. It stays exactly as strict; it is simply no longer handed a
 * plan that is impossible on its own terms.
 *
 * THIRD, and separately: render 574 was the first to make YouTube deliver
 * (`downloadOutcomes DOWNLOAD_SUCCESS=2` against eighteen timeouts), and both clips were adopted
 * and then dropped by a scene refill — `stage=REPLACED reason=scene_resourced`, no gate involved,
 * `assigned=2 rendered=0`. The ledger recorded it correctly and nothing an operator reads said so.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

import {
  applyBeatVoiceAlignments,
  type BeatVoiceAlignment,
} from "./voiceBeatAlignment";
import {
  buildCinematicSceneInputs,
  formatCinematicInputs,
  type AdoptedClipFacts,
  type AdoptionFacts,
  type ProductionBeat,
  type SceneFacts,
} from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import { validateTimeline } from "./timelineValidator";
import type { Scene } from "./pipeline/types";

/* ═══════════════════════ §1 — the measurement reaches the planner ═══════════════════════ */

describe("the window Whisper measured is written where the planner reads it", () => {
  /** Render 574's own scene 2: three beats, windows 5.3s / 6.1s / 2.7s of a 14.1s scene. */
  const render574Scene2 = (): BeatVoiceAlignment[] => [
    { beatIndex: 0, startSec: 0, endSec: 5.3, durationSec: 5.3 },
    { beatIndex: 1, startSec: 5.3, endSec: 11.4, durationSec: 6.1 },
    { beatIndex: 2, startSec: 11.4, endSec: 14.1, durationSec: 2.7 },
  ];

  const beats = () => [
    { text: "In the depths of his Berlin bunker.", holdSec: 5 },
    { text: "He clung to grand illusions.", holdSec: 5 },
    { text: "No escape, no glory.", holdSec: 5 },
  ];

  it("every beat comes back with the start it was measured at", () => {
    const b = beats();
    applyBeatVoiceAlignments(b, render574Scene2(), 14.1);
    expect(b.map((x) => (x as { voiceStartSec?: number }).voiceStartSec)).toEqual([0, 5.3, 11.4]);
  });

  it("and with its end, so the planner can place it rather than lay it out", () => {
    const b = beats();
    applyBeatVoiceAlignments(b, render574Scene2(), 14.1);
    expect(b.map((x) => (x as { voiceEndSec?: number }).voiceEndSec)).toEqual([5.3, 11.4, 14.1]);
  });

  it("the windows stay inside the scene's own narration", () => {
    /**
     * The whole point: three windows that add up to the audio, instead of three clamped budgets
     * that add up to 15.22s of a 14.1s scene.
     */
    const b = beats();
    applyBeatVoiceAlignments(b, render574Scene2(), 14.1);
    const ends = b.map((x) => (x as { voiceEndSec?: number }).voiceEndSec);
    for (const end of ends) expect(end, "a beat came back with no window at all").toBeTypeOf("number");
    expect(Math.max(...(ends as number[]))).toBeLessThanOrEqual(14.1);
  });

  it("a window belonging to another beat is never stamped on this one", () => {
    /**
     * `alignments.find(...) ?? alignments[i]` is a positional fallback. A borrowed LENGTH is a
     * rough number and keeps its old behaviour; a borrowed POSITION would be a false claim about
     * where the voice is, so only a window that names this beat is written.
     */
    const b = beats();
    applyBeatVoiceAlignments(
      b,
      [{ beatIndex: 0, startSec: 0, endSec: 5.3, durationSec: 5.3 }],
      14.1
    );
    const starts = b.map((x) => (x as { voiceStartSec?: number }).voiceStartSec);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeUndefined();
    expect(starts[2]).toBeUndefined();
  });

  it("the hold length still behaves exactly as it did", () => {
    /** Nothing about the montage's clip budget is loosened or re-scaled by this round. */
    const b = beats();
    applyBeatVoiceAlignments(b, render574Scene2(), 14.1);
    for (const beat of b) expect(beat.holdSec).toBeGreaterThan(0);
    expect(b.reduce((s, x) => s + x.holdSec, 0)).toBeGreaterThan(0);
  });
});

/* ═══════════════════════ §2 — a beat cannot outlive its scene ═══════════════════════ */

function scene(index: number, duration: number): Scene {
  return {
    index,
    text: "In April 1945 the Soviet Red Army encircled Berlin.",
    visualCue: "",
    pexelsQuery: "",
    aiImagePrompt: "",
    duration,
    ...({} as Record<string, never>),
  };
}

/** An UNMEASURED beat, the state render 574 was in for all thirteen of them. */
function laidOutBeat(index: number, holdSec: number): ProductionBeat {
  return {
    index,
    text: `Beat ${index} narration about the bunker.`,
    searchQuery: "berlin bunker",
    powerWord: "bunker",
    keywords: ["berlin", "bunker"],
    holdSec,
    visualDescription: "",
  };
}

function adoption(overrides: Partial<AdoptionFacts> = {}): AdoptionFacts {
  return {
    provider: "internet_archive",
    providerAssetId: "abc123",
    sourceUrl: "https://archive.org/x.mp4",
    assetTitle: "Berlin 1945",
    query: "berlin bunker",
    ...overrides,
  };
}

function facts(overrides: Partial<AdoptedClipFacts> = {}): AdoptedClipFacts {
  return { localPath: "/tmp/clip.mp4", ...overrides };
}

/** A scene whose beats, laid out along their holds, do not fit the narration it really has. */
function overrunningScene(index: number, holds: number[], audioSec: number): SceneFacts {
  const beats = holds.map((h, i) => laidOutBeat(i, h));
  return {
    scene: scene(index, audioSec),
    beats,
    clips: beats.map((_, i) => ({
      facts: facts({ localPath: `/tmp/s${index}b${i}.mp4`, durationSec: 30 }),
      adoption: adoption({ providerAssetId: `${index}${i}` }),
    })),
  };
}

describe("render 574's own numbers no longer produce an impossible plan", () => {
  /**
   * Scene 0: four beats at the 5s clip floor against 16.677s of voice — the render's exact case,
   * which produced `overlaps … by 3.323s`. Scene 1 follows with the second overlap's shape.
   */
  const render574 = () => [
    overrunningScene(0, [5, 5, 5, 5], 16.677),
    overrunningScene(1, [5, 7.33, 7.33, 5, 5], 33.76),
    overrunningScene(2, [5, 5.22, 5], 14.4),
  ];

  it("no beat ends after the scene it belongs to", () => {
    const built = buildCinematicSceneInputs({ scenes: render574() });
    for (const s of built.scenes) {
      for (const b of s.beats) {
        const end = b.input.beatVoiceStartSec + b.input.beatVoiceDurationSec;
        expect(
          end,
          `scene at ${s.sceneOffsetSec}s: a beat ends at ${end}s, past the scene`
        ).toBeLessThanOrEqual(s.director.durationSec + 0.001);
      }
    }
  });

  it("scene 0 stops at 16.677s, not at 20.000s", () => {
    const built = buildCinematicSceneInputs({ scenes: render574() });
    const ends = built.scenes[0]!.beats.map(
      (b) => b.input.beatVoiceStartSec + b.input.beatVoiceDurationSec
    );
    expect(Math.max(...ends)).toBeCloseTo(16.677, 3);
  });

  it("the whole chain validates — no video_overlap, so the plan is not thrown away", () => {
    /**
     * The test that would have caught this: production beats → adapter → Director → EDL →
     * timeline → the same validator that refused render 574.
     */
    const built = buildCinematicSceneInputs({ scenes: render574() });
    const result = runCinematicPipeline({ videoId: 574, scenes: built.scenes });
    const issues = validateTimeline(result.timeline).issues;
    const overlaps = issues.filter((i) => i.code === "video_overlap");
    expect(overlaps.map((o) => o.reason)).toEqual([]);
  });

  it("and the plan is renderable, which is what the fallback hung on", () => {
    const built = buildCinematicSceneInputs({ scenes: render574() });
    const result = runCinematicPipeline({ videoId: 574, scenes: built.scenes });
    const blocking = validateTimeline(result.timeline).issues.filter(
      (i) => i.code === "video_overlap" || i.code === "video_gap"
    );
    expect(blocking.map((b) => `${b.code}: ${b.reason}`)).toEqual([]);
  });

  it("the clamp is counted, never silent", () => {
    const built = buildCinematicSceneInputs({ scenes: render574() });
    expect(built.stats.clampedToScene).toBeGreaterThan(0);
    expect(formatCinematicInputs(built)).toContain(
      `clampedToScene=${built.stats.clampedToScene}`
    );
  });

  it("a scene whose beats fit is left completely alone", () => {
    /** The clamp must be invisible on a healthy render, or it is a second layout engine. */
    const fits = [overrunningScene(0, [5, 5], 10), overrunningScene(1, [4, 4], 8)];
    const built = buildCinematicSceneInputs({ scenes: fits });
    expect(built.stats.clampedToScene).toBe(0);
    expect(
      built.scenes[0]!.beats.map((b) => [
        b.input.beatVoiceStartSec,
        b.input.beatVoiceStartSec + b.input.beatVoiceDurationSec,
      ])
    ).toEqual([[0, 5], [5, 10]]);
  });

  it("a measured beat is placed where it was measured, not where a budget would put it", () => {
    /** §1 and §2 meeting: with windows in hand there is nothing to lay out and nothing to clamp. */
    const beats: ProductionBeat[] = [
      { ...laidOutBeat(0, 5), voiceStartSec: 0, voiceEndSec: 5.3 },
      { ...laidOutBeat(1, 5), voiceStartSec: 5.3, voiceEndSec: 11.4 },
      { ...laidOutBeat(2, 5), voiceStartSec: 11.4, voiceEndSec: 14.1 },
    ];
    const built = buildCinematicSceneInputs({
      scenes: [
        {
          scene: scene(0, 14.1),
          beats,
          clips: beats.map((_, i) => ({
            facts: facts({ localPath: `/tmp/m${i}.mp4`, durationSec: 30 }),
            adoption: adoption({ providerAssetId: `m${i}` }),
          })),
        },
      ],
    });
    expect(built.stats.laidOut).toBe(0);
    expect(built.stats.clampedToScene).toBe(0);
    expect(
      built.scenes[0]!.beats.map((b) =>
        Number((b.input.beatVoiceStartSec + b.input.beatVoiceDurationSec).toFixed(3))
      )
    ).toEqual([5.3, 11.4, 14.1]);
  });

  it("a scene with no recorded length is left as it was, rather than collapsed to zero", () => {
    /** Clamping to a length nobody recorded would delete every beat — far worse than the overlap. */
    const built = buildCinematicSceneInputs({ scenes: [overrunningScene(0, [5, 5], 0)] });
    expect(built.stats.clampedToScene).toBe(0);
    expect(built.scenes[0]?.beats.length ?? 0).toBeGreaterThan(0);
  });
});

/* ═══════════════════════ §3 — a fetched asset does not leave in silence ═══════════════════════ */

describe("a scene rebuild that drops a proven asset says so", () => {
  const PIPELINE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  /** The whole function, so a claim about it cannot be satisfied by some other code path. */
  const noteSceneClipsResourced = (): string => {
    const at = PIPELINE.indexOf("function noteSceneClipsResourced(");
    expect(at, "noteSceneClipsResourced is gone").toBeGreaterThan(-1);
    return PIPELINE.slice(at, PIPELINE.indexOf("\n}", at));
  };

  it("the loss is announced, not only filed in the ledger", () => {
    expect(noteSceneClipsResourced()).toContain("[SceneResourced]");
  });

  it("the line names the provider and the asset, so the cost is countable", () => {
    const body = noteSceneClipsResourced();
    expect(body).toContain("record.provider");
    expect(body).toContain("record.providerAssetId");
  });

  it("only an asset whose source was proven — a local derivative is housekeeping, not news", () => {
    expect(noteSceneClipsResourced()).toContain('record.providerStatus === "VERIFIED"');
  });

  it("the ledger event RONDE 95 wrote is still filed, for every dropped clip", () => {
    /** The announcement is in addition to the record, never instead of it. */
    expect(noteSceneClipsResourced()).toContain('recordAssetOutcome(lineage, clip, "scene_resourced"');
  });

  it("a clip somebody already refused keeps that ending", () => {
    /** `hasOutcomeFor` is what stops a vague reason overwriting a specific one. */
    expect(noteSceneClipsResourced()).toContain("hasOutcomeFor(clip, contentKey)");
  });
});
