/**
 * EXISTING ANIMATIONS AND TRANSITIONS, ACTUALLY USED.
 *
 *   GRAPHICS     no planner named an animation, so every graphic entered with `fade_rise`. Each
 *                graphic type now gets one fixed entrance from Remotion's existing vocabulary.
 *   TRANSITIONS  the engine's `blur` and `slide` were mapped to null — a cut — although the timeline
 *                and the renderer both have them. Everything without a renderer equivalent stays a
 *                reported cut.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { graphicAnimationFor, DEFAULT_GRAPHIC_ANIMATION } from "./graphicsVocabulary";
import { placePrimaryGraphics, TRANSITION_MAP, translateEdl } from "./edlToTimeline";
import type { EditDecision, TransitionType } from "./cinematicEditingEngine/types";
import { planTransition } from "./cinematicEditingEngine/transitionPlanner";
import { timelineToRemotionProps } from "./remotionProps";
import { buildTransitionGraph, transitionIsRenderable, XFADE_TRANSITIONS } from "./timelineFilters";
import { PROGRESSIVE_ANIMATIONS } from "./remotion/components/animation";
import { emptyTimeline, type TimelineGraphic, type TimelineVideoClip } from "./projectTimeline";

const decision = (over: Partial<EditDecision> = {}): EditDecision => ({
  beatId: "s0b0",
  sceneIndex: 0,
  clip: {
    candidateId: "wikimedia:File:X.jpg",
    assetType: "video",
    localPath: null,
    remoteUrl: "https://upload.wikimedia.org/x.mp4",
    trimStartSec: 2.5,
    trimEndSec: 6.5,
    startSec: 0,
    endSec: 4,
    timingSource: "tts_word_alignment",
  },
  shot: { shotType: "wide", reason: "r" } as EditDecision["shot"],
  camera: { movement: "slow_push", intensity: 0.4, reason: "r" },
  transitionIn: { type: "cut", durationSec: 0, reason: "r" },
  captions: [],
  motionGraphics: [],
  effects: [],
  sounds: [],
  pacing: { tone: "dramatic", cutSpeedMultiplier: 1, movementIntensity: 0.5, reason: "r" },
  ...over,
});
const identity = { provider: "wikimedia", providerAssetId: "File:X.jpg", mediaUrl: "https://u/x.mp4" };

/** Whole-frame entrances Remotion's `animationAt` draws for a graphic (no progressive text reveals). */
const WHOLE_FRAME = new Set(["fade", "fade_rise", "fade_scale", "scale", "pop", "bounce", "slide_up", "slide_down", "slide_left", "slide_right"]);

describe("GRAPHICS — each type enters with an existing animation", () => {
  it("1. a number (counter / statistic / stat) pops", () => {
    for (const t of ["counter", "statistic", "stat"]) expect(graphicAnimationFor(t), t).toBe("pop");
  });
  it("2. a chart grows in", () => {
    for (const t of ["bar_chart", "horizontal_bar", "line_chart", "pie_chart", "donut_chart", "percentage_ring", "progress"]) {
      expect(graphicAnimationFor(t), t).toBe("fade_scale");
    }
  });
  it("3. a map grows in", () => {
    for (const t of ["map_point", "route", "multi_point"]) expect(graphicAnimationFor(t), t).toBe("fade_scale");
  });
  it("4. a card of words rises; a name band slides in from its edge; a chapter card settles", () => {
    for (const t of ["quote", "location_card", "date_card", "timeline_event"]) expect(graphicAnimationFor(t), t).toBe("slide_up");
    for (const t of ["lower_third", "name"]) expect(graphicAnimationFor(t), t).toBe("slide_right");
    for (const t of ["chapter_card", "chapter_title"]) expect(graphicAnimationFor(t), t).toBe("fade_scale");
  });
  it("5. an unknown type keeps fade_rise", () => {
    expect(DEFAULT_GRAPHIC_ANIMATION).toBe("fade_rise");
    for (const t of ["highlight_box", "headline", "something_new", ""]) expect(graphicAnimationFor(t), t).toBe("fade_rise");
  });
  it("same type, same answer — no randomness", () => {
    for (const t of ["counter", "quote", "map_point", "chapter_card", "unknown"]) {
      expect(graphicAnimationFor(t)).toBe(graphicAnimationFor(t));
    }
  });

  it("6a. a planned counter reaches the timeline AND the Remotion props as `pop`", () => {
    const { timeline } = translateEdl({
      videoId: 1,
      inputs: [{
        decision: decision({
          motionGraphics: [{ graphicType: "statistic_counter", data: { fromValue: 0, toValue: 87, suffix: "%", label: "87%" }, startSec: 0.5, durationSec: 2.5, reason: "a number" }],
        }),
        sceneOffsetSec: 0,
        identity,
      }],
    });
    const track = timeline.tracks.find((t) => t.kind === "GRAPHICS");
    const g = track && track.kind === "GRAPHICS" ? track.graphics[0] : undefined;
    expect(g?.graphicType).toBe("counter");
    expect(g?.animation).toBe("pop");
    const props = timelineToRemotionProps({ timeline });
    expect(props.graphics.find((p) => p.id === g!.id)?.animation).toBe("pop");
  });

  it("6b. a chapter card standing in for an empty sentence reaches the Remotion props as `fade_scale`", () => {
    const timeline = emptyTimeline(1);
    const clips: TimelineVideoClip[] = [{
      id: "shot", source: { provider: "wikimedia", providerAssetId: "File:X.jpg" },
      timelineStart: 0, timelineEnd: 4, sourceIn: 0, sourceOut: 4,
    } as TimelineVideoClip];
    const graphics: TimelineGraphic[] = [];
    placePrimaryGraphics(clips, graphics, [{
      beatId: "s0b1", startSec: 4, endSec: 8,
      graphic: { graphicType: "chapter_card", data: { text: "The Wall falls" }, reason: "CHAPTER_CARD_FALLBACK" },
    }]);
    expect(graphics[0]?.animation).toBe("fade_scale");
    const video = timeline.tracks.find((t) => t.kind === "VIDEO");
    if (video && video.kind === "VIDEO") video.clips.push(...clips);
    const gfx = timeline.tracks.find((t) => t.kind === "GRAPHICS");
    if (gfx && gfx.kind === "GRAPHICS") gfx.graphics.push(...graphics);
    timeline.durationSec = 8;
    expect(timelineToRemotionProps({ timeline }).graphics[0]?.animation).toBe("fade_scale");
  });

  it("6c. the text director's map stand-in (location card) gets its type's animation too", () => {
    const src = fs.readFileSync(path.join(__dirname, "onScreenTextDirector.ts"), "utf8");
    expect(src).toContain('animation: graphicAnimationFor("location_card"),');
  });

  it("7. no unsupported animation: every chosen entrance is a whole-frame one Remotion draws for a graphic", () => {
    const types = [
      "counter", "statistic", "stat", "bar_chart", "horizontal_bar", "line_chart", "pie_chart", "donut_chart",
      "percentage_ring", "progress", "map_point", "route", "multi_point", "quote", "location_card", "date_card",
      "timeline_event", "lower_third", "name", "chapter_card", "chapter_title", "shape", "icon", "unknown",
    ];
    const anim = fs.readFileSync(path.join(__dirname, "remotion", "components", "animation.ts"), "utf8");
    for (const t of types) {
      const a = graphicAnimationFor(t);
      expect(WHOLE_FRAME.has(a), `${t} → ${a}`).toBe(true);
      expect(PROGRESSIVE_ANIMATIONS.has(a), `${t} → ${a}`).toBe(false);
      expect(anim, `animationAt draws ${a}`).toContain(`case "${a}":`);
    }
  });

  it("an animation already on a graphic (the editor's) is still carried as is, and none still means fade_rise", () => {
    const timeline = emptyTimeline(1);
    const gfx = timeline.tracks.find((t) => t.kind === "GRAPHICS");
    if (gfx && gfx.kind === "GRAPHICS") {
      gfx.graphics.push(
        { id: "a", graphicType: "quote", data: { text: "x" }, start: 0, end: 2, label: "x", animation: "bounce" },
        { id: "b", graphicType: "quote", data: { text: "y" }, start: 2, end: 4, label: "y" },
      );
    }
    timeline.durationSec = 4;
    expect(timelineToRemotionProps({ timeline }).graphics.map((g) => g.animation)).toEqual(["bounce", "fade_rise"]);
  });
});

describe("TRANSITIONS — only what the renderer draws; everything else a reported cut", () => {
  const into = (type: TransitionType) => {
    const { timeline, unsupported } = translateEdl({
      videoId: 1,
      inputs: [{ decision: decision({ transitionIn: { type, durationSec: 0.5, reason: `planned ${type}` } }), sceneOffsetSec: 0, identity }],
    });
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clip = track && track.kind === "VIDEO" ? track.clips[0]! : null;
    return { kind: clip!.transitionIn, unsupported };
  };

  it("1. cut stays a cut", () => expect(into("cut").kind).toBe("hard_cut"));
  it("2. fade → dissolve, cross_dissolve → crossfade", () => {
    expect(into("fade").kind).toBe("dissolve");
    expect(into("cross_dissolve").kind).toBe("crossfade");
  });
  it("3. dip_to_black stays", () => expect(into("dip_to_black").kind).toBe("dip_to_black"));
  it("4. dip_to_white stays", () => expect(into("dip_to_white").kind).toBe("dip_to_white"));
  it("5. match_cut is a cut, and is not reported as lost", () => {
    const r = into("match_cut");
    expect(r.kind).toBe("hard_cut");
    expect(r.unsupported.some((u) => u.includes("match_cut"))).toBe(false);
  });
  it("blur and slide now reach the timeline under the renderer's own names", () => {
    expect(into("blur").kind).toBe("blur");
    expect(into("slide").kind).toBe("slide_left");
    expect(into("blur").unsupported.some((u) => u.includes('transition "blur"'))).toBe(false);
  });
  it("6. a transition with no renderer equivalent is a cut, and reported", () => {
    for (const t of ["film_burn", "light_leak", "whip", "push", "flash", "motion_blur"] as TransitionType[]) {
      const r = into(t);
      expect(r.kind, t).toBe("hard_cut");
      expect(r.unsupported.some((u) => u.includes(`transition "${t}"`)), t).toBe(true);
    }
  });
  it("every mapped transition is one the renderer can execute", () => {
    for (const [engine, kind] of Object.entries(TRANSITION_MAP)) {
      if (kind == null) continue;
      expect(transitionIsRenderable(kind), `${engine} → ${kind}`).toBe(true);
    }
  });
  it("7. no randomness: the planner gives the same transition for the same input", () => {
    const prev = { shotType: "wide" as const, subject: "wall" };
    const next = { shotType: "close_up" as const, subject: "crowd" };
    const pacing = { tone: "dramatic" as const, cutSpeedMultiplier: 1, movementIntensity: 0.5, reason: "r" };
    const a = planTransition(prev, next, pacing as never);
    const b = planTransition(prev, next, pacing as never);
    expect(a).toEqual(b);
  });
  it("8. the timeline's transition reaches the renderer's join: slide_left → xfade slideleft, blur → hblur", () => {
    expect(XFADE_TRANSITIONS.slide_left).toBe("slideleft");
    expect(XFADE_TRANSITIONS.blur).toBe("hblur");
    const graph = buildTransitionGraph({
      durations: [4, 4, 4],
      transitions: [{ kind: "hard_cut" }, { kind: into("slide").kind, durationSec: 0.3 }, { kind: into("blur").kind, durationSec: 0.35 }],
    });
    expect(graph?.filter).toContain("transition=slideleft");
    expect(graph?.filter).toContain("transition=hblur");
  });
});
