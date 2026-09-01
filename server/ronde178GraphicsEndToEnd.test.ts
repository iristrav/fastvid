/**
 * RONDE 178 — graphics all the way through the real route, on real beat text.
 *
 * ── Why this test could not have been written before R177 ────────────────────────────────────
 *
 * Every graphics test in this repository so far hands the translator or the renderer a graphic
 * somebody wrote down. That proves translation and drawing, and it proves nothing about whether a
 * render ever produces a graphic — which is the question that matters, and the one that had the
 * embarrassing answer: `intentFrom` fed the motion-graphics planner empty `objects`, `events`,
 * `brands` and `historicalContext`, so on the live route it returned nothing on almost every beat.
 *
 * So this test starts where production starts — beat text and an adoption record — runs the real
 * adapter with the real extractors, the real Director/EDL route and the real translation, and
 * asserts on the finished ProjectTimeline. Nothing is injected except the extractors production
 * itself injects.
 *
 * PRODUCTION STATUS: LOCAL. What is proven is that the planned graphics reach the timeline with
 * their payload, their absolute times and a renderable type. Whether ffmpeg composited them is
 * R160 §7's ground, and it needs a render.
 */
import { describe, expect, it } from "vitest";

import {
  buildCinematicSceneInputs,
  type AdoptionFacts,
  type ProductionBeat,
  type SceneFacts,
} from "./cinematicPipelineInputs";
import {
  formatCinematicGraphics,
  lostEditorialIntent,
  runCinematicPipeline,
} from "./cinematicPipeline";
import { graphicIsRenderable } from "./graphicsVocabulary";
import {
  beatNamedEntitiesByKind,
  extractActionCue,
  extractPersonNamesFromText,
  extractVisualPlacePhrase,
} from "./videoPipeline";
import type { Scene } from "./pipeline/types";
import type { ProjectTimeline } from "./projectTimeline";

/* ═══════════════════════ the production fixtures ═══════════════════════ */

/** Exactly what videoPipeline injects at the planAndStoreCinematicTimeline call site. */
const PRODUCTION_EXTRACTORS = {
  people: (t: string) => extractPersonNamesFromText(t),
  place: (t: string) => extractVisualPlacePhrase(t),
  action: (t: string) => extractActionCue(t),
  namedEntities: (t: string) => beatNamedEntitiesByKind(t),
};

/**
 * Documentary narration of the kind this product actually generates — a dated historical beat, an
 * object beat, and a named-company beat. Chosen because each one reaches a DIFFERENT graphic rule,
 * so a single rule firing cannot make the whole test pass.
 */
const BEAT_TEXTS = [
  "In April 1945 the Battle of Berlin reached the city centre.",
  "He held the pistol in his right hand and said nothing.",
  "Tesla opened a new plant outside Berlin that same decade.",
];

function beat(index: number, text: string): ProductionBeat {
  return {
    index,
    text,
    searchQuery: "berlin 1945",
    powerWord: "Berlin",
    keywords: ["berlin"],
    holdSec: 4,
    visualDescription: "",
    voiceStartSec: index * 4,
    voiceEndSec: index * 4 + 4,
  };
}

function scene(index: number, texts: string[]): Scene {
  return {
    index,
    text: texts.join(" "),
    visualCue: "",
    pexelsQuery: "",
    aiImagePrompt: "",
    duration: texts.length * 4,
  };
}

function adoption(i: number): AdoptionFacts {
  return {
    provider: "internet_archive",
    providerAssetId: `ia-${i}`,
    sourceUrl: `https://archive.invalid/${i}.mp4`,
    assetTitle: "Berlin 1945",
    query: "berlin 1945",
  };
}

function sceneFacts(index: number, texts: string[]): SceneFacts {
  const beats = texts.map((t, i) => beat(i, t));
  return {
    scene: scene(index, texts),
    beats,
    clips: beats.map((_, i) => ({
      facts: { localPath: `/tmp/s${index}b${i}.mp4`, durationSec: 10, widthPx: 1920, heightPx: 1080 },
      adoption: adoption(i),
    })),
  };
}

/** The whole route, from production facts to a finished timeline. */
function runRoute(scenes: SceneFacts[]) {
  const built = buildCinematicSceneInputs({ scenes, extractors: PRODUCTION_EXTRACTORS });
  expect(built.dropped, `beats were dropped: ${built.dropped.join("; ")}`).toEqual([]);
  const result = runCinematicPipeline({ videoId: 1, scenes: built.scenes });
  return result;
}

function graphicsOf(timeline: ProjectTimeline) {
  const track = timeline.tracks.find((t) => t.kind === "GRAPHICS");
  return track && track.kind === "GRAPHICS" ? track.graphics : [];
}

/* ═══════════════════════ the route produces graphics at all ═══════════════════════ */

describe("R178 — a real render's beats reach the timeline as graphics", () => {
  /**
   * The test that fails for the R177 reason and no other. If `intentFrom` goes back to hard-coding
   * the planner's inputs empty, the EDL carries zero motion graphics and this is the assertion that
   * says so — every translation and rendering test stays green.
   */
  it("the EDL carries motion graphics, rather than none", () => {
    const { edl } = runRoute([sceneFacts(0, BEAT_TEXTS)]);
    const planned = edl.decisions.reduce((n, d) => n + d.motionGraphics.length, 0);
    expect(planned, "the live route planned no graphics at all").toBeGreaterThan(0);
  });

  it("more than one KIND of graphic, so one rule cannot carry the whole route", () => {
    const { edl } = runRoute([sceneFacts(0, BEAT_TEXTS)]);
    const kinds = new Set(edl.decisions.flatMap((d) => d.motionGraphics.map((g) => g.graphicType)));
    expect(kinds.size).toBeGreaterThanOrEqual(2);
  });

  it("every planned graphic is on the timeline, none lost in translation", () => {
    const { edl, timeline } = runRoute([sceneFacts(0, BEAT_TEXTS)]);
    const planned = edl.decisions.reduce((n, d) => n + d.motionGraphics.length, 0);
    expect(graphicsOf(timeline)).toHaveLength(planned);
    /** The route's own audit agrees — it is what production logs. */
    expect(lostEditorialIntent(edl, timeline)).toEqual([]);
  });
});

/* ═══════════════════════ what reaches the renderer is drawable ═══════════════════════ */

describe("R178 — the graphics on the timeline are ones the renderer can draw", () => {
  /**
   * ── What this test asked for first, and why that was the wrong requirement ─────────────────
   *
   * The first version demanded that EVERY graphic the route plans be drawable. Run against the real
   * route it failed with three: `timeline`, `highlight_box` and `animated_icon`.
   *
   * One of those was a genuine bug and is fixed — `timeline` reached no component at all, and its
   * words were sitting unread inside its own `events` payload. See RENDERER_GRAPHIC_TYPE.
   *
   * The other two are not bugs, and forcing them green would have required either inventing a
   * payload or pointing a highlight box at a text card. There is no component that draws a box
   * around a region or an animated brand icon, and substituting one graphic for another is exactly
   * what §6 forbids. So the requirement is the INVARIANT rather than the count: at least one real
   * graphic draws, and anything that cannot is reported rather than silently kept.
   *
   * `graphicIsRenderable` is the component's own predicate, shared through graphicsVocabulary, so
   * this asks the renderer's question of the real route's real output rather than of a fixture.
   */
  it("at least one of the route's graphics is one the renderer can draw", () => {
    const { timeline } = runRoute([sceneFacts(0, BEAT_TEXTS)]);
    const graphics = graphicsOf(timeline);
    expect(graphics.length).toBeGreaterThan(0);
    const drawable = graphics.filter((g) => graphicIsRenderable(g.graphicType, g.data, g.label ?? null));
    expect(
      drawable.length,
      `nothing the live route plans can be drawn: ${graphics.map((g) => g.graphicType).join(", ")}`
    ).toBeGreaterThan(0);
  });

  /**
   * The specific bug R178 found and fixed, pinned by name so it cannot come back: a dated
   * historical beat plans a `timeline`, and that graphic must reach the renderer WITH its words.
   */
  it("the dated historical beat's timeline graphic is drawable, with its own words", () => {
    const { timeline } = runRoute([sceneFacts(0, BEAT_TEXTS)]);
    const g = graphicsOf(timeline).find((x) => x.reason.includes('planned as "timeline"'));
    expect(g, "the timeline graphic no longer reaches the renderer").toBeTruthy();
    expect(graphicIsRenderable(g!.graphicType, g!.data, g!.label ?? null)).toBe(true);
    /** The year and the event, read out of the planner's payload — not invented here. */
    expect(g!.label).toContain("1945");
    expect(g!.label).toContain("Battle of Berlin");
  });

  /**
   * And when one is NOT drawable it must be reported, never dropped. Asserted as an invariant over
   * the route's own output: the count of undrawable graphics equals the count of graphics reported
   * unsupported, whichever way this render happens to come out.
   */
  it("anything undrawable is reported rather than silently kept", () => {
    const { timeline, unsupported } = runRoute([sceneFacts(0, BEAT_TEXTS)]);
    const undrawable = graphicsOf(timeline).filter(
      (g) => !graphicIsRenderable(g.graphicType, g.data, g.label ?? null)
    );
    const reported = unsupported.filter((u) => u.startsWith("motion graphic "));
    expect(reported).toHaveLength(undrawable.length);
  });

  it("carries the planner's payload, not just a type", () => {
    const { timeline } = runRoute([sceneFacts(0, BEAT_TEXTS)]);
    for (const g of graphicsOf(timeline)) {
      expect(g.data, `${g.graphicType} arrived with no payload`).toBeTruthy();
      expect(Object.keys(g.data as object).length).toBeGreaterThan(0);
    }
  });

  /** The decision has to be able to explain itself — §2's reason, on every graphic. */
  it("every graphic states why it is there", () => {
    for (const g of graphicsOf(runRoute([sceneFacts(0, BEAT_TEXTS)]).timeline)) {
      expect(g.reason.trim().length, `${g.graphicType} has no reason`).toBeGreaterThan(0);
    }
  });
});

/* ═══════════════════════ the times are the video's, not the beat's ═══════════════════════ */

describe("R178 — graphic times are absolute and inside the video", () => {
  /**
   * The one mistake this shape invites. `MotionGraphicInstruction.startSec` is BEAT-relative and
   * `TimelineGraphic.start` is absolute; translating scene 1 without its offset puts every graphic
   * in scene 1 on top of scene 0. Two scenes, so the bug has somewhere to show.
   */
  it("a second scene's graphics start after the first scene ends", () => {
    const { timeline } = runRoute([sceneFacts(0, BEAT_TEXTS), sceneFacts(1, BEAT_TEXTS)]);
    const sceneOneLength = BEAT_TEXTS.length * 4;
    const graphics = graphicsOf(timeline);
    expect(graphics.some((g) => g.start >= sceneOneLength)).toBe(true);
    /** And none of scene 0's graphics wandered into scene 1's time. */
    expect(graphics.filter((g) => g.start < sceneOneLength).length).toBeGreaterThan(0);
  });

  it("no graphic starts after it ends, or runs past the video", () => {
    const { timeline } = runRoute([sceneFacts(0, BEAT_TEXTS), sceneFacts(1, BEAT_TEXTS)]);
    for (const g of graphicsOf(timeline)) {
      expect(g.end, `${g.graphicType} ends before it starts`).toBeGreaterThan(g.start);
      expect(g.start).toBeGreaterThanOrEqual(0);
      expect(g.end).toBeLessThanOrEqual(timeline.durationSec + 0.001);
    }
  });

  it("gives each graphic a distinct id, so the editor can address one", () => {
    const ids = graphicsOf(runRoute([sceneFacts(0, BEAT_TEXTS), sceneFacts(1, BEAT_TEXTS)]).timeline).map(
      (g) => g.id
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ═══════════════════════ captions, on the same route ═══════════════════════ */

describe("R178 — the captions the same beats plan also reach the timeline", () => {
  it("the dated beat produces a dated caption on the timeline", () => {
    const { timeline } = runRoute([sceneFacts(0, BEAT_TEXTS)]);
    const captionTrack = timeline.tracks.find((t) => t.kind === "CAPTIONS");
    const textTrack = timeline.tracks.find((t) => t.kind === "TEXT");
    const texts = [
      ...(captionTrack && captionTrack.kind === "CAPTIONS" ? captionTrack.captions.map((c) => c.text) : []),
      ...(textTrack && textTrack.kind === "TEXT" ? textTrack.texts.map((t) => t.text) : []),
    ];
    expect(texts.join(" "), "the 1945 date card never reached the timeline").toContain("1945");
  });

  /**
   * ── The collision this test found, and why the assertion is "reported" not "absent" ────────
   *
   * On the dated beat the planner puts a timeline label at `bottom` and a location tag at
   * `bottom-left`. Two different positions to the planner; `positionFor` collapses both to `bottom`
   * because the renderer centres text, and the two are then drawn on top of each other.
   *
   * Making the collision impossible means moving one of them, and R178 deliberately does not: the
   * geometric resolver (`captionLayout`) excludes free text ON PURPOSE, because a text element is
   * the obstacle captions are moved to avoid. Which vertical band a location tag belongs in is a
   * question that needs a rendered frame, and this environment cannot produce one.
   *
   * So the requirement is that the collision is NAMED. A silently overlapping pair is the failure;
   * a reported one is a known defect somebody can act on.
   */
  it("a text overlay collision is reported rather than drawn silently", () => {
    const { timeline, unsupported } = runRoute([sceneFacts(0, BEAT_TEXTS)]);
    const track = timeline.tracks.find((t) => t.kind === "TEXT");
    const texts = track && track.kind === "TEXT" ? track.texts : [];
    const collisions: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i]!;
        const b = texts[j]!;
        /** The position lives in the STYLE — reading it off the element compares undefined to undefined. */
        if (a.style?.position !== b.style?.position) continue;
        if (a.start < b.end && b.start < a.end) {
          collisions.push(`"${a.text}" and "${b.text}" both at ${a.style?.position}`);
        }
      }
    }
    const reported = unsupported.filter((u) => u.startsWith("two text overlays share position"));
    expect(
      reported.length,
      `${collisions.length} collision(s) went unreported:\n${collisions.join("\n")}`
    ).toBe(collisions.length);
  });

  /** And this fixture really does collide, so the assertion above is not vacuous. */
  it("this fixture is one that collides, so the report is exercised", () => {
    const { unsupported } = runRoute([sceneFacts(0, BEAT_TEXTS)]);
    expect(unsupported.some((u) => u.startsWith("two text overlays share position"))).toBe(true);
  });
});

/* ═══════════════════════ the render log says what happened ═══════════════════════ */

describe("R178 — the graphics line reports planned, drawn and skipped", () => {
  /**
   * `formatGraphics` was built in R172 and had no caller, so a render's `unsupported=3` covered
   * effects, transitions, caption positions and graphics in one number that named none of them.
   */
  it("names the counts and every skipped graphic's reason", () => {
    const result = runRoute([sceneFacts(0, BEAT_TEXTS)]);
    const line = formatCinematicGraphics(result);
    expect(line).toContain("[Graphics]");
    expect(line).toContain(`render=${result.renderId}`);
    expect(line).toMatch(/planned=[1-9]/);
    expect(line).toContain("renderer=remotion");
    /** Each skip keeps its own reason — a count alone cannot be acted on. */
    const skipped = result.unsupported.filter((u) => u.startsWith("motion graphic "));
    expect(line.split("\n")).toHaveLength(skipped.length + 1);
  });

  it("counts drawn graphics by the renderer's own predicate, not by the planner's intention", () => {
    const result = runRoute([sceneFacts(0, BEAT_TEXTS)]);
    const drawable = graphicsOf(result.timeline).filter((g) =>
      graphicIsRenderable(g.graphicType, g.data, g.label ?? null)
    ).length;
    expect(formatCinematicGraphics(result)).toContain(`rendered=${drawable}`);
  });
});
