/**
 * OCTOBER 2026 — at least two motion graphics and two editorial texts per started minute, filled
 * only from the script's own material. See `graphicsCoverage.ts`.
 */
import { describe, expect, it } from "vitest";

import { comparisonSides } from "./cinematicEditingEngine/motionGraphicsPlanner";
import { ensureGraphicsCoverage, requiredPerKind, RE_NAME_AFTER_SEC } from "./graphicsCoverage";
import { emptyTimeline, type ProjectTimeline, type TimelineGraphic, type TimelineText } from "./projectTimeline";
import { graphicEndAfterMove } from "./remotionProps";
import { currentTimelineIndex, kineticWordFrames, readComparison, readTimelineEvents } from "./remotion/components/Editorial";

function film(durationSec: number, graphics: TimelineGraphic[], texts: TimelineText[] = []): ProjectTimeline {
  const t = emptyTimeline(1);
  t.durationSec = durationSec;
  for (const track of t.tracks) {
    if (track.kind === "GRAPHICS") track.graphics.push(...graphics);
    if (track.kind === "TEXT") track.texts.push(...texts);
  }
  return t;
}
const g = (id: string, graphicType: string, start: number, end: number, label: string, extra: Partial<TimelineGraphic> = {}): TimelineGraphic => ({
  id, graphicType, start, end, label, data: {}, ...extra,
});
const word = (id: string, text: string, start: number, end: number, role = "animated_text"): TimelineText => ({
  id, text, start, end, role, disabled: true, disabledReason: "keyword_popup",
  style: { position: "center" } as TimelineText["style"], animation: "fade" as TimelineText["animation"],
});
const graphicsOf = (t: ProjectTimeline) => {
  const track = t.tracks.find((x) => x.kind === "GRAPHICS");
  return track && track.kind === "GRAPHICS" ? track.graphics : [];
};

describe("the minimum per started minute", () => {
  it("is ceil(duration / 60) * 2, for motion and for editorial text alike", () => {
    expect(requiredPerKind(60)).toBe(2);
    expect(requiredPerKind(90)).toBe(4);
    expect(requiredPerKind(121)).toBe(6);
    expect(requiredPerKind(600)).toBe(20);
  });
  it("a film that already has enough is left exactly as it was", () => {
    const t = film(55, [
      g("m1", "map_point", 2, 6, "Berlin"),
      g("c1", "counter", 20, 24, "140"),
      g("l1", "lower_third", 10, 13, "John F. Kennedy"),
      g("d1", "date_card", 30, 33, "1961"),
    ]);
    const c = ensureGraphicsCoverage(t);
    expect(c.added).toEqual([]);
    expect(c.shortfall).toBeNull();
    expect(c.motion).toBe(2);
    expect(c.editorial).toBe(2);
  });
});

describe("filled from the script's own material", () => {
  it("a later year becomes the chronology of the years named so far", () => {
    const t = film(58, [
      g("d1", "date_card", 3, 6, "1961", { data: { text: "1961", typewriter: true } }),
      g("d2", "date_card", 20, 23, "1987", { data: { text: "1987" } }),
      g("d3", "date_card", 40, 43, "1989", { data: { text: "1989" } }),
      g("l1", "lower_third", 10, 13, "Ronald Reagan"),
    ]);
    const c = ensureGraphicsCoverage(t);
    const chrono = c.added.filter((a) => a.kind === "chronology");
    expect(chrono.length).toBe(2);
    const d3 = graphicsOf(t).find((x) => x.id === "d3")!;
    expect(d3.graphicType).toBe("timeline_event");
    expect(readTimelineEvents(d3.data).map((e) => e.year)).toEqual(["1961", "1987", "1989"]);
    expect(currentTimelineIndex(d3.data, 3)).toBe(2);
    /** The first year stays a date card: a chronology needs two years. */
    expect(graphicsOf(t).find((x) => x.id === "d1")!.graphicType).toBe("date_card");
  });
  it("the scene's kinetic words become one phrase, on the times they are spoken", () => {
    const t = film(50, [g("m1", "map_point", 2, 6, "Berlin")], [
      word("w1", "Freedom", 20, 20.5),
      word("w2", "divided", 20.5, 21),
      word("w3", "Berlin", 21, 21.6),
    ]);
    const c = ensureGraphicsCoverage(t);
    const k = graphicsOf(t).find((x) => x.graphicType === "kinetic_type")!;
    expect(k.data.text).toBe("Freedom divided Berlin");
    expect(k.data.wordStarts).toEqual([0, 0.5, 1]);
    expect(k.end - k.start).toBeGreaterThanOrEqual(2.5);
    expect(c.added.map((a) => a.kind)).toContain("kinetic");
  });
  it("a named event the caption planner labelled comes back as editorial text", () => {
    const t = film(50, [g("l1", "lower_third", 2, 5, "Ronald Reagan")], [word("e1", "Cold War summit", 30, 31.5, "callout")]);
    const c = ensureGraphicsCoverage(t);
    expect(c.added.find((a) => a.kind === "event")?.text).toBe("Cold War summit");
  });
  it("a person is named again after more than a minute, never sooner", () => {
    const t = film(150, [
      g("l1", "lower_third", 5, 8, "Ronald Reagan"),
      g("l2", "lower_third", 30, 33, "Ronald Reagan", { disabled: true, disabledReason: "name_already_shown" }),
      g("l3", "lower_third", 5 + RE_NAME_AFTER_SEC + 20, 88, "Ronald Reagan", { disabled: true, disabledReason: "name_already_shown" }),
    ]);
    ensureGraphicsCoverage(t);
    expect(graphicsOf(t).find((x) => x.id === "l2")!.disabled).toBe(true);
    expect(graphicsOf(t).find((x) => x.id === "l3")!.disabled).toBeFalsy();
  });
  it("never beside two other texts, never in the same place", () => {
    const t = film(50, [
      /** The kinetic phrase goes to the lower-third band (safe area); a name already sits there. */
      g("a", "lower_third", 19, 24, "Ronald Reagan"),
    ], [word("w1", "Freedom", 20, 21)]);
    ensureGraphicsCoverage(t);
    expect(graphicsOf(t).some((x) => x.graphicType === "kinetic_type")).toBe(false);
  });
  it("what cannot be filled is reported, not invented", () => {
    const c = ensureGraphicsCoverage(film(130, [g("l1", "lower_third", 5, 8, "Ronald Reagan")]));
    expect(c.shortfall).toMatch(/motion 0\/6/);
    expect(c.shortfall).toMatch(/editorial text 1\/6/);
    expect(c.added).toEqual([]);
  });
  it("fills the thinnest minute first", () => {
    const t = film(110, [
      g("m1", "map_point", 2, 6, "Berlin"),
      g("m2", "counter", 10, 14, "140"),
    ], [word("w1", "Freedom", 15, 16), word("w2", "Unity", 75, 76)]);
    const c = ensureGraphicsCoverage(t);
    expect(c.added[0]!.at).toBe(75);
  });
});

describe("the components' own readings", () => {
  it("a comparison is two short sides, not two half-sentences", () => {
    expect(comparisonSides("In 1960 West Berlin", "East Berlin, the gap grew")).toEqual({ left: "West Berlin", right: "East Berlin" });
    expect(comparisonSides("Coca-Cola", "Pepsi.")).toEqual({ left: "Coca-Cola", right: "Pepsi" });
    expect(comparisonSides("", "Pepsi")).toBeNull();
    expect(readComparison({ leftLabel: "A", rightLabel: "B" })).toEqual({ left: "A", right: "B", connector: "VS" });
  });
  it("kinetic words arrive on their spoken times, or evenly when there are none", () => {
    expect(kineticWordFrames(3, { wordStarts: [0, 0.5, 1] }, 30, 90)).toEqual([0, 15, 30]);
    expect(kineticWordFrames(3, {}, 30, 90)).toEqual([0, 23, 45]);
  });
});

describe("a graphic moved to its word keeps its time on screen", () => {
  it("extended by what it moved, at most 1.5 s, never into the next graphic or past the film", () => {
    expect(graphicEndAfterMove({ id: "a", start: 10, end: 13 }, 11, [], 60)).toBe(14);
    /** Moved to 12.5: 1.5 s more would end at 14.5, but its words need 2.5 s from 12.5. */
    expect(graphicEndAfterMove({ id: "a", start: 10, end: 13 }, 12.5, [], 60)).toBe(15);
    expect(graphicEndAfterMove({ id: "a", start: 10, end: 13 }, 11, [{ id: "b", start: 13.4 }], 60)).toBe(13.4);
    expect(graphicEndAfterMove({ id: "a", start: 10, end: 13 }, 11, [], 13.2)).toBe(13.2);
    expect(graphicEndAfterMove({ id: "a", start: 10, end: 13 }, 10, [], 60)).toBe(13);
  });
  it("never shorter than its words take to read — not a fixed two seconds", async () => {
    const { readingSec } = await import("./graphicsVocabulary");
    expect(readingSec("1961")).toBe(2.5);
    expect(readingSec("West Berlin vs East Berlin")).toBeCloseTo(2.95, 5);
    expect(readingSec("one two three four five six seven eight nine ten eleven twelve thirteen fourteen")).toBe(6);
    /** Unmoved, the overlay keeps the timeline's end exactly; the timeline itself is made readable by the director. */
    expect(graphicEndAfterMove({ id: "a", start: 10, end: 11.5, label: "1961" }, 10, [], 60)).toBe(11.5);
    expect(graphicEndAfterMove({ id: "a", start: 10, end: 11.5, label: "1961" }, 10.5, [{ id: "b", start: 12.8 }], 60)).toBe(12.8);
    const { directOnScreenText } = await import("./onScreenTextDirector");
    const t = film(30, [g("q", "location_card", 5, 6.5, "Brandenburg Gate in West Berlin today")]);
    directOnScreenText(t);
    const card = graphicsOf(t).find((x) => x.id === "q")!;
    expect(card.end - card.start).toBeCloseTo(readingSec("Brandenburg Gate in West Berlin today"), 3);
  });
  it("a sentence that names several years gets a timeline of exactly those years; 'from A to B' a before → after", async () => {
    const { planMotionGraphics } = await import("./cinematicEditingEngine/motionGraphicsPlanner");
    const I = (t: string) => ({ spokenText: t, visualLocation: "", visualSubject: "", visualTime: "", visualAction: "", events: [], people: [], objects: [], brands: [], companies: [], historicalContext: "" } as never);
    const tl = planMotionGraphics(I("Between 1961 and 1989 the wall divided the city."), undefined, 0, 5);
    expect(tl.find((x) => x.graphicType === "timeline")?.data.events).toEqual([{ year: "1961", label: "" }, { year: "1989", label: "" }]);
    expect(tl.some((x) => x.graphicType === "date_card")).toBe(false);
    const ft = planMotionGraphics(I("The family went from a reality show to a global media empire."), undefined, 0, 5);
    expect(ft.find((x) => x.graphicType === "comparison")?.data).toMatchObject({ leftLabel: "reality show", rightLabel: "global media empire", connector: "→" });
    expect(planMotionGraphics(I("Prices rose from 3 dollars to 9 dollars."), undefined, 0, 5).some((x) => x.graphicType === "comparison")).toBe(false);
  });
});

describe("the planner reads its own data out of the sentence", () => {
  it("a figure the sentence states: currency, scale, percent, or a whole number of 100+, never a year", async () => {
    const { statFromSentence } = await import("./cinematicEditingEngine/motionGraphicsPlanner");
    expect(statFromSentence("Elon Musk bought Twitter for 44 billion dollars.")).toEqual({ callout: "$44 billion", caption: "" });
    expect(statFromSentence("At least 140 people died at the wall.")).toEqual({ callout: "140", caption: "people" });
    expect(statFromSentence("The company grew 35% in 2019.")).toEqual({ callout: "35%", caption: "" });
    expect(statFromSentence("By 2023 it had 2,000 employees.")).toEqual({ callout: "2,000", caption: "employees" });
    expect(statFromSentence("In 1961 the border closed.")).toBeNull();
    expect(statFromSentence("She had 3 children.")).toBeNull();
  });
  it("the sentence's key phrase, word by word, for kinetic type", async () => {
    const { kineticWordsFromSentence } = await import("./cinematicEditingEngine/captionPlanner");
    expect(
      kineticWordsFromSentence({ spokenText: "Kris Jenner transformed her family into a global media empire.", people: ["Kris Jenner"], visualLocation: "", events: [] })
    ).toEqual([{ word: "media", index: 8 }, { word: "empire", index: 9 }]);
    expect(kineticWordsFromSentence({ spokenText: "In 1961 the border closed.", people: [], visualLocation: "", events: [] })).toEqual([]);
  });
});

describe("what the 2-minute test render showed", () => {
  it("a year followed by a comma is still a year, never a counter", async () => {
    const { statFromSentence } = await import("./cinematicEditingEngine/motionGraphicsPlanner");
    expect(statFromSentence("On 13 August 1961, East Germany sealed the border.")).toBeNull();
    expect(statFromSentence("By 1961, millions had fled.")).toBeNull();
  });
  it("a sentence that states a series gets the chart and no counter of its first value", async () => {
    const { planMotionGraphics } = await import("./cinematicEditingEngine/motionGraphicsPlanner");
    const text = "The population was 79.8 million in 1990, 82.2 million in 2000 and 83.2 million in 2020.";
    const out = planMotionGraphics(
      { spokenText: text, visualLocation: "", visualSubject: "Germany", visualTime: "", visualAction: "", events: [], people: [], objects: [], brands: [], companies: [], historicalContext: "" } as never,
      undefined, 0, 5
    );
    expect(out.map((g) => g.graphicType)).toContain("line_chart");
    expect(out.map((g) => g.graphicType)).not.toContain("statistic_counter");
  });
  it("'In the East' is a direction, not a location card", async () => {
    const { planMotionGraphics } = await import("./cinematicEditingEngine/motionGraphicsPlanner");
    const out = planMotionGraphics(
      { spokenText: "In the East, the Stasi watched everyone.", visualLocation: "East", visualSubject: "", visualTime: "", visualAction: "", events: [], people: [], objects: [], brands: [], companies: [], historicalContext: "" } as never,
      undefined, 0, 5
    );
    expect(out.map((g) => g.graphicType)).not.toContain("location_card");
  });
  it("'East Side Gallery' is a place, not a person", async () => {
    const { extractPersonNamesFromText } = await import("./videoPipeline");
    expect(extractPersonNamesFromText("At the East Side Gallery, artists turned the wall into a canvas.")).toEqual([]);
    expect(extractPersonNamesFromText("He told Mikhail Gorbachev to tear down this wall.")).toEqual(["Mikhail Gorbachev"]);
  }, 60_000);
});

describe("a map only for a place the sentence names", () => {
  it("as a whole word: 'thousands' is not the USA (the 2-minute render put Washington under Leipzig)", async () => {
    const { mentionsLocationKeyword } = await import("./cinematicMotion/locationMap");
    expect(mentionsLocationKeyword("in leipzig, thousands marched every monday", "usa")).toBe(false);
    expect(mentionsLocationKeyword("the usa entered the war", "usa")).toBe(true);
    expect(mentionsLocationKeyword("americans watched", "american")).toBe(true);
    expect(mentionsLocationKeyword("washington d.c. today", "d.c.")).toBe(true);
    const { planMotionGraphics } = await import("./cinematicEditingEngine/motionGraphicsPlanner");
    const out = planMotionGraphics(
      { spokenText: "In Leipzig, thousands marched every Monday for freedom.", visualLocation: "Leipzig", visualSubject: "", visualTime: "", visualAction: "", events: [], people: [], objects: [], brands: [], companies: [], historicalContext: "" } as never,
      undefined, 0, 5
    );
    expect(out.some((g) => g.graphicType === "map" && g.data.locationName === "Washington")).toBe(false);
  });
});
