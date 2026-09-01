/**
 * RONDE 207 — the complete overlay chain, type by type.
 *
 * ── Why this file exists when R178, R185 and R186 already passed ─────────────────────────────
 *
 * Each of those proved a chain end to end for the types a REAL render happened to plan. None of
 * them walks the vocabulary. So the question R207 actually asks — "for every kind of graphic and
 * every kind of caption the planner can emit, is it planned / rendered / skipped, and why" — had
 * no single answer anywhere, and a tenth caption type added tomorrow would reach no test at all.
 *
 * This file enumerates BOTH unions from the engine's own types and requires every member to be
 * accounted for. Not every member has to draw: five graphic types deliberately do not, because no
 * component draws them and pointing them at a text card would substitute one graphic for another.
 * What is forbidden is a member that is neither drawn nor reported — silence about a thing the
 * planner asked for.
 *
 * The two unions are read from `cinematicEditingEngine/types.ts` rather than restated here, so
 * adding a member to either one fails this file until somebody decides what happens to it.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";

import { RENDERER_GRAPHIC_TYPE, rendererGraphicType, trackForCaption, translateEdl } from "./edlToTimeline";
import { captionTrack, textTrackOf } from "./projectTimeline";
import { RENDERABLE_GRAPHICS, graphicIsRenderable } from "./graphicsVocabulary";
import type { CaptionInstruction, CaptionType, MotionGraphicType } from "./cinematicEditingEngine/types";

const TYPES_SRC = fs.readFileSync("server/cinematicEditingEngine/types.ts", "utf8");

/** Read a string-literal union out of the engine's own type file. */
function unionMembers(name: string): string[] {
  const start = TYPES_SRC.indexOf(`export type ${name} =`);
  expect(start, `${name} is no longer declared where this test reads it`).toBeGreaterThan(-1);
  const body = TYPES_SRC.slice(start, TYPES_SRC.indexOf(";", start));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

const CAPTION_TYPES = unionMembers("CaptionType") as CaptionType[];
const GRAPHIC_TYPES = unionMembers("MotionGraphicType") as MotionGraphicType[];

/* ═══════════════════════ graphics: drawn, or reported as not drawn ═══════════════════════ */

describe("R207 — every motion-graphic type the planner can emit is accounted for", () => {
  it("the vocabulary is the thirteen the engine declares", () => {
    expect(GRAPHIC_TYPES).toEqual([
      "progress_bar", "statistic_counter", "map", "timeline",
      "chart", "comparison", "animated_icon", "highlight_box", "arrow",
      /**
       * GRAPHICS MASTER FIX — the four the renderer could always draw and the planner could not
       * ask for. Spelled with the RENDERER's own names, so they need no translation entry and
       * `graphicIsRenderable` finds them directly in RENDERABLE_GRAPHICS.
       */
      "lower_third", "date_card", "location_card", "quote",
    ]);
  });

  /**
   * The point of adding them: they draw. A planner type that reaches no component is the defect
   * R178 found and R207 pinned, so a new type has to clear the same bar on the day it arrives.
   */
  it("the four new types all reach a real component", () => {
    for (const t of ["lower_third", "date_card", "location_card", "quote"] as const) {
      expect(RENDERABLE_GRAPHICS.has(rendererGraphicType(t)), `${t} has no component`).toBe(true);
    }
  });

  /**
   * ── Two separate questions, kept separate ───────────────────────────────────────────────────
   *
   * `graphicIsRenderable` answers a compound one: is there a COMPONENT with this name, AND does
   * this particular payload have what that component needs to draw? R178 already owns the second
   * half against the real planner's output, which is the only honest way to ask it — inventing a
   * payload here would prove that a fixture I wrote satisfies a check I also chose.
   *
   * So this asks only the first half, which is the half that is a property of the CHAIN rather
   * than of one render: the four types a documentary actually plans each translate to a name the
   * renderer has a component for.
   */
  it("progress, counter, map and timeline each translate to a real component name", () => {
    for (const t of ["progress_bar", "statistic_counter", "map", "timeline"] as const) {
      const rendered = rendererGraphicType(t);
      expect(RENDERER_GRAPHIC_TYPE[t], `${t} has no translation`).toBeTruthy();
      expect(RENDERABLE_GRAPHICS.has(rendered), `${t} → ${rendered} has no component`).toBe(true);
    }
  });

  /**
   * And the five that do not draw must not draw ACCIDENTALLY either — an untranslated planner name
   * must not happen to collide with a component the renderer has, which would quietly hand a
   * chart's payload to whatever component shares its name.
   */
  it("the five with no component are honestly undrawable, not accidentally drawable", () => {
    /** Unchanged: these five still have no component and must not appear to have one. */
    for (const t of ["chart", "comparison", "animated_icon", "highlight_box", "arrow"] as const) {
      expect(RENDERER_GRAPHIC_TYPE[t], `${t} gained a translation — update this test`).toBeUndefined();
      const rendered = rendererGraphicType(t);
      expect(RENDERABLE_GRAPHICS.has(rendered), `${t} collides with a component name`).toBe(false);
      /** And the full check agrees, for any payload at all. */
      expect(graphicIsRenderable(rendered, {}, "a label"), `${t} draws by accident`).toBe(false);
    }
  });

  /** No member of the union is missing from the two groups above. */
  it("every type is either translated or explicitly not", () => {
    const translated = GRAPHIC_TYPES.filter((t) => RENDERER_GRAPHIC_TYPE[t]);
    const untranslated = GRAPHIC_TYPES.filter((t) => !RENDERER_GRAPHIC_TYPE[t]);
    expect([...translated, ...untranslated].sort()).toEqual([...GRAPHIC_TYPES].sort());
    /**
     * Still four TRANSLATED — the new types deliberately need no entry, because they already carry
     * the renderer's own name. "Untranslated" therefore no longer means "undrawable"; the test
     * below separates the two.
     */
    expect(translated).toHaveLength(4);
  });
});

/* ═══════════════════════ captions: every type lands on a track ═══════════════════════ */

function caption(over: Partial<CaptionInstruction> & { captionType: CaptionType }): CaptionInstruction {
  return {
    text: `text for ${over.captionType}`,
    startSec: 0.5,
    endSec: 2.5,
    animation: "fade",
    position: "bottom",
    reason: "test",
    ...over,
  };
}

/** A one-clip decision carrying whichever captions the case needs. */
function decisionWith(captions: CaptionInstruction[]) {
  return {
    beatId: "s0b0",
    sceneIndex: 0,
    clip: {
      candidateId: "pexels:1", assetType: "video",
      startSec: 0, endSec: 4, trimStartSec: 0, trimEndSec: 4,
    },
    shot: { shotType: "medium", reason: "test" },
    camera: { movement: "static", intensity: 0.2, reason: "test" },
    effects: [],
    transitionIn: { type: "cut", durationSec: 0, reason: "test" },
    captions,
    motionGraphics: [],
    sounds: [],
    pacing: { cutsPerMinute: 12, averageShotLengthSec: 4, reason: "test" },
  };
}

function timelineFor(captions: CaptionInstruction[], words?: { word: string; startSec: number; endSec: number }[]) {
  return translateEdl({
    videoId: 1,
    inputs: [{
      decision: decisionWith(captions) as never,
      sceneOffsetSec: 0,
      identity: { provider: "pexels", providerAssetId: "1" },
    } as never],
    ...(words ? { words } : {}),
  } as never);
}

describe("R207 — every caption type the planner can emit reaches the screen", () => {
  it("the vocabulary is the twelve the engine declares", () => {
    expect(CAPTION_TYPES).toHaveLength(12);
    expect(CAPTION_TYPES).toContain("date");
    expect(CAPTION_TYPES).toContain("location");
    expect(CAPTION_TYPES).toContain("timeline_label");
    expect(CAPTION_TYPES).toContain("subtitle");
  });

  /**
   * The invariant. Every type produces exactly one element carrying the planner's own words —
   * nothing is dropped, and nothing is drawn empty.
   */
  it("no type is silently dropped, and none arrives without words", () => {
    const { timeline } = timelineFor(CAPTION_TYPES.map((captionType) => caption({ captionType })));
    const all = [...captionTrack(timeline), ...textTrackOf(timeline, "TEXT")];
    expect(all, "a caption type produced no element").toHaveLength(CAPTION_TYPES.length);
    for (const el of all) expect(el.text.trim(), "an overlay arrived with no words").not.toBe("");
  });

  /**
   * The track split, which is an editorial decision and not a detail: a viewer switching SUBTITLES
   * off must keep the date cards, the location tags and the names. Only spoken narration is a
   * caption; everything else is an overlay the film is making.
   *
   * R207 names four of these by hand — date card, event label, archive/footage label, location tag
   * — and all four are TEXT, not CAPTIONS.
   */
  it("only spoken narration is a caption; the editorial overlays are TEXT", () => {
    for (const captionType of CAPTION_TYPES) {
      const expected = captionType === "subtitle" ? "CAPTIONS" : "TEXT";
      expect(trackForCaption(caption({ captionType })), captionType).toBe(expected);
    }
  });

  it("the date card, the event label and the location tag survive the switch being off", () => {
    const { timeline } = timelineFor([
      caption({ captionType: "date", text: "Berlin, 1945" }),
      caption({ captionType: "timeline_label", text: "1945 — the fall" }),
      caption({ captionType: "location", text: "Brandenburg Gate" }),
      caption({ captionType: "subtitle", text: "spoken words" }),
    ]);
    expect(textTrackOf(timeline, "TEXT").map((t) => t.text).sort())
      .toEqual(["1945 — the fall", "Berlin, 1945", "Brandenburg Gate"]);
    expect(captionTrack(timeline).map((t) => t.text)).toEqual(["spoken words"]);
  });
});

/* ═══════════════════════ karaoke: the word timing that makes it possible ═══════════════════════ */

describe("R207 — word timing reaches the caption that speaks the words", () => {
  const words = [
    { word: "Berlin", startSec: 0.4, endSec: 0.9 },
    { word: "in", startSec: 0.9, endSec: 1.1 },
    { word: "winter", startSec: 1.1, endSec: 1.8 },
    /** Belongs to a LATER caption — must not leak into this one. */
    { word: "afterwards", startSec: 3.4, endSec: 3.9 },
  ];

  it("attaches the spoken words to the caption, and only its own", () => {
    const { timeline } = timelineFor([caption({ captionType: "subtitle", text: "Berlin in winter" })], words);
    const [cap] = captionTrack(timeline);
    expect(cap!.words?.map((w) => w.word)).toEqual(["Berlin", "in", "winter"]);
  });

  /**
   * R186's overlap rule, pinned here as the reason karaoke can start on the first word: a word
   * that begins a fraction before the caption appears is still that caption's word. Containment
   * would drop it and leave the first word unhighlighted for its whole duration.
   */
  it("a word that starts just before the caption is still its word", () => {
    const { timeline } = timelineFor(
      [caption({ captionType: "subtitle", text: "Berlin", startSec: 0.5, endSec: 2.5 })],
      [{ word: "Berlin", startSec: 0.35, endSec: 0.95 }]
    );
    const [cap] = captionTrack(timeline);
    expect(cap!.words?.map((w) => w.word)).toEqual(["Berlin"]);
  });

  /**
   * And with no measured alignment there are no words — not invented evenly-spaced ones. A karaoke
   * highlight running on guessed timings drifts away from the voice within a sentence, which reads
   * as worse than no highlight at all.
   */
  it("no measured alignment means no words, never guessed ones", () => {
    const { timeline } = timelineFor([caption({ captionType: "subtitle", text: "Berlin in winter" })]);
    const [cap] = captionTrack(timeline);
    expect(cap!.words).toBeUndefined();
  });
});
