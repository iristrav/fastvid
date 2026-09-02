/**
 * EVERY BEAT CLAIMED TO START AT SECOND ZERO.
 *
 * ── The render this is taken from ───────────────────────────────────────────────────────────
 *
 * 563 was the first render after the beats finally reached the cinematic planner. They arrived —
 * `inputs scenes=2 beats=12 planned=3` — Remotion ran for the first time, `[Graphics] planned=2
 * rendered=2 skipped=0`, and then the whole plan was thrown away on one line:
 *
 *     [Validator] BLOCKING VIDEO/vc_ceab35ceb7 [0.000s → 3.500s] video_overlap:
 *       overlaps vc_2c67ea567f by 3.500s — two clips cannot both be on screen
 *     [CinematicPipeline] video=563 plan NOT stored code=CINEMATIC_TIMELINE_INVALID
 *       reason=1 blocking issue(s): video_overlap
 *     [RenderJob] video=563 route=legacy_compose RENDER_FALLBACK_USED
 *
 * Two clips at 0.000→3.500, identical to the millisecond. Not a rounding fault — the same window
 * twice. The delivered video came from the legacy route, which knows nothing about the graphics
 * that had just been rendered, so they are not in it.
 *
 * ── Reading the third clip ──────────────────────────────────────────────────────────────────
 *
 * The scene-2 clip sat at 55.453s, and 55.453s is exactly scene 2's offset. So every clip landed
 * on its scene's offset and nowhere else: `clip.startSec` was zero for all of them.
 *
 * It came from one `??` in the adapter:
 *
 *     const start = beat.voiceStartSec ?? 0;
 *
 * `voiceStartSec` is absent whenever the render did not align narration to audio — no scene audio
 * on disk, or beats built by `buildSceneBeats` rather than the TTS planner. Render 563 aligned
 * nothing, so every beat in a scene took position 0, and `edlToTimeline` added the same
 * `sceneOffsetSec` to each. Two beats in one scene is all it takes.
 *
 * The module's own contract says what absent means: "SCENE-LOCAL seconds… an unmeasured value is
 * absent rather than zero". The `?? 0` read absent as a measurement of zero.
 *
 * ── What replaces it ────────────────────────────────────────────────────────────────────────
 *
 * The beats are laid out end to end along their own `holdSec` — the pipeline's number, the one the
 * montage already cuts on. The cursor advances over dropped beats too, because narration does not
 * skip the beats that found no footage.
 */
import { describe, expect, it } from "vitest";

import {
  buildCinematicSceneInputs,
  formatCinematicInputs,
  type AdoptionFacts,
  type ProductionBeat,
  type SceneFacts,
} from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import { validateTimeline } from "./timelineValidator";
import type { Scene } from "./pipeline/types";

/* ═══════════════════════ render 563's shape, with nothing measured ═══════════════════════ */

const HOLD = 3.5;

/** A beat as `buildSceneBeats` produces it: a hold length, and no voice window at all. */
function unmeasuredBeat(index: number): ProductionBeat {
  return {
    index,
    text: `Martin Bormann sent the note from Berlin, beat ${index}.`,
    searchQuery: "martin bormann berlin",
    powerWord: "Martin Bormann",
    keywords: ["berlin"],
    holdSec: HOLD,
  };
}

/** The same beat once the render aligned it to the narration audio. */
function measuredBeat(index: number): ProductionBeat {
  return { ...unmeasuredBeat(index), voiceStartSec: index * HOLD, voiceEndSec: (index + 1) * HOLD };
}

function scene(index: number, beatCount: number): Scene {
  return {
    index,
    text: "Martin Bormann sent the note from Berlin.",
    visualCue: "",
    pexelsQuery: "",
    aiImagePrompt: "",
    duration: beatCount * HOLD,
  } as Scene;
}

function adoption(sceneIndex: number, beatIndex: number): AdoptionFacts {
  return {
    provider: "internet_archive",
    providerAssetId: `ia-s${sceneIndex}b${beatIndex}`,
    sourceUrl: `https://archive.invalid/s${sceneIndex}b${beatIndex}.mp4`,
    assetTitle: "Berlin 1941",
    query: "martin bormann berlin",
  };
}

/**
 * @param adopted which beat indices found a clip. The rest are dropped, exactly as render 563
 *                dropped s0b1 for having no rehydratable identity.
 */
function sceneFacts(
  sceneIndex: number,
  beatCount: number,
  opts: { measured?: boolean; adopted?: readonly number[] } = {}
): SceneFacts {
  const make = opts.measured ? measuredBeat : unmeasuredBeat;
  const beats = Array.from({ length: beatCount }, (_, i) => make(i));
  const adopted = opts.adopted ?? beats.map((_, i) => i);
  return {
    scene: scene(sceneIndex, beatCount),
    beats,
    clips: beats.map((_, i) =>
      adopted.includes(i)
        ? {
            facts: {
              localPath: `/tmp/s${sceneIndex}b${i}.mp4`,
              durationSec: 10,
              widthPx: 1920,
              heightPx: 1080,
            },
            adoption: adoption(sceneIndex, i),
          }
        : null
    ),
  };
}

function videoClips(scenes: SceneFacts[]) {
  const built = buildCinematicSceneInputs({ scenes });
  const { timeline } = runCinematicPipeline({ videoId: 563, scenes: built.scenes });
  const track = timeline.tracks.find((t) => t.kind === "VIDEO");
  return {
    built,
    timeline,
    clips: track && track.kind === "VIDEO" ? track.clips : [],
  };
}

/* ═══════════════════════ the failure, end to end ═══════════════════════ */

describe("render 563's plan survives its own validator", () => {
  /**
   * THE TEST THAT REPRODUCES THE BLOCKING ISSUE. Two unaligned beats in one scene were enough to
   * discard an entire cinematic plan and fall back to the legacy compose route.
   */
  it("two unmeasured beats in one scene do not land on the same window", () => {
    const { clips } = videoClips([sceneFacts(0, 2)]);
    expect(clips).toHaveLength(2);
    expect(
      clips[0]!.timelineStart === clips[1]!.timelineStart,
      `both clips start at ${clips[0]!.timelineStart}s — this is the video_overlap`
    ).toBe(false);
  });

  /** And the validator, which is the thing that actually refused the plan, agrees. */
  it("the validator reports no video_overlap", () => {
    const { timeline } = videoClips([sceneFacts(0, 3), sceneFacts(1, 2)]);
    const overlaps = validateTimeline(timeline).issues.filter((i) => i.code === "video_overlap");
    expect(
      overlaps.map((i) => i.reason),
      "the plan is still thrown away and the graphics still never reach the video"
    ).toEqual([]);
  });

  /** Clips follow the narration in order, each starting where the last one ended. */
  it("lays the beats out end to end along their holds", () => {
    const { clips } = videoClips([sceneFacts(0, 3)]);
    expect(clips.map((c) => c.timelineStart)).toEqual([0, HOLD, HOLD * 2]);
  });

  /**
   * A dropped beat leaves a hole in the picture, not a shift in the timing. The voice keeps
   * talking through it, so the beat after it begins where the narration has actually reached —
   * this is why the cursor advances before the adoption checks rather than after them.
   */
  it("a dropped beat still occupies its share of the narration", () => {
    const { built, clips } = videoClips([sceneFacts(0, 3, { adopted: [0, 2] })]);
    expect(built.dropped).toEqual(["s0b1: no clip was adopted for this beat"]);
    expect(clips).toHaveLength(2);
    expect(
      clips.map((c) => c.timelineStart),
      "the third beat slid into the dropped beat's slot, ahead of its own narration"
    ).toEqual([0, HOLD * 2]);
  });

  /** Scenes still stack: a second scene's beats sit after the first scene's duration. */
  it("keeps scenes apart while spreading beats within them", () => {
    const { clips } = videoClips([sceneFacts(0, 2), sceneFacts(1, 2)]);
    expect(clips.map((c) => c.timelineStart)).toEqual([0, HOLD, HOLD * 2, HOLD * 3]);
  });
});

/* ═══════════════════════ a measured render is untouched ═══════════════════════ */

describe("a measured voice window still wins", () => {
  /**
   * The layout is a fallback for an unmeasured beat and nothing more. A render that aligned its
   * narration must cut to the narration, not to the script's estimate of it.
   */
  it("uses the measured position verbatim, not the hold", () => {
    const beats = [measuredBeat(0), { ...measuredBeat(1), voiceStartSec: 5, voiceEndSec: 9 }];
    const facts: SceneFacts = {
      ...sceneFacts(0, 2, { measured: true }),
      beats,
    };
    const { clips } = videoClips([facts]);
    expect(clips.map((c) => c.timelineStart)).toEqual([0, 5]);
  });

  /** Nothing is laid out when everything was measured. */
  it("counts no laid-out beats on an aligned render", () => {
    const built = buildCinematicSceneInputs({ scenes: [sceneFacts(0, 3, { measured: true })] });
    expect(built.stats.laidOut).toBe(0);
  });
});

/* ═══════════════════════ the log says which kind of edit this is ═══════════════════════ */

describe("an unaligned render says so", () => {
  /**
   * Render 563 gave no hint that its edit was cut to estimates: the first sign was a validator
   * refusal fifteen minutes later. An edit cut to the script rather than to the voice is a
   * legitimate but different thing, and the line that reports the inputs is where it belongs.
   */
  it("counts every beat it had to lay out", () => {
    const built = buildCinematicSceneInputs({ scenes: [sceneFacts(0, 3), sceneFacts(1, 2)] });
    expect(built.stats.laidOut).toBe(5);
  });

  /** Including beats that were then dropped — they were still positioned. */
  it("counts a dropped beat too", () => {
    const built = buildCinematicSceneInputs({ scenes: [sceneFacts(0, 3, { adopted: [0, 2] })] });
    expect(built.stats.laidOut).toBe(3);
    expect(built.stats.planned).toBe(2);
  });

  it("prints it on the render's own input line", () => {
    const built = buildCinematicSceneInputs({ scenes: [sceneFacts(0, 2)] });
    expect(formatCinematicInputs(built)).toContain("laidOut=2");
  });
});
