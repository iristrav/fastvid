import { describe, expect, it } from "vitest";
import {
  buildCinematicSfxAudioFilter,
  buildFacelessDrawtextVF,
  buildStatCountSteps,
  cinematicEffectsEnabled,
  extractStatFromText,
  extractYearsFromText,
  computeMontageBeatStarts,
  planBeatAlignedYears,
  buildYearDisplayText,
  buildYearDrawtextFilterChain,
  planPhotoShutterCues,
  YEAR_LABEL_ON_SCREEN_SEC,
  overlayUsesFullFrame,
  parseFacelessSubtitleLines,
  planCinematicScene,
} from "./cinematicEffectsEngine";

describe("cinematicEffectsEngine", () => {
  it("is enabled by default", () => {
    const prev = process.env.ENABLE_CINEMATIC_EFFECTS;
    delete process.env.ENABLE_CINEMATIC_EFFECTS;
    expect(cinematicEffectsEnabled()).toBe(true);
    process.env.ENABLE_CINEMATIC_EFFECTS = "false";
    expect(cinematicEffectsEnabled()).toBe(false);
    if (prev === undefined) delete process.env.ENABLE_CINEMATIC_EFFECTS;
    else process.env.ENABLE_CINEMATIC_EFFECTS = prev;
  });

  it("extracts years in narration order", () => {
    expect(extractYearsFromText("In 1939 the war started. By 1945 it ended.")).toEqual([
      "1939",
      "1945",
    ]);
    expect(extractYearsFromText("no dates here")).toEqual([]);
  });

  it("extracts money and percent stats but not years", () => {
    expect(extractStatFromText("Costs reached $4.2 billion in 1945")).toBe("$4.2 billion");
    expect(extractStatFromText("Unemployment hit 25%")).toMatch(/25%/);
    expect(extractStatFromText("Only year 1989")).toBeNull();
  });

  it("plans voice-synced year labels", () => {
    const labels = planBeatAlignedYears(
      [
        { text: "In 1933 Hitler became chancellor.", holdSec: 5 },
        { text: "War began in 1939.", holdSec: 4 },
      ],
      12
    );
    expect(labels.map((l) => l.year)).toEqual(["1933", "1939"]);
    expect(labels[0].startTime).toBeGreaterThan(0);
    expect(labels[1].startTime).toBeGreaterThan(labels[0].startTime);
    expect(labels[0].endTime - labels[0].startTime).toBeCloseTo(YEAR_LABEL_ON_SCREEN_SEC, 1);
    expect(labels[0].displayText).toContain("1933");
  });

  it("builds caption from words local to the year, not whole beat", () => {
    const long =
      "Germany was a democratic nation when Adolf Hitler rose to power in 1933.";
    const text = buildYearDisplayText(long, "1933");
    expect(text).toContain("1933");
    expect(text).not.toMatch(/GERMANY.*DEMOCRATIC.*NATION/i);
    expect(text).toMatch(/HITLER|ROSE|POWER/i);
  });

  it("times each year label near when that year is spoken in the beat", () => {
    const labels = planBeatAlignedYears(
      [{ text: "Early talk then war in 1939 changed everything.", holdSec: 10 }],
      12
    );
    expect(labels).toHaveLength(1);
    expect(labels[0].startTime).toBeGreaterThan(2);
    expect(labels[0].startTime).toBeLessThan(8);
  });

  it("builds drawtext chain with shadow only (no box)", () => {
    const chain = buildYearDrawtextFilterChain("vmont", "vout", [
      { year: "1939", displayText: "WAR BEGAN, 1939", startTime: 2, endTime: 5.5 },
    ]);
    expect(chain).toContain("drawtext");
    expect(chain).toContain("box=0");
    expect(chain).toContain("borderw=3");
    expect(chain).not.toContain("0x2A2A2A");
  });

  it("plans shutter cues when photo stills enter montage", () => {
    const cues = planPhotoShutterCues(
      ["a.mp4", "scene_0_b1_wiki_1.mp4", "scene_0_b2_wiki_2.mp4", "b.mp4"],
      [4, 5, 3, 4],
      (p) => /_wiki_/.test(p)
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].type).toBe("shutter");
    expect(cues[0].timeSec).toBeCloseTo(4.03, 2);
  });

  it("computes beat-aligned year overlay timing", () => {
    expect(computeMontageBeatStarts([4, 5, 3], 0)).toEqual([0, 4, 9]);
  });

  it("plans year overlays and transition sfx", () => {
    const plan = planCinematicScene(
      { index: 0, text: "Hitler rose in 1933 and invaded Poland in 1939." },
      20
    );
    expect(plan.years).toEqual(["1933", "1939"]);
    expect(plan.audioCues.some((c) => c.type === "impact")).toBe(true);
    expect(plan.audioCues.some((c) => c.type === "whoosh")).toBe(true);
    expect(plan.transitionStyle).toBe("dissolve");
  });

  it("builds sfx audio filter chain", () => {
    const chain = buildCinematicSfxAudioFilter(
      "voiceFaded",
      [{ inputIndex: 5, timeSec: 1.2, volume: 0.3 }],
      18.5,
      "aout"
    );
    expect(chain).toContain("adelay=1200|1200");
    expect(chain).toContain("amix=inputs=2");
    expect(chain).toContain("normalize=0");
    expect(chain).toContain("[aout]");
  });

  it("detects full-frame overlays", () => {
    expect(overlayUsesFullFrame({ path: "x", startTime: 0, endTime: 1, isYearBadge: true })).toBe(
      false
    );
    expect(
      overlayUsesFullFrame({
        path: "x",
        startTime: 0,
        endTime: 1,
        isYearBadge: true,
        overlayX: 56,
        overlayY: 900,
      })
    ).toBe(false);
    expect(overlayUsesFullFrame({ path: "x", startTime: 0, endTime: 1, fullFrame: true })).toBe(true);
    expect(overlayUsesFullFrame({ path: "x", startTime: 0, endTime: 1 })).toBe(false);
  });

  it("parses faceless subtitle emphasis lines", () => {
    const lines = parseFacelessSubtitleLines("Elon Musk founded SpaceX in 2002");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.emphasis)).toBe(true);
  });

  it("builds stat count steps for money", () => {
    const steps = buildStatCountSteps("$1 Billion");
    expect(steps[0]).toBe("$0");
    expect(steps.length).toBeGreaterThan(2);
  });

  it("builds faceless drawtext vf bottom-left", () => {
    const lines = parseFacelessSubtitleLines("Hitler rose to power in 1933");
    const vf = buildFacelessDrawtextVF(lines, 4.0, "bottom-left");
    expect(vf).toContain("drawtext=");
    expect(vf).toContain("x=56");
    expect(vf).toContain("enable=");
  });
});
