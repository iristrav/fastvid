/**
 * GRAPHICS INTELLIGENCE FIX — the proven problems of the graphics audit on 39165cb.
 *
 *   1  a sentence with no picture can have a graphic AS its picture (data graphic or map);
 *   2  the sentence's MediaForm decides which kind may stand in;
 *   3  a figure the sentence says is shown without the scene's statCallout;
 *   4  map keywords match whole words only ("Duke" is not the UK);
 *   5  an extracted entity is checked before a card carries it ("Tesla" is no person,
 *      "trillion dollars" is no event, "Soviet" is no place);
 *   6  the graphics that already worked still do.
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildCinematicSceneInputs,
  intentFrom,
  primaryGraphicForBeat,
  type AdoptionFacts,
  type ProductionBeat,
  type SceneFacts,
} from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import {
  CHAPTER_CARD_FALLBACK,
  chapterCardFallbackFor,
  namesAMappablePlace,
  parseNumericStat,
  planMotionGraphics,
  plausibleEventName,
  plausiblePersonName,
  plausiblePlace,
  primaryGraphicFor,
  spokenStat,
} from "./cinematicEditingEngine/motionGraphicsPlanner";
import { mediaFormsForIntent } from "./beatVisualIntent";
import { finalTimelineFootageRefusal } from "./deliveryGate";
import { isGraphicBackdrop } from "./edlToTimeline";
import { graphicIsRenderable } from "./graphicsVocabulary";
import {
  beatNamedEntitiesByKind,
  extractActionCue,
  extractPersonNamesFromText,
  extractVisualPlacePhrase,
} from "./videoPipeline";
import type { Scene } from "./pipeline/types";
import type { ProjectTimeline, TimelineGraphic, TimelineVideoClip } from "./projectTimeline";

/* ═══════════════════════ fixtures — the production extractors, as production injects them ═══════════════════════ */

const EXTRACTORS = {
  people: (t: string) => extractPersonNamesFromText(t),
  place: (t: string) => extractVisualPlacePhrase(t),
  action: (t: string) => extractActionCue(t),
  namedEntities: (t: string) => beatNamedEntitiesByKind(t),
};

const beat = (index: number, text: string): ProductionBeat => ({
  index,
  text,
  searchQuery: "",
  powerWord: "",
  keywords: [],
  holdSec: 4,
  visualDescription: "",
  voiceStartSec: index * 4,
  voiceEndSec: index * 4 + 4,
});

const scene = (index: number, texts: string[], extra: Partial<Scene> = {}): Scene => ({
  index,
  text: texts.join(" "),
  visualCue: "",
  pexelsQuery: "",
  aiImagePrompt: "",
  duration: texts.length * 4,
  ...extra,
});

const adoption = (i: number): AdoptionFacts => ({
  provider: "internet_archive",
  providerAssetId: `ia-${i}`,
  sourceUrl: `https://archive.invalid/${i}.mp4`,
  assetTitle: "archive shot",
  query: "archive shot",
});

/** A scene whose beats have a picture where `pictured[i]` is true, and none where it is false. */
function sceneFacts(texts: string[], pictured: boolean[], extra: Partial<Scene> = {}): SceneFacts {
  const beats = texts.map((t, i) => beat(i, t));
  return {
    scene: scene(0, texts, extra),
    beats,
    clips: beats.map((_, i) =>
      pictured[i]
        ? {
            facts: { localPath: `/tmp/gfx-s0b${i}.mp4`, durationSec: 10, widthPx: 1920, heightPx: 1080 },
            adoption: adoption(i),
          }
        : null
    ) as SceneFacts["clips"],
  };
}

function route(texts: string[], pictured: boolean[], extra: Partial<Scene> = {}) {
  const built = buildCinematicSceneInputs({ scenes: [sceneFacts(texts, pictured, extra)], extractors: EXTRACTORS });
  const result = runCinematicPipeline({
    videoId: 1,
    scenes: built.scenes,
    ...(built.primaryGraphics?.length ? { primaryGraphics: built.primaryGraphics } : {}),
  });
  return { built, timeline: result.timeline as ProjectTimeline };
}

const videoClips = (t: ProjectTimeline): TimelineVideoClip[] => {
  const track = t.tracks.find((k) => k.kind === "VIDEO");
  return track && track.kind === "VIDEO" ? track.clips : [];
};
const graphicsOf = (t: ProjectTimeline): TimelineGraphic[] => {
  const track = t.tracks.find((k) => k.kind === "GRAPHICS");
  return track && track.kind === "GRAPHICS" ? track.graphics : [];
};

const plan = (text: string, statCallout = "") =>
  planMotionGraphics(
    intentFrom(beat(0, text), 0, 0, null, EXTRACTORS),
    scene(0, [text], { statCallout }),
    0,
    4
  );

/* ═══════════════════════ 1 — a graphic as a sentence's picture ═══════════════════════ */

describe("1 — a sentence with no picture gets a graphic as its picture", () => {
  const TEXTS = [
    "The economy grew slowly through the decade.",
    "Inflation reached 10% in 2022.",
    "Families felt it in every shop.",
  ];

  it("the sentence without a clip gets its data graphic over its whole window, on a dark ground", () => {
    const { built, timeline } = route(TEXTS, [true, false, true]);
    expect(built.primaryGraphics?.map((p) => [p.beatId, p.graphic.graphicType])).toEqual([["s0b1", "progress_bar"]]);

    const ground = videoClips(timeline).find(isGraphicBackdrop);
    expect(ground, "no dark ground on the VIDEO track").toBeDefined();
    expect(ground!.transform?.opacity).toBe(0);
    expect(ground!.timelineStart).toBeCloseTo(4, 3);
    expect(ground!.timelineEnd).toBeCloseTo(8, 3);
    expect(ground!.beatIndex).toBe(1);

    const picture = graphicsOf(timeline).find((g) => g.start === ground!.timelineStart && g.graphicType === "progress");
    expect(picture, "the graphic is not over the sentence's window").toBeDefined();
    expect(picture!.end).toBeCloseTo(8, 3);
    expect(graphicIsRenderable(picture!.graphicType, picture!.data, picture!.label ?? null)).toBe(true);
  });

  it("the VIDEO track stays continuous and no other sentence's shot is held over the hole", () => {
    const { timeline } = route(TEXTS, [true, false, true]);
    const clips = videoClips(timeline).filter((c) => !c.disabled);
    for (let i = 1; i < clips.length; i++) expect(clips[i]!.timelineStart).toBeCloseTo(clips[i - 1]!.timelineEnd, 3);
    const visibleOverHole = clips.filter((c) => c.timelineStart < 7.9 && c.timelineEnd > 4.1 && !isGraphicBackdrop(c));
    expect(visibleOverHole).toEqual([]);
  });

  it("the dark ground is never lent to another sentence as a filler", () => {
    const { timeline } = route([...TEXTS, "Nobody saw it coming."], [true, false, true, false]);
    const grounds = videoClips(timeline).filter(isGraphicBackdrop);
    expect(grounds.every((g) => !/_fill\d+$/.test(g.id))).toBe(true);
    expect(videoClips(timeline).filter((c) => /_graphic\d+_fill\d+$/.test(c.id))).toEqual([]);
  });

  it("a dark ground is no footage on screen for the DeliveryGate", () => {
    const shown = (id: string, start: number, end: number, opacity?: number) => ({
      id, timelineStart: start, timelineEnd: end,
      source: { provider: "internet_archive", providerAssetId: "same" },
      ...(opacity != null ? { transform: { opacity } } : {}),
    });
    const other = (id: string, start: number, end: number) => ({
      id, timelineStart: start, timelineEnd: end, source: { provider: "internet_archive", providerAssetId: id },
    });
    /** 6 s visible of one source out of 12 s is exactly the limit; its dark ground adds nothing. */
    expect(finalTimelineFootageRefusal([shown("a", 0, 4), shown("a_graphic1", 4, 10, 0), other("b", 10, 12), other("c", 12, 16)])).toBeNull();
    expect(finalTimelineFootageRefusal([shown("a", 0, 4), shown("a2", 4, 10), other("b", 10, 12), other("c", 12, 16)])).not.toBeNull();
  });
});

/* ═══════════════════════ 2 — footage wins; MediaForm decides the kind ═══════════════════════ */

describe("2 — good footage wins, and the MediaForm decides which graphic may stand in", () => {
  it("a sentence WITH a clip keeps its clip; no graphic replaces it", () => {
    const { built, timeline } = route(["Inflation reached 10% in 2022.", "Families felt it in every shop."], [true, true]);
    expect(built.primaryGraphics ?? []).toEqual([]);
    expect(videoClips(timeline).filter(isGraphicBackdrop)).toEqual([]);
  });

  it("no data and no map: no graphic, the old hold stands", () => {
    const { built, timeline } = route(["The war began.", "Nobody saw it coming.", "It ended."], [true, false, true]);
    expect(built.primaryGraphics ?? []).toEqual([]);
    expect(videoClips(timeline).filter(isGraphicBackdrop)).toEqual([]);
  });

  it("a mappable place makes MAP the form, and the real map stands in", () => {
    /** MAP FIX — a place where something happens ("in Berlin"), not the sentence's subject. */
    const intent = intentFrom(beat(0, "The treaty was signed in Berlin."), 0, 0, null, EXTRACTORS);
    const g = primaryGraphicForBeat(intent, undefined, 0, 4);
    expect(g?.graphicType).toBe("map");
    expect(typeof g?.data.lon).toBe("number");
  });

  it("a form with no drawable graphic here gets none (PROCESS, DOCUMENT)", () => {
    const intent = intentFrom(beat(0, "Inflation reached 10% in 2022."), 0, 0, null, EXTRACTORS);
    expect(primaryGraphicFor(intent, undefined, ["PROCESS", "DOCUMENT", "PERSON"], 0, 4)).toBeNull();
    expect(primaryGraphicFor(intent, undefined, ["DATA_VISUALIZATION"], 0, 4)?.graphicType).toBe("progress_bar");
    expect(primaryGraphicFor(intent, undefined, ["GRAPHIC"], 0, 4)?.graphicType).toBe("progress_bar");
  });

  it("MediaForm: a quantity prefers DATA_VISUALIZATION, a mappable place prefers MAP — footage stays acceptable", () => {
    const data = mediaFormsForIntent({ event: ["inflation"] }, true, false);
    expect(data.preferred[0]).toBe("DATA_VISUALIZATION");
    const map = mediaFormsForIntent({ location: ["Berlin"] }, false, true);
    expect(map.preferred).toContain("MAP");
    expect(map.acceptable).toEqual(expect.arrayContaining(["REAL_FOOTAGE", "PHOTO", "B_ROLL"]));
    expect(mediaFormsForIntent({ location: ["Qatar"] }, false, false).preferred).not.toContain("MAP");
  });

  it("a window too short to read gets no graphic", () => {
    const intent = intentFrom(beat(0, "Inflation reached 10% in 2022."), 0, 0, null, EXTRACTORS);
    expect(primaryGraphicForBeat(intent, undefined, 0, 0.6)).toBeNull();
  });
});

/* ═══════════════════════ 3 — the sentence's own figure ═══════════════════════ */

describe("3 — a figure the sentence says needs no statCallout", () => {
  it("'Inflation reached 10% in 2022.' → a 10% ring without a statCallout", () => {
    const g = plan("Inflation reached 10% in 2022.").find((x) => x.graphicType === "progress_bar");
    expect(g?.data).toMatchObject({ toValue: 10, suffix: "%", label: "10%", anchorWord: "10" });
  });

  it("'70 million people died.' → a counter to 70 million", () => {
    const g = plan("By the end, 70 million people died.").find((x) => x.graphicType === "statistic_counter");
    expect(g?.data).toMatchObject({ toValue: 70, suffix: "million", label: "70 million", anchorWord: "70" });
  });

  it("'Sales reached 2.4 billion dollars.' → 2.4 billion, one decimal", () => {
    const g = plan("Sales reached 2.4 billion dollars.").find((x) => x.graphicType === "statistic_counter");
    expect(g?.data).toMatchObject({ toValue: 2.4, suffix: "billion", decimals: 1, anchorWord: "2.4" });
  });

  it("a statCallout still works, and is not doubled by the sentence's own figure", () => {
    const g = plan("Inflation reached 10% in 2022.", "10%");
    expect(g.filter((x) => x.graphicType === "progress_bar")).toHaveLength(1);
  });

  it("a series gets the existing line chart, with only the sentence's own points", () => {
    const g = plan("Sales rose from 1.2 billion in 2015 to 2.4 billion in 2019 and 3.1 billion in 2023.");
    const chart = g.find((x) => x.graphicType === "line_chart");
    expect(chart?.data.series).toEqual([
      { label: "2015", value: 1.2 },
      { label: "2019", value: 2.4 },
      { label: "2023", value: 3.1 },
    ]);
    expect(g.find((x) => x.graphicType === "statistic_counter")).toBeUndefined();
  });

  it("no invented data: a year, a bare number or a unit glued to a word is not a figure", () => {
    expect(spokenStat("In 1945 Berlin fell.")).toBeNull();
    expect(parseNumericStat("1945 Berlin")?.suffix).toBe("");
    expect(spokenStat("He had 3 brothers.")).toBeNull();
    expect(plan("In 1945 Berlin fell.").some((x) => x.graphicType === "statistic_counter" || x.graphicType === "progress_bar")).toBe(false);
    /** Every number on any planned graphic is a number the sentence says. */
    const text = "Unemployment hit 25 percent in 1933.";
    const said = (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    for (const g of plan(text)) {
      for (const v of [g.data.toValue, g.data.value].filter((n): n is number => typeof n === "number")) {
        expect(said).toContain(v);
      }
    }
    expect(plan(text).find((x) => x.graphicType === "progress_bar")?.data.label).toBe("25%");
  });
});

/* ═══════════════════════ 4 — whole-word map matching ═══════════════════════ */

describe("4 — a map keyword is a whole word", () => {
  it("'The Duke of Wellington defeated Napoleon at Waterloo' is NOT London, UK", () => {
    const g = plan("The Duke of Wellington defeated Napoleon at Waterloo.");
    expect(g.find((x) => x.graphicType === "map")).toBeUndefined();
    expect(namesAMappablePlace("The Duke of Wellington defeated Napoleon at Waterloo.")).toBe(false);
  });

  it("no fragment of another word: magazine, causal, piranha", () => {
    for (const t of ["The magazine sold millions.", "A causal link was found.", "A piranha bit him."]) {
      expect(namesAMappablePlace(t), t).toBe(false);
    }
  });

  it("real places still match, as words: the UK, Berlin, Washington D.C.", () => {
    expect(namesAMappablePlace("Prices rose across the UK.")).toBe(true);
    expect(plan("Soviet troops captured Berlin in 1945.").find((x) => x.graphicType === "map")?.data.locationName).toBe("Berlin, Germany");
    expect(namesAMappablePlace("The treaty was signed in Washington D.C. that year.")).toBe(true);
  });
});

/* ═══════════════════════ 5 — an extracted entity is checked ═══════════════════════ */

describe("5 — no card for an entity the extractor is unsure about", () => {
  it("Tesla is no person and 'trillion dollars' is no event", () => {
    const text = "Tesla's market value soared past one trillion dollars in 2021.";
    const intent = intentFrom(beat(0, text), 0, 0, null, EXTRACTORS);
    expect(intent.people).not.toContain("Tesla");
    expect(intent.events).toEqual([]);
    const g = plan(text);
    expect(g.find((x) => x.graphicType === "lower_third")).toBeUndefined();
    expect(g.find((x) => x.graphicType === "timeline")).toBeUndefined();
  });

  it("'Soviet' is no place; 'Macworld' is no place; 'San Francisco' is no person", () => {
    expect(intentFrom(beat(0, "Soviet troops captured Berlin in 1945."), 0, 0, null, EXTRACTORS).visualLocation).not.toBe("Soviet");
    const jobs = intentFrom(beat(0, "In 2007, Steve Jobs unveiled the first iPhone at Macworld in San Francisco."), 0, 0, null, EXTRACTORS);
    expect(jobs.visualLocation).not.toBe("Macworld");
    expect(jobs.people).toEqual(["Steve Jobs"]);
  });

  it("the guards themselves", () => {
    expect(plausiblePersonName("Tesla", "Tesla grew.")).toBe(false);
    expect(plausiblePersonName("Lehman Brothers", "Lehman Brothers collapsed.", ["Lehman Brothers"])).toBe(false);
    expect(plausiblePersonName("San Francisco", "He spoke in San Francisco.")).toBe(false);
    expect(plausiblePersonName("Lionel Messi", "Lionel Messi lifted the trophy.")).toBe(true);
    expect(plausiblePlace("Qatar", "He lifted the cup in Qatar.")).toBe(true);
    expect(plausiblePlace("Berlin", "The Battle of Berlin began.")).toBe(true);
    expect(plausiblePlace("Wellington", "The Duke of Wellington won.")).toBe(false);
    expect(plausiblePlace("Macworld", "He spoke at Macworld.", ["Macworld"])).toBe(false);
    expect(plausibleEventName("Battle of Berlin")).toBe(true);
    expect(plausibleEventName("Marshall Plan")).toBe(true);
    expect(plausibleEventName("trillion dollars")).toBe(false);
    expect(plausibleEventName("border ran")).toBe(false);
  });
});

/* ═══════════════════════ 6 — the graphics that worked still work ═══════════════════════ */

describe("6 — the existing graphics still plan", () => {
  it("lower third, date card, location card, map, timeline event, quote", () => {
    const sport = plan("In December 2022, Lionel Messi lifted the World Cup in Qatar.").map((g) => g.graphicType);
    expect(sport).toEqual(expect.arrayContaining(["lower_third", "date_card", "location_card"]));
    expect(plan("In April 1945 the Battle of Berlin reached the city centre.").map((g) => g.graphicType)).toEqual(
      expect.arrayContaining(["map"])
    );
    const quote = plan('He said: "We shall fight on the beaches, we shall never surrender."').map((g) => g.graphicType);
    expect(quote).toContain("quote");
  });

  it("a statCallout counter still counts", () => {
    const g = plan("By 1945, more than 70 million people had died in the war.", "70 million");
    expect(g.find((x) => x.graphicType === "statistic_counter")?.data.toValue).toBe(70);
  });
});

/* ═══════════════════════ 7 — CHAPTER_CARD_FALLBACK ═══════════════════════ */

describe("7 — CHAPTER_CARD_FALLBACK: Remotion draws the sentence's subject when no source had a picture", () => {
  const SENTENCES = [
    "The economy grew slowly through the decade.",
    "Scientists cut a single gene inside a living cell.",
    "Families felt it in every shop.",
  ];
  /** The VisualIntent subject reaches the beat as its power word (hydrateBeatScriptVisuals). */
  const withSubject = (subject: string, pictured: boolean[]): SceneFacts => {
    const facts = sceneFacts(SENTENCES, pictured);
    facts.beats[1] = { ...facts.beats[1]!, powerWord: subject, searchQuery: subject };
    return facts;
  };
  const build = (facts: SceneFacts) => buildCinematicSceneInputs({ scenes: [facts], extractors: EXTRACTORS });

  it("no picture from any source → a drawn card of the VisualIntent subject, as the sentence's picture", () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    let built: ReturnType<typeof build>;
    try {
      built = build(withSubject("CRISPR gene editing laboratory", [true, false, true]));
    } finally {
      spy.mockRestore();
    }
    const slot = built!.primaryGraphics?.find((p) => p.beatId === "s0b1");
    expect(slot?.graphic.graphicType).toBe("chapter_card");
    expect(slot?.graphic.data.title).toBe("Crispr Gene Editing Laboratory");
    expect(slot?.graphic.reason.startsWith(CHAPTER_CARD_FALLBACK)).toBe(true);
    expect(logs.some((l) => l.startsWith(`[${CHAPTER_CARD_FALLBACK}] s`))).toBe(true);

    /** And it is an ordinary visual in the timeline: the drawn card over the sentence's window, centred. */
    const { timeline } = (() => {
      const r = runCinematicPipeline({ videoId: 1, scenes: built!.scenes, primaryGraphics: built!.primaryGraphics });
      return { timeline: r.timeline as ProjectTimeline };
    })();
    const card = graphicsOf(timeline).find((g) => g.graphicType === "chapter_card");
    expect(card?.start).toBeCloseTo(4, 3);
    expect(card?.end).toBeCloseTo(8, 3);
    expect(card?.style?.position).toBe("center");
    expect(graphicIsRenderable(card!.graphicType, card!.data, card!.label ?? null)).toBe(true);
    expect(videoClips(timeline).find(isGraphicBackdrop)?.transform?.opacity).toBe(0);
  });

  it("a good existing picture → no generation", () => {
    const built = build(withSubject("CRISPR gene editing laboratory", [true, true, true]));
    expect(built.primaryGraphics ?? []).toEqual([]);
  });

  it("real data or a real map still come before a drawn card", () => {
    const intent = intentFrom(beat(0, "Inflation reached 10% in 2022."), 0, 0, null, EXTRACTORS);
    expect(primaryGraphicForBeat({ ...intent, visualSubject: "inflation prices" }, undefined, 0, 4)?.graphicType).toBe("progress_bar");
  });

  it("the card matches the VisualIntent and the sentence — never a subject the voice does not say", () => {
    const intent = (subject: string) => ({
      ...intentFrom(beat(0, "Scientists cut a single gene inside a living cell."), 0, 0, null, EXTRACTORS),
      visualSubject: subject,
    });
    expect(chapterCardFallbackFor(intent("gene editing laboratory"), 0, 4)?.data.title).toBe("Gene Editing Laboratory");
    /** Unrelated to the sentence: no card. */
    expect(chapterCardFallbackFor(intent("rocket launch pad"), 0, 4)).toBeNull();
    /** Only production words: no card. */
    expect(chapterCardFallbackFor(intent("documentary broll scene"), 0, 4)).toBeNull();
    expect(chapterCardFallbackFor(intent(""), 0, 4)).toBeNull();
  });

  it("a named event or person leads, and a stated year is added", () => {
    const marshall = {
      ...intentFrom(beat(0, "In 1948 the Marshall Plan began to rebuild Europe."), 0, 0, null, EXTRACTORS),
      events: ["Marshall Plan"],
    };
    expect(chapterCardFallbackFor(marshall, 0, 4)?.data.title).toBe("Marshall Plan · 1948");
    const messi = intentFrom(beat(0, "Lionel Messi wept on the pitch."), 0, 0, null, EXTRACTORS);
    expect(chapterCardFallbackFor(messi, 0, 4)?.data.title).toBe("Lionel Messi");
  });
});
