/**
 * OCTOBER 2026 — the planner hands the graphics the script's own data, on the word that says it;
 * captions sit on a plate as wide as their text. The pixels are proven by
 * realMapChartCounterReachTheMp4.test.ts; this proves the data and the arithmetic.
 */
import { describe, expect, it } from "vitest";

import { parseNumericStat, planMotionGraphics, yearSeriesFromText } from "./cinematicEditingEngine/motionGraphicsPlanner";
import { WORLD_LOCATIONS } from "./cinematicMotion/locationMap";
import { graphicIsRenderable, readDecimals, readGeoPoint } from "./graphicsVocabulary";
import { MIN_GRAPHIC_ON_WORD_SEC, graphicStartOnWord, graphicWindowOnWord } from "./remotionProps";
import { lineCountFor, maxCharsPerLine, wrapWordsBalanced } from "./captionLayout";
import { DEFAULT_CAPTION_STYLE } from "./projectTimeline";
import { plateColour } from "./remotion/components/Text";
import { formatValue, niceTicks } from "./remotion/components/Charts";
import { cameraAt, cameraFor, naturalEarth, toScreen } from "./remotion/components/GeoMap";

const intent = (spokenText: string, extra: Record<string, unknown> = {}) =>
  ({
    spokenText,
    visualLocation: "",
    visualTime: "",
    visualSubject: "",
    visualAction: "",
    events: [],
    historicalContext: "",
    objects: [],
    brands: [],
    companies: [],
    people: [],
    ...extra,
  }) as never;

describe("numbers as the script wrote them", () => {
  it("decimals, currency and unit survive — 3.5 billion is never 4", () => {
    expect(parseNumericStat("$3.5 billion")).toMatchObject({ value: 3.5, decimals: 1, prefix: "$", suffix: "billion", token: "3.5" });
    expect(parseNumericStat("40%")).toMatchObject({ value: 40, decimals: 0, suffix: "%" });
    expect(parseNumericStat("1,200,000 viewers")).toMatchObject({ value: 1_200_000, decimals: 0 });
  });

  it("a counter keeps the number's decimals", () => {
    expect(readDecimals({}, 3.5)).toBe(1);
    expect(readDecimals({}, 12)).toBe(0);
    expect(readDecimals({ decimals: 2 }, 3.5)).toBe(2);
  });

  it("the stat callout becomes a counter that counts to the written value, on its word", () => {
    const out = planMotionGraphics(intent("The company was worth $3.5 billion."), { statCallout: "$3.5 billion" } as never, 10, 4);
    const counter = out.find((g) => g.graphicType === "statistic_counter")!;
    expect(counter.data).toMatchObject({ toValue: 3.5, decimals: 1, prefix: "$", suffix: "billion", anchorWord: "3.5" });
  });
});

describe("a chart only from values the narration states", () => {
  it("years with values in one unit become a series", () => {
    const s = yearSeriesFromText("Sales reached 1.2 billion in 2015, 2.4 billion in 2019 and 3.1 billion in 2023.");
    expect(s?.series).toEqual([
      { label: "2015", value: 1.2 },
      { label: "2019", value: 2.4 },
      { label: "2023", value: 3.1 },
    ]);
    expect(s).toMatchObject({ unit: "billion", decimals: 1, firstToken: "1.2" });
  });

  it("'in 2007 … 3 million' order is read too", () => {
    const s = yearSeriesFromText("In 2007, the show drew 3 million viewers; in 2012, it drew 5 million viewers.");
    expect(s?.series.map((p) => p.value)).toEqual([3, 5]);
  });

  it("two different units are not one series, and one point is not a chart", () => {
    expect(yearSeriesFromText("From 3 million in 2007 to 8 billion in 2023.")).toBeNull();
    expect(yearSeriesFromText("It earned 4 million in 2010.")).toBeNull();
    expect(yearSeriesFromText("Nothing was counted.")).toBeNull();
  });

  it("the planner draws it as a line_chart the renderer can draw", () => {
    const out = planMotionGraphics(intent("Revenue grew from 1.2 billion in 2015 to 3.1 billion in 2023."), undefined, 0, 6);
    const chart = out.find((g) => g.graphicType === "line_chart")!;
    expect(chart).toBeDefined();
    expect(graphicIsRenderable("line_chart", chart.data, null)).toBe(true);
    expect(out.some((g) => g.graphicType === "chart")).toBe(false);
  });

  it("a trend word without numbers still gets no drawn chart (no data is invented)", () => {
    const out = planMotionGraphics(intent("Sales showed steady growth."), undefined, 0, 4);
    expect(out.some((g) => g.graphicType === "line_chart")).toBe(false);
  });
});

describe("the real map", () => {
  it("every known place carries real degrees and its country", () => {
    for (const loc of WORLD_LOCATIONS) {
      expect(loc.lon, loc.name).toBeGreaterThanOrEqual(-180);
      expect(loc.lon, loc.name).toBeLessThanOrEqual(180);
      expect(loc.lat, loc.name).toBeGreaterThanOrEqual(-90);
      expect(loc.lat, loc.name).toBeLessThanOrEqual(90);
      expect(loc.iso3, loc.name).toMatch(/^[A-Z]{3}$/);
    }
    const berlin = WORLD_LOCATIONS.find((l) => l.name.startsWith("Berlin"))!;
    expect(berlin.lat).toBeCloseTo(52.5, 0);
  });

  it("the planner's map payload is a real place, on the word that names it", () => {
    const out = planMotionGraphics(intent("They moved the company to Berlin."), undefined, 0, 4);
    const map = out.find((g) => g.graphicType === "map")!;
    expect(map.data).toMatchObject({ lon: 13.4, lat: 52.52, iso3: "DEU", anchorWord: "berlin" });
    expect(graphicIsRenderable("map_point", map.data, null)).toBe(true);
  });

  it("a payload with only normX/normY still draws — on the abstract map, as before", () => {
    expect(readGeoPoint({ normX: 0.5, normY: 0.3 })).toBeNull();
    expect(graphicIsRenderable("map_point", { normX: 0.5, normY: 0.3 }, null)).toBe(true);
    expect(graphicIsRenderable("map_point", { lon: 500, lat: 0 }, null)).toBe(false);
  });

  it("the projection is Natural Earth: the equator is wider than the 60th parallel; north is up", () => {
    const [eq] = naturalEarth(180, 0);
    const [n60] = naturalEarth(180, 60);
    expect(eq).toBeGreaterThan(n60);
    expect(toScreen(0, 60)[1]).toBeLessThan(toScreen(0, 0)[1]);
  });

  it("the camera starts on the world and ends zoomed in on the place", () => {
    const target = cameraFor([toScreen(13.4, 52.52)]);
    expect(target.zoom).toBeGreaterThan(2);
    expect(cameraAt(target, 0).zoom).toBe(1);
    expect(cameraAt(target, 1)).toEqual(target);
    expect(cameraAt(target, 0.5).zoom).toBeCloseTo(Math.sqrt(target.zoom), 5);
  });
});

describe("a graphic appears on its word", () => {
  const words = [
    { word: "It", startSec: 10.0, endSec: 10.2 },
    { word: "was", startSec: 10.2, endSec: 10.4 },
    { word: "worth", startSec: 10.4, endSec: 10.8 },
    { word: "$3.5", startSec: 10.8, endSec: 11.3 },
    { word: "billion.", startSec: 11.3, endSec: 11.8 },
  ];

  it("moves to the measured start of the word", () => {
    expect(graphicStartOnWord(10, 14, "3.5", words)).toBe(10.8);
  });

  it("never earlier than planned, never so late that it cannot be read", () => {
    expect(graphicStartOnWord(10, 11.9, "billion", words)).toBe(10);
    expect(graphicStartOnWord(10, 10 + MIN_GRAPHIC_ON_WORD_SEC + 2, "billion", words)).toBe(11.3);
  });

  it("no word, no timing, no match: the planned start", () => {
    expect(graphicStartOnWord(10, 14, undefined, words)).toBe(10);
    expect(graphicStartOnWord(10, 14, "Berlin", words)).toBe(10);
    expect(graphicStartOnWord(10, 14, "3.5", [])).toBe(10);
  });
});

/** VIDEO 637 — a word said after the card's first part moves the whole card, inside its sentence. */
describe("a graphic whose word is said late in its sentence", () => {
  const words = [
    { word: "Tesla", startSec: 4.0, endSec: 4.3 },
    { word: "teetered", startSec: 4.35, endSec: 4.65 },
    { word: "during", startSec: 5.4, endSec: 5.7 },
    { word: "the", startSec: 5.75, endSec: 6.05 },
    { word: "2008", startSec: 6.1, endSec: 6.4 },
    { word: "crisis.", startSec: 6.8, endSec: 7.1 },
  ];

  it("early word: exactly the existing rule, end unchanged", () => {
    expect(graphicWindowOnWord(4, 7, "teetered", words, 8)).toEqual({ startSec: 4.35, endSec: 7 });
  });

  it("late word: starts on the word, keeps its length, cut at the sentence's end", () => {
    expect(graphicWindowOnWord(4, 7, "2008", words, 8)).toEqual({ startSec: 6.1, endSec: 8 });
    expect(graphicWindowOnWord(4, 7, "2008", words, 12)).toEqual({ startSec: 6.1, endSec: 9.1 });
  });

  it("never so close to the sentence's end that it cannot be read: the planned window", () => {
    expect(graphicWindowOnWord(4, 7, "crisis", words, 6.8 + MIN_GRAPHIC_ON_WORD_SEC - 0.1)).toEqual({ startSec: 4, endSec: 7 });
  });

  it("no sentence end, no word, no timing, no match: the existing answer", () => {
    expect(graphicWindowOnWord(4, 7, "2008", words, null)).toEqual({ startSec: 4, endSec: 7 });
    expect(graphicWindowOnWord(4, 7, undefined, words, 8)).toEqual({ startSec: 4, endSec: 7 });
    expect(graphicWindowOnWord(4, 7, "2008", [], 8)).toEqual({ startSec: 4, endSec: 7 });
    expect(graphicWindowOnWord(4, 7, "1999", words, 8)).toEqual({ startSec: 4, endSec: 7 });
  });
});

describe("captions on a plate as wide as their text", () => {
  const frame = { widthPx: 1280, heightPx: 720 };
  const text = "In 2007 a small reality show turned one family into a business worth billions of dollars.";

  it("the drawn lines are as many as the measured ones", () => {
    const max = maxCharsPerLine(DEFAULT_CAPTION_STYLE, frame);
    const lines = wrapWordsBalanced(text.split(" "), max);
    expect(lines.length).toBe(lineCountFor(text, DEFAULT_CAPTION_STYLE, frame));
  });

  it("balanced: no lone last word, no line longer than the budget", () => {
    const words = "Kris Jenner turned a reality show into an empire".split(" ");
    const lines = wrapWordsBalanced(words, 30);
    const lengths = lines.map((l) => l.map((i) => words[i]!).join(" ").length);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(30);
    expect(Math.min(...lengths)).toBeGreaterThan(8);
    expect(lines.flat()).toEqual(words.map((_, i) => i));
  });

  it("the plate keeps the style's opacity whatever colour it names", () => {
    expect(plateColour("black", 0.45)).toBe("rgba(0,0,0,0.450)");
    expect(plateColour("#ffffff", 0.2)).toBe("rgba(255,255,255,0.200)");
    expect(plateColour(undefined, 0.5)).toBe("rgba(0,0,0,0.500)");
    expect(plateColour("rgba(10,10,10,0.3)", 0.9)).toBe("rgba(10,10,10,0.3)");
  });
});

describe("a chart's axis reads", () => {
  it("round steps covering the values", () => {
    expect(niceTicks(0, 8)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(0, 1.8)).toEqual([0, 0.5, 1, 1.5, 2]);
    const t = niceTicks(2.5, 8.0);
    expect(t[0]).toBeLessThanOrEqual(2.5);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(8);
  });

  it("values print with their decimals and unit", () => {
    expect(formatValue(3.5, 1, "$", " billion")).toBe("$3.5 billion");
    expect(formatValue(1200000, 0)).toBe("1,200,000");
  });
});

describe("the real map reaches the film (onScreenTextDirector rule 2)", () => {
  it("a map with real degrees stays on; only a coordinate-less one becomes a location card", async () => {
    const { directOnScreenText } = await import("./onScreenTextDirector");
    const { emptyTimeline } = await import("./projectTimeline");
    const t = emptyTimeline(1, { widthPx: 1920, heightPx: 1080, fps: 30 });
    t.durationSec = 10;
    const g = t.tracks.find((x) => x.kind === "GRAPHICS") as { graphics: Array<Record<string, unknown>> };
    g.graphics.push(
      { id: "real", graphicType: "map_point", start: 0, end: 4, label: "Berlin", data: { locationName: "Berlin", lon: 13.4, lat: 52.52, iso3: "DEU" } },
      { id: "flat", graphicType: "map_point", start: 5, end: 9, label: "Paris", data: { locationName: "Paris", normX: 0.5, normY: 0.27 } }
    );
    const out = directOnScreenText(t as never);
    const byId = new Map(g.graphics.map((x) => [x.id, x]));
    expect(byId.get("real")!.disabled).toBeFalsy();
    expect(byId.get("flat")!.disabled).toBe(true);
    expect(out.converted).toEqual(["flat map_point → location_card (Paris)"]);
  });
});

describe("OCTOBER 2026 (showcase render) — what the real render showed", () => {
  it("a real map is the place's card: a loose 'Berlin' text no longer switches it off", async () => {
    const { directOnScreenText } = await import("./onScreenTextDirector");
    const { emptyTimeline } = await import("./projectTimeline");
    const t = emptyTimeline(2, { widthPx: 1920, heightPx: 1080, fps: 30 });
    t.durationSec = 6;
    const g = t.tracks.find((x) => x.kind === "GRAPHICS") as { graphics: Array<Record<string, unknown>> };
    const tx = t.tracks.find((x) => x.kind === "TEXT") as { texts: Array<Record<string, unknown>> };
    g.graphics.push({ id: "map", graphicType: "map_point", start: 0, end: 4.5, label: "Berlin, Germany", data: { locationName: "Berlin, Germany", lon: 13.4, lat: 52.52, iso3: "DEU" } });
    tx.texts.push({ id: "word", role: "location", text: "Berlin", start: 0, end: 3, style: { fontSizePx: 40, color: "white", backgroundOpacity: 0, position: "bottom" } });
    directOnScreenText(t as never);
    expect(g.graphics[0]!.disabled).toBeFalsy();
    expect(tx.texts[0]!.disabled).toBe(true);
  });

  it("the scene's stat is counted only under the sentence that says it", async () => {
    const { statSpokenInBeat } = await import("./cinematicEditingEngine/motionGraphicsPlanner");
    expect(statSpokenInBeat("140", "At least 140 people were killed at the wall.")).toBe(true);
    expect(statSpokenInBeat("140", "For 28 years, families could not cross.")).toBe(false);
    const scene = { statCallout: "140" } as never;
    expect(planMotionGraphics(intent("For 28 years, families could not cross."), scene, 0, 5).some((x) => x.graphicType === "statistic_counter")).toBe(false);
    expect(planMotionGraphics(intent("At least 140 people were killed at the wall."), scene, 5, 5).some((x) => x.graphicType === "statistic_counter")).toBe(true);
  });

  it("a chart's title is the measure the sentence names, of its subject", async () => {
    const { chartTitle } = await import("./cinematicEditingEngine/motionGraphicsPlanner");
    expect(chartTitle("Its population was 79.8 million in 1990, 82.3 million in 2000.", "germany")).toBe("Population of Germany");
    expect(chartTitle("It earned 3 million in 2010 and 5 million in 2012.", "")).toBe("");
  });
});

describe("OCTOBER 2026 (showcase render) — captions and the line chart", () => {
  it("a word straddling two captions belongs to one of them, not both", async () => {
    const { wordsWithin } = await import("./remotion/GraphicsOverlay");
    const words = [
      { word: "On", startSec: 0.2, endSec: 0.6 },
      { word: "1961,", startSec: 1.1, endSec: 1.7 },
      { word: "East", startSec: 1.7, endSec: 2.1 },
    ];
    const fps = 30;
    const first = wordsWithin(words, 0, Math.round(1.284 * fps), fps).map((w) => w.word);
    const second = wordsWithin(words, Math.round(1.284 * fps), Math.round(3.7 * fps), fps).map((w) => w.word);
    expect([...first, ...second]).toEqual(["On", "1961,", "East"]);
  });

  it("a line chart of a small change is drawn on its own range, a large swing keeps zero", async () => {
    const { lineChartRange, niceTicks } = await import("./remotion/components/Charts");
    expect(lineChartRange([79.8, 82.3, 83.2])).toEqual([79.8, 83.2]);
    expect(niceTicks(...lineChartRange([79.8, 82.3, 83.2]))[0]).toBeGreaterThan(70);
    expect(lineChartRange([2.5, 4.1, 6.1, 8.0])).toEqual([0, 8.0]);
    expect(lineChartRange([-3, 5])).toEqual([-3, 5]);
  });
});
