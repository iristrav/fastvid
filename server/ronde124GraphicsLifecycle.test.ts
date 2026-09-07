/**
 * RONDE 124 — A PLANNED GRAPHIC MAY NOT SIMPLY STOP BEING MENTIONED.
 *
 * ── What render 572 could not be asked ──────────────────────────────────────────────────────
 *
 *     [Graphics] planned=5 rendered=5 explicitRendered=4 genericRendered=1 skipped=0
 *
 * and, separately, in the same render's EDL report:
 *
 *     unsupported motion graphic "highlight_box"
 *     unsupported visual effect "dust"
 *
 * Both statements cannot describe the same five graphics. The reason nobody could tell which was
 * wrong is that the three counts come from three modules with no join: `planned` from the EDL,
 * `rendered` from a predicate over the timeline track, and `skipped` from matching the prefix
 * `"motion graphic "` on free text — so the number depended on the wording of a sentence.
 *
 * ── What this file holds ────────────────────────────────────────────────────────────────────
 *
 * That every planned graphic gets exactly one outcome, that the outcomes add up to the plan, and
 * that the two ways a graphic can fail — no component for the TYPE, versus a bad PAYLOAD on a type
 * that draws — stay different findings. The join runs through the real `translateEdl`, so a change
 * to how ids are built breaks here rather than silently unpairing the two halves.
 *
 * ── The word this module may not use ────────────────────────────────────────────────────────
 *
 * "Delivered". `DRAWN` is the renderer's own count, not a frame inspection, and the last test in
 * this file fails if the vocabulary ever starts claiming otherwise.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  GRAPHIC_DROPS,
  GRAPHIC_STAGES,
  effectsLifecycle,
  formatGraphicsLifecycle,
  graphicsLifecycle,
  isTerminalGraphicOutcome,
  type PlannedGraphic,
} from "./graphicsLifecycle";
import { RENDERABLE_EFFECTS, translateEdl } from "./edlToTimeline";
import { graphicIsRenderable } from "./graphicsVocabulary";
import type { EditDecision, MotionGraphicType } from "./cinematicEditingEngine/types";
import type { MotionGraphicInstruction } from "./cinematicEditingEngine/types";

const SERVER = __dirname;
const identity = { provider: "loc", providerAssetId: "item/1", mediaUrl: "https://x/a.mp4" };

function graphic(
  graphicType: MotionGraphicType,
  data: Record<string, unknown>,
  startSec = 0
): MotionGraphicInstruction {
  return { graphicType, data, startSec, durationSec: 2, reason: "planner reason" };
}

function decision(beatId: string, graphics: MotionGraphicInstruction[], effects: string[] = []): EditDecision {
  return {
    beatId,
    sceneIndex: 0,
    clip: {
      candidateId: `loc:${beatId}`,
      assetType: "video",
      localPath: null,
      remoteUrl: "https://x/a.mp4",
      trimStartSec: 0,
      trimEndSec: 6,
      startSec: 0,
      endSec: 6,
      timingSource: "tts_word_alignment",
    },
    shot: { shotType: "wide", reason: "r" } as EditDecision["shot"],
    camera: { movement: "none", intensity: 0, reason: "r" },
    transitionIn: { type: "cut", durationSec: 0, reason: "r" },
    captions: [],
    motionGraphics: graphics,
    effects: effects.map((effectType) => ({ effectType, intensity: 0.2, reason: "r" })) as never,
    sounds: [],
    pacing: { tone: "measured", cutSpeedMultiplier: 1, movementIntensity: 0.3, reason: "r" },
  };
}

/** Plan → the real adapter → the lifecycle join, exactly as `cinematicPipeline` runs it. */
function lifecycleFor(decisions: EditDecision[], renderer?: { inputIds: string[]; drawnIds: string[] }) {
  const { timeline } = translateEdl({
    videoId: 1,
    inputs: decisions.map((d) => ({ decision: d, sceneOffsetSec: 0, identity })),
  });
  const track = timeline.tracks.find((t) => t.kind === "GRAPHICS");
  const planned: PlannedGraphic[] = decisions.flatMap((d) =>
    d.motionGraphics.map((g) => ({
      beatId: d.beatId,
      graphicType: g.graphicType,
      data: g.data,
      startSec: g.startSec,
      reason: g.reason,
    }))
  );
  return {
    lifecycle: graphicsLifecycle({
      planned,
      onTrack: track && track.kind === "GRAPHICS" ? track.graphics : [],
      renderer,
    }),
    timeline,
  };
}

/* ═══════════════ A. the census: every planner type has an explicit status ═══════════════ */

describe("A — every graphic type the planner can emit has an explicit renderer status", () => {
  /** The planner's own union, parsed rather than restated: a second copy is what drifts. */
  const plannerTypes = (): string[] => {
    const src = fs.readFileSync(path.join(SERVER, "cinematicEditingEngine", "types.ts"), "utf8");
    const at = src.indexOf("export type MotionGraphicType =");
    expect(at, "the planner's graphic union moved or was renamed").toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf(";", src.indexOf('| "quote"', at)));
    return [...block.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  };

  it("the census reads the planner's whole union — a parse that finds nothing proves nothing", () => {
    /** Without this, every loop below is vacuous and the census passes by measuring zero types. */
    const types = plannerTypes();
    expect(types).toEqual([
      "progress_bar", "statistic_counter", "map", "timeline", "chart", "comparison",
      "animated_icon", "highlight_box", "arrow", "lower_third", "date_card",
      "location_card", "quote",
    ]);
  });

  it("each one resolves to DRAWN-capable or to a named drop — never to silence", () => {
    expect(plannerTypes().length).toBeGreaterThan(0);
    for (const type of plannerTypes()) {
      const { lifecycle } = lifecycleFor([
        decision(`b_${type}`, [graphic(type as MotionGraphicType, { label: "a named thing" })]),
      ]);
      expect(lifecycle.lives, type).toHaveLength(1);
      const life = lifecycle.lives[0]!;
      expect(
        life.outcome === "TRANSLATED" || isTerminalGraphicOutcome(life.outcome),
        `${type} produced the non-terminal, non-progress outcome ${life.outcome}`
      ).toBe(true);
      if (life.outcome !== "TRANSLATED") expect(life.detail, `${type} dropped with no reason`).toBeTruthy();
    }
  });

  it("the five with no component are named, and named as a TYPE problem", () => {
    /**
     * chart, comparison, animated_icon, highlight_box and arrow have no component in this build.
     * That is a fact about the vocabulary, and it must not read as a payload problem — the two
     * have completely different fixes.
     */
    for (const type of ["chart", "comparison", "animated_icon", "arrow"]) {
      const { lifecycle } = lifecycleFor([
        decision(`b_${type}`, [graphic(type as MotionGraphicType, { label: "a named thing" })]),
      ]);
      expect(lifecycle.lives[0]!.outcome, type).toBe("DROPPED_UNSUPPORTED");
      expect(lifecycle.lives[0]!.detail, type).toContain("no component in this build draws");
    }
  });

  it("the ones that DO have a component reach the timeline", () => {
    for (const type of ["lower_third", "date_card", "location_card", "quote"]) {
      const { lifecycle } = lifecycleFor([
        decision(`b_${type}`, [graphic(type as MotionGraphicType, { label: "Berlin, April 1945" })]),
      ]);
      expect(lifecycle.lives[0]!.outcome, type).toBe("TRANSLATED");
    }
  });

  it("a translated type is followed under the RENDERER's name, not the planner's", () => {
    /** `timeline` becomes `timeline_event`; the join must use the translated id or it unpairs. */
    const { lifecycle } = lifecycleFor([
      decision("b0", [graphic("timeline", { events: [{ year: "1945", label: "Berlin falls" }] })]),
    ]);
    expect(lifecycle.lives[0]).toMatchObject({
      plannedType: "timeline",
      rendererType: "timeline_event",
      outcome: "TRANSLATED",
    });
  });
});

/* ═══════════════ B/C. highlight_box and dust ═══════════════ */

describe("B — highlight_box, and why it cannot simply be pointed at a component", () => {
  it("the planner emits it carrying only a label — there is no region to draw a box around", () => {
    /**
     * THE FINDING OF THIS ROUND.
     *
     * `motionGraphicsPlanner` writes `{ label: intent.objects[0] }` — the NAME of an object the
     * narration mentions. It knows of no x, y, width or height, because nothing in this pipeline
     * detects where in the frame that object is. A component drawing a rectangle would therefore
     * have to choose a position, and a box drawn around a guessed part of the picture is worse
     * than no box: it points confidently at the wrong thing.
     *
     * This test pins the payload so the day the planner gains a real region, it fails and says so.
     */
    const src = fs.readFileSync(
      path.join(SERVER, "cinematicEditingEngine", "motionGraphicsPlanner.ts"),
      "utf8"
    );
    const at = src.indexOf('"highlight_box"');
    expect(at).toBeGreaterThan(-1);
    const payload = src.slice(at, at + 200);
    expect(payload).toContain("{ label: intent.objects[0] }");
    for (const field of ["normX", "normY", "normW", "normH", "region"]) {
      expect(payload, `the planner now supplies ${field} — a real box is drawable, revisit this`).not.toContain(field);
    }
  });

  it("the RENDERER now supports it — the gap that remains is the payload, not the type", () => {
    /**
     * RONDE 124 wrote the component. `highlight_box` is in RENDERABLE_GRAPHICS, needs no
     * translation, and draws an outlined rectangle over the region it is given; R160 §7's pixel
     * test renders it and reads its alpha back like every other drawable type.
     *
     * So a planner-emitted box — label, no region — is now DROPPED_INVALID_PAYLOAD rather than
     * DROPPED_UNSUPPORTED, and that is the whole point of keeping the two apart: the first says
     * "give this graphic coordinates", the second says "write a component". Only the first is
     * still open.
     */
    const { lifecycle } = lifecycleFor([
      decision("b0", [graphic("highlight_box", { label: "the pistol" })]),
    ]);
    expect(lifecycle.lives[0]).toMatchObject({
      plannedType: "highlight_box",
      outcome: "DROPPED_INVALID_PAYLOAD",
    });
  });

  it("with a real region it reaches the timeline like any other graphic", () => {
    const { lifecycle } = lifecycleFor([
      decision("b0", [
        graphic("highlight_box", { normX: 0.1, normY: 0.2, normW: 0.3, normH: 0.4 }),
      ]),
    ]);
    expect(lifecycle.lives[0]!.outcome).toBe("TRANSLATED");
  });
});

describe("C — dust is an EFFECT, and its rejection is terminal and counted", () => {
  it("it is in the planner's effect vocabulary and not in the renderer's", () => {
    const src = fs.readFileSync(path.join(SERVER, "cinematicEditingEngine", "types.ts"), "utf8");
    const at = src.indexOf("export type VisualEffectType =");
    expect(src.slice(at, src.indexOf(";", at))).toContain('"dust"');
    expect(RENDERABLE_EFFECTS.has("dust")).toBe(false);
  });

  it("a planned dust effect is DROPPED_UNSUPPORTED and counted, not merely mentioned", () => {
    const out = effectsLifecycle([{ beatId: "b0", effectType: "dust", reason: "aged-film look" }]);
    expect(out.dropped).toBe(1);
    expect(out.carried).toBe(0);
    expect(out.lives[0]!.detail).toContain("no filter in this renderer executes");
  });

  it("the three the planner can ask for and this renderer cannot run are exactly these", () => {
    const unrunnable = ["particles", "dust", "lens_flare"];
    for (const e of unrunnable) expect(RENDERABLE_EFFECTS.has(e), e).toBe(false);
    for (const e of ["film_grain", "noise", "vignette", "letterbox", "glow", "bloom", "chromatic_aberration"]) {
      expect(RENDERABLE_EFFECTS.has(e), e).toBe(true);
    }
  });
});

/* ═══════════════ D/E. the lifecycle adds up ═══════════════ */

describe("D/E — the outcomes account for the plan, and nothing disappears", () => {
  const mixed = () =>
    lifecycleFor([
      decision("b0", [
        graphic("lower_third", { label: "Adolf Hitler" }),
        graphic("highlight_box", { label: "the pistol" }, 1),
      ]),
      decision("b1", [graphic("bar_chart" as MotionGraphicType, { label: "no series here" })]),
    ]);

  it("every planned graphic gets exactly one outcome", () => {
    const { lifecycle } = mixed();
    expect(lifecycle.lives).toHaveLength(3);
    const total = Object.values(lifecycle.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
  });

  it("nothing is unaccounted for", () => {
    expect(mixed().lifecycle.unaccounted).toEqual([]);
  });

  it("a graphic the adapter never put on the track is DROPPED_NOT_TRANSLATED, not forgotten", () => {
    /** Constructed directly: an empty track with a plan is the shape of a graphic that vanished. */
    const lifecycle = graphicsLifecycle({
      planned: [{ beatId: "b0", graphicType: "lower_third", data: { label: "x" }, startSec: 0, reason: "r" }],
      onTrack: [],
    });
    expect(lifecycle.lives[0]!.outcome).toBe("DROPPED_NOT_TRANSLATED");
    expect(lifecycle.unaccounted).toEqual([]);
  });

  it("a graphic switched off in the editor ends as DROPPED_DISABLED", () => {
    const { lifecycle: base, timeline } = lifecycleFor([
      decision("b0", [graphic("lower_third", { label: "Adolf Hitler" })]),
    ]);
    const track = timeline.tracks.find((t) => t.kind === "GRAPHICS");
    const graphics = track && track.kind === "GRAPHICS" ? track.graphics : [];
    const off = graphicsLifecycle({
      planned: [{ beatId: "b0", graphicType: "lower_third", data: { label: "Adolf Hitler" }, startSec: 0, reason: "r" }],
      onTrack: graphics.map((g) => ({ ...g, disabled: true })),
    });
    expect(base.lives[0]!.outcome).toBe("TRANSLATED");
    expect(off.lives[0]!.outcome).toBe("DROPPED_DISABLED");
  });
});

/* ═══════════════ F. the two failures stay different findings ═══════════════ */

describe("F — an unknown TYPE and a bad PAYLOAD are not the same defect", () => {
  it("a bar chart with no numbers is a payload problem on a type that draws", () => {
    const { lifecycle } = lifecycleFor([
      decision("b0", [graphic("bar_chart" as MotionGraphicType, { label: "nothing to plot" })]),
    ]);
    expect(lifecycle.lives[0]!.outcome).toBe("DROPPED_INVALID_PAYLOAD");
    expect(lifecycle.lives[0]!.detail).toContain("is drawable and this payload is not");
  });

  it("the same bar chart WITH numbers reaches the timeline", () => {
    const { lifecycle } = lifecycleFor([
      decision("b0", [
        graphic("bar_chart" as MotionGraphicType, {
          label: "losses",
          series: [{ label: "1944", value: 3 }, { label: "1945", value: 7 }],
        }),
      ]),
    ]);
    expect(lifecycle.lives[0]!.outcome).toBe("TRANSLATED");
  });

  it("and a type with no component is never reported as a payload problem", () => {
    const { lifecycle } = lifecycleFor([
      decision("b0", [graphic("comparison", { label: "then and now" })]),
    ]);
    expect(lifecycle.lives[0]!.outcome).toBe("DROPPED_UNSUPPORTED");
  });
});

/* ═══════════════ G/H. the renderer's own report ═══════════════ */

describe("G/H — what the renderer received, and what it said it drew", () => {
  const planned = () => [decision("b0", [graphic("lower_third", { label: "Adolf Hitler" })])];

  const idOf = () => {
    const { timeline } = lifecycleFor(planned());
    const track = timeline.tracks.find((t) => t.kind === "GRAPHICS");
    return track && track.kind === "GRAPHICS" ? track.graphics[0]!.id : "";
  };

  it("without a renderer report a graphic stops at TRANSLATED — no ending is invented", () => {
    /**
     * The plan can be audited before any render exists. Calling a graphic DROPPED_RENDER_ERROR
     * because no renderer has run yet would be a fabricated ending, which is the whole failure
     * mode this round is about.
     */
    expect(lifecycleFor(planned()).lifecycle.lives[0]!.outcome).toBe("TRANSLATED");
  });

  it("in the renderer's props and reported drawn → DRAWN", () => {
    const id = idOf();
    const { lifecycle } = lifecycleFor(planned(), { inputIds: [id], drawnIds: [id] });
    expect(lifecycle.lives[0]!.outcome).toBe("DRAWN");
  });

  it("in the props and NOT reported drawn → DROPPED_RENDER_ERROR", () => {
    const id = idOf();
    const { lifecycle } = lifecycleFor(planned(), { inputIds: [id], drawnIds: [] });
    expect(lifecycle.lives[0]!.outcome).toBe("DROPPED_RENDER_ERROR");
    expect(lifecycle.lives[0]!.detail).toContain("did not report drawing it");
  });

  it("on the timeline and absent from the props → DROPPED_RENDER_ERROR, with a different reason", () => {
    const { lifecycle } = lifecycleFor(planned(), { inputIds: [], drawnIds: [] });
    expect(lifecycle.lives[0]!.outcome).toBe("DROPPED_RENDER_ERROR");
    expect(lifecycle.lives[0]!.detail).toContain("absent from the renderer's props");
  });

  it("a delivered graphic is traceable back to the planner's own instruction", () => {
    const id = idOf();
    const { lifecycle } = lifecycleFor(planned(), { inputIds: [id], drawnIds: [id] });
    expect(lifecycle.lives[0]).toMatchObject({
      id,
      beatId: "b0",
      plannedType: "lower_third",
      rendererType: "lower_third",
    });
  });
});

/* ═══════════════ I. the report, and the word it may not use ═══════════════ */

describe("I — the line says what it measured, and no more", () => {
  it("planned equals the sum of the outcomes it prints", () => {
    const { lifecycle } = lifecycleFor([
      decision("b0", [
        graphic("lower_third", { label: "Adolf Hitler" }),
        graphic("highlight_box", { label: "the pistol" }, 1),
        graphic("dust" as MotionGraphicType, { label: "x" }, 2),
      ]),
    ]);
    const head = formatGraphicsLifecycle("r124", lifecycle)[0]!;
    expect(head).toContain("planned=3");
    expect(head).toContain("unaccounted=0");
  });

  it("every drop that happened gets its own line, with an example", () => {
    const { lifecycle } = lifecycleFor([
      decision("b0", [graphic("arrow", { label: "the door" })]),
    ]);
    const lines = formatGraphicsLifecycle("r124", lifecycle);
    expect(lines.some((l) => l.includes("DROPPED_UNSUPPORTED=1"))).toBe(true);
    expect(lines.some((l) => l.includes('"arrow"'))).toBe(true);
  });

  it("effects are counted on the same line when the caller has them", () => {
    const { lifecycle } = lifecycleFor([decision("b0", [], ["dust", "film_grain"])]);
    const effects = effectsLifecycle([
      { beatId: "b0", effectType: "dust", reason: "r" },
      { beatId: "b0", effectType: "film_grain", reason: "r" },
    ]);
    const head = formatGraphicsLifecycle("r124", lifecycle, effects)[0]!;
    expect(head).toContain("effectsCarried=1");
    expect(head).toContain("effectsDropped=1");
  });

  it("nothing here claims a graphic was DELIVERED — no frame was inspected", () => {
    /**
     * `DRAWN` is the renderer's own count. `graphicsOverlayInk` is what reads pixels back, and it
     * answers for the whole overlay rather than per graphic. A `DELIVERED` in this vocabulary
     * would be a claim this module cannot support, so the word is kept out of it.
     */
    const src = fs.readFileSync(path.join(SERVER, "graphicsLifecycle.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("DELIVERED");
    expect([...GRAPHIC_STAGES, ...GRAPHIC_DROPS]).not.toContain("DELIVERED");
  });
});

/* ═══════════════ structural guards (§15) ═══════════════ */

describe("structural — the join cannot drift from the adapter", () => {
  it("the lifecycle asks the renderer's own predicate, not a list of its own", () => {
    const src = fs.readFileSync(path.join(SERVER, "graphicsLifecycle.ts"), "utf8");
    expect(src).toContain('from "./graphicsVocabulary"');
    expect(src).toContain("graphicIsRenderable(");
    /** A second vocabulary is exactly how the three lists in graphicsVocabulary's header drifted. */
    expect(src).not.toContain("new Set([");
  });

  it("it builds the id with the same function the adapter builds it with", () => {
    const src = fs.readFileSync(path.join(SERVER, "graphicsLifecycle.ts"), "utf8");
    expect(src).toContain('timelineElementId("gfx"');
    expect(fs.readFileSync(path.join(SERVER, "edlToTimeline.ts"), "utf8")).toContain(
      'timelineElementId("gfx"'
    );
  });

  it("the production log actually prints it — a report with no caller measures nothing", () => {
    const production = fs.readFileSync(path.join(SERVER, "cinematicProduction.ts"), "utf8");
    expect(production).toContain("formatCinematicGraphicsLifecycle(result)");
  });

  it("the older [Graphics] line is kept, not redefined under the same name", () => {
    /**
     * Four rounds of reports are written in `planned/rendered/skipped`. Replacing a number people
     * read with a differently-defined number of the same name is how a metric starts lying, so the
     * new counts sit BESIDE it under their own name.
     */
    const production = fs.readFileSync(path.join(SERVER, "cinematicProduction.ts"), "utf8");
    expect(production).toContain("formatCinematicGraphics(result)");
    const pipeline = fs.readFileSync(path.join(SERVER, "cinematicPipeline.ts"), "utf8");
    expect(pipeline).toContain("export function formatCinematicGraphics(");
    expect(pipeline).toContain("export function formatCinematicGraphicsLifecycle(");
  });

  it("graphics still reach the MP4 only through the cinematic timeline", () => {
    /**
     * §5 — no second graphics engine. `professionalRenderEngine/motionGraphicsRenderer` has an
     * ffmpeg drawbox for `highlight_box`, and it is UNWIRED: nothing outside that directory
     * imports it. Wiring it would put graphics into the final ffmpeg outside the timeline, which
     * is the parallel pipeline this round is forbidden to build.
     */
    const wired = fs
      .readdirSync(SERVER)
      .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
      .map((f) => fs.readFileSync(path.join(SERVER, f), "utf8"))
      .filter((src) => src.includes("professionalRenderEngine/motionGraphicsRenderer"));
    expect(wired, "the unwired ffmpeg graphics engine gained a caller").toEqual([]);
  });

  it("a renderable type is renderable for the same reason on both sides", () => {
    /** One predicate, asked twice, must give one answer — the invariant R160 §7 established. */
    for (const type of ["lower_third", "timeline_event", "bar_chart"]) {
      const good = { label: "x", series: [{ label: "a", value: 1 }] };
      expect(graphicIsRenderable(type, good, "x"), type).toBe(true);
    }
    expect(graphicIsRenderable("highlight_box", { label: "x" }, "x")).toBe(false);
  });
});
