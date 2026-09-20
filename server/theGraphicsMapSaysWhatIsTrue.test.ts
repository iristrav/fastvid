import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  RENDERER_GRAPHIC_TYPE,
  rendererGraphicType,
  graphicLabel,
} from "./edlToTimeline";
import {
  RENDERABLE_GRAPHICS,
  REGION_GRAPHICS,
  graphicIsRenderable,
  readRegion,
} from "./graphicsVocabulary";
import type { MotionGraphicType } from "./cinematicEditingEngine/types";

/**
 * A COMMENT THAT WENT ON BEING WRONG FOR THREE ROUNDS.
 *
 * `RENDERER_GRAPHIC_TYPE`'s doc block is the map a reader consults to answer "why is this graphic
 * not in the film". It said four things that stopped being true:
 *
 *   1. "Why only three of the nine are here" — RONDE 178 added `timeline`, making it four.
 *   2. "The planner names nine kinds" — the union is THIRTEEN.
 *   3. "highlight_box: no component draws a box around a region" — RONDE 124 wrote
 *      `HighlightBox` and put the name in `RENDERABLE_GRAPHICS`.
 *   4. "The other five planner types — chart, comparison, animated_icon, highlight_box, arrow"
 *      — four, and highlight_box is not one of them.
 *
 * None of it changed behaviour: `ronde207OverlayChain` already pins the real rules, and the
 * renderer has been correct throughout. What it changed is where the next engineer looks. Anyone
 * reading that block would set out to WRITE a highlight-box component, when what highlight_box
 * actually lacks is a region in the planner's payload.
 *
 * Prose cannot be typechecked, so this file checks the claims that matter against the code they
 * describe. It asserts the comment does not contain the stale sentences, and — more usefully —
 * that the facts it now states are the facts the vocabulary holds.
 */

const EDL = readFileSync(join(__dirname, "edlToTimeline.ts"), "utf8");

/**
 * The planner's union, read from the engine's own type file — the same way
 * `ronde207OverlayChain` reads it, because it is a type and not a value at runtime.
 */
const GRAPHIC_TYPES: MotionGraphicType[] = (() => {
  const src = readFileSync(join(__dirname, "cinematicEditingEngine", "types.ts"), "utf8");
  const start = src.indexOf("export type MotionGraphicType =");
  expect(start, "MotionGraphicType is no longer declared where this test reads it").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf(";", start));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!) as MotionGraphicType[];
})();

/** The doc block above `RENDERER_GRAPHIC_TYPE`, bounded so the assertions cannot wander. */
const MAP_DOC = (() => {
  const decl = EDL.indexOf("export const RENDERER_GRAPHIC_TYPE");
  expect(decl, "RENDERER_GRAPHIC_TYPE is gone").toBeGreaterThan(0);
  const start = EDL.lastIndexOf("/**", decl);
  expect(start).toBeGreaterThan(0);
  return EDL.slice(start, decl);
})();

describe("the map's documentation matches the vocabulary it describes", () => {
  it("does not claim highlight_box has no component — it has had one since RONDE 124", () => {
    expect(MAP_DOC).not.toContain("no component draws a box around a region");
    expect(RENDERABLE_GRAPHICS.has("highlight_box")).toBe(true);
  });

  it("does not list highlight_box among the types with no component", () => {
    /**
     * Matched on the enumeration itself rather than on the word, because the corrected comment
     * discusses highlight_box at length — and should.
     */
    expect(MAP_DOC).not.toContain("chart, comparison, animated_icon, highlight_box, arrow");
    expect(MAP_DOC).not.toContain("chart, comparison, highlight_box");
  });

  it("does not undercount its own entries, or the union it describes", () => {
    expect(MAP_DOC).not.toContain("Why only three of the nine");
    expect(MAP_DOC).not.toContain("The planner names nine kinds");
    expect(Object.keys(RENDERER_GRAPHIC_TYPE).length).toBe(4);
  });

  it("names every entry the map actually holds", () => {
    for (const planner of Object.keys(RENDERER_GRAPHIC_TYPE)) {
      expect(MAP_DOC, `the map translates ${planner} and the comment never mentions it`)
        .toContain(planner);
    }
  });
});

describe("the facts the corrected comment states", () => {
  it("FOUR planner types are translated, and each reaches a real component", () => {
    const translated = Object.entries(RENDERER_GRAPHIC_TYPE);
    expect(translated.length).toBe(4);
    for (const [planner, renderer] of translated) {
      expect(RENDERABLE_GRAPHICS.has(renderer!), `${planner} → ${renderer} is not a component`)
        .toBe(true);
    }
  });

  it("FOUR planner types genuinely have no component, whatever their payload", () => {
    const none = ["chart", "comparison", "animated_icon", "arrow"] as const;
    for (const t of none) {
      expect(RENDERER_GRAPHIC_TYPE[t], `${t} gained a translation`).toBeUndefined();
      expect(RENDERABLE_GRAPHICS.has(rendererGraphicType(t)), `${t} collides with a component`)
        .toBe(false);
      expect(graphicIsRenderable(rendererGraphicType(t), {}, "a label"), `${t} draws by accident`)
        .toBe(false);
    }
    /**
     * And that accounts for the whole union: 4 translated + 5 that already spell a component's
     * own name + 4 with no component. The union is THIRTEEN — the comment said nine, which was
     * true when the map was written and had not been for several rounds.
     */
    const directName = ["lower_third", "date_card", "location_card", "quote", "highlight_box"];
    expect(GRAPHIC_TYPES.length).toBe(13);
    const accounted = new Set([...Object.keys(RENDERER_GRAPHIC_TYPE), ...none, ...directName]);
    expect(accounted.size).toBe(GRAPHIC_TYPES.length);
    expect([...accounted].sort()).toEqual([...GRAPHIC_TYPES].sort());
    /** The five direct-name types each reach a component without a map entry. */
    for (const t of directName) {
      expect(RENDERER_GRAPHIC_TYPE[t as keyof typeof RENDERER_GRAPHIC_TYPE],
        `${t} should need no translation`).toBeUndefined();
      expect(RENDERABLE_GRAPHICS.has(rendererGraphicType(t)), `${t} has no component`).toBe(true);
    }
  });

  it("HIGHLIGHT_BOX IS REFUSED FOR ITS PAYLOAD, NOT FOR A MISSING COMPONENT", () => {
    /** The distinction the comment now makes, asserted as behaviour. */
    expect(RENDERABLE_GRAPHICS.has("highlight_box")).toBe(true);
    expect(REGION_GRAPHICS.has("highlight_box")).toBe(true);
    expect(RENDERER_GRAPHIC_TYPE["highlight_box"], "it needs no translation").toBeUndefined();
    expect(rendererGraphicType("highlight_box")).toBe("highlight_box");

    /** What the planner emits today: a label and nothing else. */
    expect(readRegion({ label: "the pistol" })).toBeNull();
    expect(graphicIsRenderable("highlight_box", { label: "the pistol" }, "the pistol")).toBe(false);

    /** What it would need — and the comment promises this works with no change to edlToTimeline. */
    expect(readRegion({ normX: 0.1, normY: 0.2, normW: 0.3, normH: 0.4 })).toEqual({
      x: 0.1, y: 0.2, width: 0.3, height: 0.4,
    });
    expect(
      graphicIsRenderable("highlight_box", { normX: 0.1, normY: 0.2, normW: 0.3, normH: 0.4 }, null)
    ).toBe(true);
  });

  it("the comment's promise is testable: a region alone makes it drawable", () => {
    /**
     * Written as the sentence the comment makes — "whoever makes the planner emit
     * normX/normY/normW/normH gets a drawn graphic with no change to this file" — so the promise
     * fails loudly if it ever stops being true.
     */
    const withRegion = { normX: 0.25, normY: 0.25, normW: 0.5, normH: 0.5, label: "the object" };
    expect(rendererGraphicType("highlight_box")).toBe("highlight_box");
    expect(graphicIsRenderable("highlight_box", withRegion, graphicLabel("highlight_box", withRegion) ?? null))
      .toBe(true);
  });

  it("a region outside the frame is still refused", () => {
    /** Not a loosening: the geometry rules stay exactly as strict as they were. */
    expect(readRegion({ normX: 1.2, normY: 0.1, normW: 0.2, normH: 0.2 })).toBeNull();
    expect(readRegion({ normX: 0.1, normY: 0.1, normW: 0, normH: 0.2 })).toBeNull();
    expect(readRegion({ normX: -0.1, normY: 0.1, normW: 0.2, normH: 0.2 })).toBeNull();
  });
});

describe("what this round did not touch", () => {
  it("the map itself is unchanged — only the prose around it", () => {
    expect(RENDERER_GRAPHIC_TYPE).toEqual({
      progress_bar: "progress",
      statistic_counter: "counter",
      map: "map_point",
      timeline: "timeline_event",
    });
  });

  it("the renderable vocabulary is unchanged", () => {
    for (const name of [
      "location_card", "lower_third", "counter", "progress", "percentage_ring",
      "map_point", "timeline_event", "bar_chart", "shape", "icon", "highlight_box",
    ]) {
      expect(RENDERABLE_GRAPHICS.has(name), `${name} left the vocabulary`).toBe(true);
    }
  });
});
