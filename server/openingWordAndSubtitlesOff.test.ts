/**
 * OCTOBER 2026 — the owner's two rules for text in the made video:
 *
 *   1  subtitles are off by default: planned (so the editor can show them), switched off unless the
 *      video's own setting asks for them
 *   2  at the start of the video one word may stand big in the picture: the film's main subject,
 *      over real footage only, as the text director's highest-ranked title
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { buildCinematicSceneInputs, type ProductionBeat, type SceneFacts } from "./cinematicPipelineInputs";
import { OPENING_WORD_FONT_PX, openingWordText, runCinematicPipeline } from "./cinematicPipeline";
import { captionTrack, emptyTimeline, graphicsTrack, type ProjectTimeline, type TimelineGraphic, type TimelineVideoClip } from "./projectTimeline";
import { timelineToRemotionProps } from "./remotionProps";

const TEXTS = [
  "Tesla began as a small company with a bold plan for electric cars.",
  "Its first car, the Roadster, proved electric cars could be fast.",
];
const beat = (index: number, text: string): ProductionBeat => ({
  index, text, searchQuery: "", powerWord: "", keywords: [], holdSec: 4, visualDescription: "",
  voiceStartSec: index * 4, voiceEndSec: index * 4 + 4,
});
function facts(): SceneFacts {
  const beats = TEXTS.map((t, i) => beat(i, t));
  return {
    scene: { index: 0, text: TEXTS.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8 },
    beats,
    clips: beats.map((_, i) => ({
      facts: { localPath: `/tmp/ow-${i}.mp4`, durationSec: 10, widthPx: 1920, heightPx: 1080 },
      adoption: { provider: "internet_archive", providerAssetId: `ia-${i}`, sourceUrl: `https://archive.invalid/${i}.mp4`, assetTitle: "shot", query: "shot" },
    })) as SceneFacts["clips"],
  };
}
function plan(opts: { showSubtitles?: boolean; openingWord?: string | null }) {
  const built = buildCinematicSceneInputs({ scenes: [facts()] });
  return runCinematicPipeline({
    videoId: 9001,
    scenes: built.scenes,
    includeSubtitles: true,
    ...(opts.showSubtitles !== undefined ? { showSubtitles: opts.showSubtitles } : {}),
    ...(opts.openingWord !== undefined ? { openingWord: opts.openingWord } : {}),
  }).timeline as ProjectTimeline;
}
const texts = (t: ProjectTimeline) => {
  const track = t.tracks.find((x) => x.kind === "TEXT");
  return track?.kind === "TEXT" ? track.texts : [];
};

describe("1 — subtitles off by default, still planned", () => {
  it("the video's setting off: every subtitle is on the timeline, switched off, with its reason", () => {
    const caps = captionTrack(plan({ showSubtitles: false }));
    expect(caps.length).toBeGreaterThan(0);
    for (const c of caps) {
      expect(c.disabled).toBe(true);
      expect(c.disabledReason).toBe("subtitles_off");
    }
  });

  it("the video's setting on: the subtitles are drawn", () => {
    const caps = captionTrack(plan({ showSubtitles: true }));
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.every((c) => !c.disabled)).toBe(true);
  });

  it("production hands the video's own setting (off unless switched on) to the pipeline", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(src).toContain("includeSubtitles: true,\n          showSubtitles: enableSubtitles,");
    expect(src).toContain("enableSubtitles = false,  // Subtitles disabled by default");
  });
});

describe("2 — one word big at the start", () => {
  it("the film's main subject, upper case, centred, big, as a title over the first picture", () => {
    const t = plan({ openingWord: "Tesla" });
    const w = texts(t).find((x) => x.id === "txt_opening_word")!;
    expect(w).toBeDefined();
    expect(w.text).toBe("TESLA");
    expect(w.role).toBe("title");
    expect(w.style.position).toBe("center");
    expect(w.style.fontSizePx).toBe(OPENING_WORD_FONT_PX);
    expect(w.style.backgroundOpacity).toBe(0);
    expect(w.start).toBeLessThan(1);
    expect(w.disabled).not.toBe(true);
  });

  it("no word without a subject, or with one longer than two words", () => {
    expect(texts(plan({ openingWord: null })).some((x) => x.id === "txt_opening_word")).toBe(false);
    expect(texts(plan({ openingWord: "The Rise Of Tesla Motors" })).some((x) => x.id === "txt_opening_word")).toBe(false);
  });

  it("no word over a sentence's card or where the opening has no picture", () => {
    const base = emptyTimeline(1);
    base.durationSec = 10;
    const shot = { id: "vc_a", source: { provider: "x" }, timelineStart: 0, timelineEnd: 5, sourceIn: 0, sourceOut: 5 } as TimelineVideoClip;
    const withShot = (t: ProjectTimeline) => {
      for (const tr of t.tracks) if (tr.kind === "VIDEO") tr.clips.push(shot);
      return t;
    };
    expect(openingWordText(withShot(structuredClone(base)), "Tesla")).not.toBeNull();
    expect(openingWordText(structuredClone(base), "Tesla")).toBeNull();
    const carded = withShot(structuredClone(base));
    for (const tr of carded.tracks) {
      if (tr.kind === "GRAPHICS") {
        tr.graphics.push({ id: "g", graphicType: "chapter_card", data: { title: "X", primaryVisual: true }, start: 0, end: 4 } as TimelineGraphic);
      }
    }
    expect(openingWordText(carded, "Tesla")).toBeNull();
  });
});

/**
 * VIDEO 637 — subtitles off hides the subtitles, not WHEN the voice says its words. The render
 * worker builds the props from the stored timeline alone, and the year card waits for its word
 * from the captions' measured timing; with every caption switched off it read words=0 and "2008"
 * stood on screen 2 s before it was said.
 */
describe("3 — subtitles off, the year still waits for its spoken word", () => {
  /** "2008" is the 5th word: said 1.4 s into its sentence — inside the card's first 1.5 s. */
  const EARLY = "Tesla nearly collapsed in 2008 during the financial crisis.";
  /** VIDEO 637's own sentence: "2008" is the 7th word, said 2.1 s in — after the first 1.5 s. */
  const LATE = "Tesla teetered on bankruptcy during the 2008 financial crisis.";
  function yearPlan(yearSentence: string, opts: { showSubtitles?: boolean; anchor?: string } = {}) {
    const texts = ["Tesla was founded as a small company with a bold plan.", yearSentence];
    const beats = texts.map((t, i) => beat(i, t));
    const f = facts();
    const built = buildCinematicSceneInputs({ scenes: [{ ...f, scene: { ...f.scene, text: texts.join(" ") }, beats }] });
    /** Measured TTS timing: one word every 0.35 s from its sentence's start (sentences at 0 s and 4 s). */
    const words = texts.flatMap((t, i) =>
      t.split(" ").map((word, j) => ({ word, startSec: i * 4 + j * 0.35, endSec: i * 4 + j * 0.35 + 0.3 }))
    );
    const timeline = runCinematicPipeline({
      videoId: 9002,
      scenes: built.scenes,
      includeSubtitles: true,
      showSubtitles: opts.showSubtitles ?? false,
      words,
    }).timeline as ProjectTimeline;
    const card = graphicsTrack(timeline).find((g) => g.graphicType === "date_card" && !g.disabled)!;
    if (opts.anchor !== undefined) card.data = { ...card.data, anchorWord: opts.anchor };
    const props = timelineToRemotionProps({ timeline });
    const drawn = props.graphics.find((g) => g.id === card.id)!;
    return {
      timeline,
      props,
      card,
      spoken2008: words.find((w) => w.word === "2008")!,
      drawnStart: drawn.fromFrame / props.fps,
      drawnEnd: (drawn.fromFrame + drawn.durationInFrames) / props.fps,
      /** The second sentence's picture ends at 8 s: the card may not outlast it. */
      beatEnd: 8,
    };
  }

  it("1 — subtitles off: none drawn, yet Remotion receives the timing of 2008", () => {
    const { timeline, props, spoken2008 } = yearPlan(LATE);
    const caps = captionTrack(timeline);
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.every((c) => c.disabled === true && c.disabledReason === "subtitles_off")).toBe(true);
    expect(props.captions).toEqual([]);
    expect(props.words.length).toBeGreaterThan(0);
    expect(props.words.some((w) => w.word === "2008" && w.startSec === spoken2008.startSec)).toBe(true);
  });

  it("2 — early word: the card starts on 2008 and keeps its planned end (the existing rule)", () => {
    const { card, spoken2008, drawnStart, drawnEnd } = yearPlan(EARLY);
    expect(card.data?.anchorWord).toBe("2008");
    expect(card.start).toBeLessThan(spoken2008.startSec - 1);
    expect(drawnStart).toBeCloseTo(spoken2008.startSec, 1);
    expect(drawnEnd).toBeCloseTo(card.end, 1);
  });

  it("3 — late word (video 637's sentence): the card starts on 2008, not at the sentence's start", () => {
    const { card, spoken2008, drawnStart, drawnEnd, beatEnd } = yearPlan(LATE);
    /** The planned window is too short for the existing rule: the word falls after end − 1.5 s. */
    expect(spoken2008.startSec).toBeGreaterThan(card.end - 1.5);
    expect(drawnStart).toBeCloseTo(spoken2008.startSec, 1);
    expect(drawnEnd).toBeLessThanOrEqual(beatEnd + 1e-6);
    expect(drawnEnd - drawnStart).toBeGreaterThanOrEqual(1.5 - 1e-6);
  });

  it("3b — its typing sound starts with it, not at the sentence's start", () => {
    const { timeline, card, drawnStart } = yearPlan(LATE);
    const typing = timeline.tracks.flatMap((t) => (t.kind === "SFX" ? t.clips : [])).find((c) => c.id === `sfx_type_${card.id}`);
    expect(typing).toBeDefined();
    expect(typing!.start).toBeGreaterThanOrEqual(drawnStart);
    expect(typing!.start).toBeLessThan(drawnStart + 0.5);
  });

  it("4 — an anchor word the voice never says: no crash, the planned window", () => {
    const { card, drawnStart, drawnEnd } = yearPlan(LATE, { anchor: "1999" });
    expect(drawnStart).toBeCloseTo(card.start, 1);
    expect(drawnEnd).toBeCloseTo(card.end, 1);
  });

  it("5 — moving the card never turns the subtitles on; switched on they are drawn as before", () => {
    expect(yearPlan(LATE).props.captions).toEqual([]);
    const on = yearPlan(LATE, { showSubtitles: true });
    expect(on.props.captions.length).toBe(captionTrack(on.timeline).length);
  });
});
