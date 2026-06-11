import { describe, expect, it } from "vitest";
import {
  buildCinematicSfxAudioFilter,
  buildFacelessDrawtextVF,
  buildStatCountSteps,
  cinematicEffectsEnabled,
  extractStatFromText,
  extractYearsFromText,
  computeMontageBeatStarts,
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
