/**
 * THE ADAPTER READS BACK ITS OWN WORK, BEFORE THE VALIDATOR CAN COST IT EVERYTHING.
 *
 * ── The refusal this exists to move earlier ──────────────────────────────────────────────────
 *
 *     [Validator] BLOCKING VIDEO/vc_70fbcd27ae [16.677s → 21.677s] video_overlap:
 *       overlaps vc_42d8ac831e by 3.323s
 *     [CinematicPipeline] video=574 plan NOT stored code=CINEMATIC_TIMELINE_INVALID
 *     [RenderJob] video=574 route=legacy_compose RENDER_FALLBACK_USED
 *     [Graphics] planned=14 rendered=11 renderer=remotion
 *
 * The validator was right — two clips cannot both be on screen — and it is deliberately absolute.
 * But it is the LAST thing to see the plan, so its refusal costs the whole timeline, and with it
 * eleven graphics the viewer never got.
 *
 * `checkCinematicSceneInputs` asks the same questions of the adapter's own output, before anything
 * is built from it. A fault is named with the beat, the check, the value it had and the value it
 * needed. It is never repaired: dropping the offending beat and carrying on would deliver a film
 * with a shot missing and a green report, which is the one outcome that leaves nobody to notice.
 *
 * ── What it can and cannot see ───────────────────────────────────────────────────────────────
 *
 * The adapter holds the render's own cut into the source (`sourceTrim`). The planner's trim is
 * composed onto it two modules later, in `edlToTimeline`, so the FULL source range cannot be
 * checked here and this file does not claim it is. Half a check, honestly bounded, is worth more
 * than a whole one that is not true.
 */
import { describe, expect, it } from "vitest";

import {
  buildCinematicSceneInputs,
  checkCinematicSceneInputs,
  formatAdapterIssues,
  type AdoptedClipFacts,
  type AdoptionFacts,
  type ProductionBeat,
  type SceneFacts,
} from "./cinematicPipelineInputs";
import type { Scene } from "./pipeline/types";

/* ═══════════════════════ fixtures, in the production pipeline's own shapes ═══════════════════════ */

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

function beat(index: number, startSec: number, durationSec: number): ProductionBeat {
  return {
    index,
    text: `Beat ${index} narration about the bunker.`,
    searchQuery: "berlin bunker",
    powerWord: "bunker",
    keywords: ["berlin", "bunker"],
    holdSec: durationSec,
    visualDescription: "",
    voiceStartSec: startSec,
    voiceEndSec: startSec + durationSec,
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
  return { localPath: "/tmp/clip.mp4", durationSec: 30, ...overrides };
}

/**
 * A scene built straight from windows, so a test can state the fault it is about in one line.
 * `sceneSec` defaults to exactly the span the beats occupy — a healthy scene.
 */
function sceneWith(
  index: number,
  windows: Array<[start: number, dur: number]>,
  opts: { sceneSec?: number; adoptions?: Array<Partial<AdoptionFacts>>; trims?: Array<{ inSec: number; outSec?: number } | undefined> } = {}
): SceneFacts {
  const beats = windows.map(([s, d], i) => beat(i, s, d));
  const span = windows.reduce((max, [s, d]) => Math.max(max, s + d), 0);
  return {
    scene: scene(index, opts.sceneSec ?? span),
    beats,
    clips: beats.map((_, i) => ({
      facts: facts({ localPath: `/tmp/s${index}b${i}.mp4` }),
      /** `sourceTrim` is read from the ADOPTION record — the render's own cut, not the file's. */
      adoption: adoption({
        providerAssetId: `${index}${i}`,
        ...(opts.trims?.[i] ? { sourceInSec: opts.trims[i]!.inSec, sourceOutSec: opts.trims[i]!.outSec } : {}),
        ...(opts.adoptions?.[i] ?? {}),
      }),
    })),
  };
}

const issuesFor = (scenes: SceneFacts[]) =>
  checkCinematicSceneInputs(buildCinematicSceneInputs({ scenes }).scenes);

/**
 * A real plan with one fault put into it by hand.
 *
 * The adapter's own clamp (R190) makes an out-of-scene beat impossible to produce THROUGH
 * `buildCinematicSceneInputs`, which is exactly what that fix was for — so a fixture that tries to
 * build one comes back clean and proves nothing about the check. The shapes still have to be real,
 * so the plan is built by the adapter and then edited: one field moved, everything else untouched.
 */
function planWith(
  windows: Array<[start: number, dur: number]>,
  sceneSec: number,
  edit: (plan: ReturnType<typeof buildCinematicSceneInputs>["scenes"]) => void
) {
  const built = buildCinematicSceneInputs({ scenes: [sceneWith(0, windows, { sceneSec })] });
  edit(built.scenes);
  return checkCinematicSceneInputs(built.scenes);
}

/** Move one beat's window, the way a defect upstream would. */
const moveBeat = (plan: ReturnType<typeof buildCinematicSceneInputs>["scenes"], i: number, start: number, dur: number) => {
  const beat = plan[0]!.beats[i]!;
  (beat.input as { beatVoiceStartSec: number }).beatVoiceStartSec = start;
  (beat.input as { beatVoiceDurationSec: number }).beatVoiceDurationSec = dur;
};

/* ═══════════════════════ §24 — one fault, one verdict ═══════════════════════ */

describe("a valid plan passes", () => {
  it("three beats that fill their scene exactly", () => {
    expect(issuesFor([sceneWith(0, [[0, 5], [5, 6], [11, 3]])])).toEqual([]);
  });

  it("and the adapter reports it as clean on the result itself", () => {
    const built = buildCinematicSceneInputs({ scenes: [sceneWith(0, [[0, 4], [4, 4]])] });
    expect(built.adapterIssues).toEqual([]);
  });

  it("two scenes back to back stay clean", () => {
    expect(issuesFor([sceneWith(0, [[0, 5], [5, 5]]), sceneWith(1, [[0, 4], [4, 4]])])).toEqual([]);
  });
});

describe("a beat that reaches past its own scene", () => {
  /** Render 574's exact fault: a last beat running to 20.000s in 16.677s of narration. */
  const overrun = () =>
    planWith([[0, 5], [5, 5], [10, 5], [15, 1.677]], 16.677, (plan) => moveBeat(plan, 3, 15, 5));

  it("is refused, not clamped away in silence", () => {
    expect(overrun().map((i) => i.check)).toContain("scene_boundary");
  });

  it("names the beat, the value it had and the value it needed", () => {
    const issue = overrun().find((i) => i.check === "scene_boundary");
    expect(issue?.beatIndex).toBe(3);
    expect(issue?.actual).toBe("20.000s");
    expect(issue?.expected).toBe("<= 16.677s");
  });

  it("says why it matters, in the words the validator would have used", () => {
    expect(overrun().find((i) => i.check === "scene_boundary")?.reason).toContain(
      "belongs to another scene"
    );
  });
});

describe("a beat that overlaps its neighbour", () => {
  const overlap = () => planWith([[0, 4], [4, 4]], 10, (plan) => moveBeat(plan, 0, 0, 6));

  it("is refused", () => {
    expect(overlap().map((i) => i.check)).toContain("beat_overlap");
  });

  it("names both beats", () => {
    const issue = overlap().find((i) => i.check === "beat_overlap");
    expect(issue?.actual).toContain("b0 runs to 6.000s");
    expect(issue?.reason).toContain("cannot both be on screen");
  });
});

describe("a shot with no length", () => {
  it("zero duration is refused", () => {
    const found = planWith([[0, 5], [5, 5]], 10, (plan) => moveBeat(plan, 1, 5, 0));
    expect(found.map((i) => i.check)).toContain("positive_duration");
  });

  it("a negative window is refused, and named as the number it is", () => {
    const found = planWith([[0, 5], [5, 5]], 10, (plan) => moveBeat(plan, 1, 5, -2));
    expect(found.find((i) => i.check === "positive_duration")?.expected).toBe("> 0s");
  });

  it("a window that is not a number is refused before anything is compared", () => {
    const found = planWith([[0, 5]], 5, (plan) => moveBeat(plan, 0, Number.NaN, 5));
    expect(found.find((i) => i.check === "positive_duration")?.expected).toBe("two finite numbers");
  });
});

describe("the source range the adapter can see", () => {
  it("a cut that starts before the file does is refused", () => {
    const found = issuesFor([
      sceneWith(0, [[0, 5]], { trims: [{ inSec: -2, outSec: 4 }] }),
    ]);
    expect(found.map((i) => i.check)).toContain("source_range");
  });

  it("a cut that ends at or before it starts is refused", () => {
    const found = issuesFor([
      sceneWith(0, [[0, 5]], { trims: [{ inSec: 8, outSec: 8 }] }),
    ]);
    const issue = found.find((i) => i.check === "source_range");
    expect(issue?.expected).toBe("out > in");
  });

  it("a clip with no recorded cut is not a fault", () => {
    /** Most routes never pre-trim. Absent is absent, and absent is not invalid. */
    expect(issuesFor([sceneWith(0, [[0, 5], [5, 5]])])).toEqual([]);
  });
});

describe("two elements that would hash to one id", () => {
  it("the collision is caught before the id is minted", () => {
    /**
     * `timelineElementId("vc", beatId, candidateId, startSec)` — identical parts, identical hash.
     * The adapter cannot see the id (it is built two modules later) but it holds every part of it.
     */
    const built = buildCinematicSceneInputs({ scenes: [sceneWith(0, [[0, 5], [5, 5]])] });
    const second = built.scenes[0]!.beats[1]!;
    const first = built.scenes[0]!.beats[0]!;
    (second.input as { intent: { beatId: string } }).intent.beatId = first.input.intent.beatId;
    (second.input as { bestCandidate: { candidateId: string } }).bestCandidate.candidateId =
      first.input.bestCandidate.candidateId;
    (second.input as { beatVoiceStartSec: number }).beatVoiceStartSec =
      first.input.beatVoiceStartSec;
    expect(checkCinematicSceneInputs(built.scenes).map((i) => i.check)).toContain("duplicate_identity");
  });

  it("the same asset on two DIFFERENT beats is fine", () => {
    /** One shot reused later in the film is ordinary documentary grammar, not a collision. */
    const s = sceneWith(0, [[0, 5], [5, 5]], {
      adoptions: [{ providerAssetId: "same" }, { providerAssetId: "same" }],
    });
    expect(checkCinematicSceneInputs(buildCinematicSceneInputs({ scenes: [s] }).scenes)).toEqual([]);
  });
});

/* ═══════════════════════ the refusal is legible ═══════════════════════ */

describe("the refusal says enough to act on", () => {
  const lines = () =>
    formatAdapterIssues(
      574,
      "rmtsu22cb-1",
      planWith([[0, 5], [5, 5], [10, 5], [15, 1.677]], 16.677, (plan) => moveBeat(plan, 3, 15, 5))
    );

  it("it is greppable and names the render", () => {
    expect(lines()[0]).toContain("CINEMATIC_ADAPTER_INVALID");
    expect(lines()[0]).toContain("render=rmtsu22cb-1");
  });

  it("one line per fault, never a count alone", () => {
    expect(lines().length).toBeGreaterThan(1);
    expect(lines()[1]).toContain("check=");
    expect(lines()[1]).toContain("actual=");
    expect(lines()[1]).toContain("expected=");
  });

  it("a clean plan produces no lines at all", () => {
    expect(formatAdapterIssues(574, "r", [])).toEqual([]);
  });

  it("an unknown render is said to be unknown, not left blank", () => {
    const out = formatAdapterIssues(
      574,
      undefined,
      planWith([[0, 4], [4, 4]], 10, (plan) => moveBeat(plan, 0, 0, 6))
    );
    expect(out[0]).toContain("render=unknown");
  });
});

/* ═══════════════════════ it never repairs ═══════════════════════ */

describe("the check reports and changes nothing", () => {
  it("the plan it was given is the plan it hands back", () => {
    /**
     * A function that could also repair would make "refused" and "silently altered" the same
     * event. §26: no silent repair, ever.
     */
    const built = buildCinematicSceneInputs({ scenes: [sceneWith(0, [[0, 4], [4, 4]], { sceneSec: 10 })] });
    moveBeat(built.scenes, 0, 0, 6);
    const before = JSON.stringify(built.scenes);
    checkCinematicSceneInputs(built.scenes);
    expect(JSON.stringify(built.scenes)).toBe(before);
  });

  it("calling it twice reports the same faults", () => {
    const built = buildCinematicSceneInputs({ scenes: [sceneWith(0, [[0, 4], [4, 4]], { sceneSec: 10 })] });
    moveBeat(built.scenes, 0, 0, 6);
    const first = checkCinematicSceneInputs(built.scenes);
    expect(checkCinematicSceneInputs(built.scenes)).toEqual(first);
  });
});
