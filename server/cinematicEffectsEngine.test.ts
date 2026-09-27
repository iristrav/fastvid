import { describe, expect, it } from "vitest";
import {
  buildCinematicSfxAudioFilter,
  buildFacelessDrawtextVF,
  buildFacelessTypewriterDrawtextChain,
  extractStatFromText,
  extractVoiceoverKeywords,
  extractYearsFromText,
  computeMontageBeatStarts,
  computeVoiceBeatWindows,
  computeTtsHardCutMontagePlan,
  pickVoiceBackfillBeatIndex,
  planBeatAlignedYears,
  planIntervalScreenLabels,
  buildYearCaption,
  buildYearDisplayText,
  YEAR_LABEL_ON_SCREEN_SEC,
  SCREEN_LABEL_INTERVAL_SEC,
  SCREEN_LABEL_FONT_SIZE,
  parseFacelessSubtitleLines,
  planCinematicScene,
} from "./cinematicEffectsEngine";
import { archiveVisualMinClipSec } from "./sourcingPolicy";

describe("cinematicEffectsEngine", () => {

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

  it("computeTtsHardCutMontagePlan anchors cuts to voiceStartSec with xfade=0", () => {
    const beats = [
      { text: "One.", holdSec: 3, voiceStartSec: 0, voiceEndSec: 2.0 },
      { text: "Two.", holdSec: 4, voiceStartSec: 2.0, voiceEndSec: 5.5 },
    ];
    const plan = computeTtsHardCutMontagePlan(beats, 5.5, [0, 1], 0);
    expect(plan).not.toBeNull();
    expect(plan!.xfadeSec).toBe(0);
    expect(plan!.cutStartsSec[0]).toBeCloseTo(0, 2);
    expect(plan!.cutStartsSec[1]).toBeCloseTo(2.0, 2);
    // RONDE 30: these numbers predate archiveVisualMinClipSec() being raised to 5s. Every clip
    // now has a 5-second floor, so a voice window shorter than that cannot be matched exactly and
    // the montage necessarily runs long — the tail is covered by holding the last frame
    // (RONDE 26). Asserting the invariants that survive a change to the floor instead of the old
    // literals. The underlying tension (a 5s floor cannot fit a 2s sentence) is real and is
    // reported separately; it is not something a test edit should paper over silently.
    const floor = archiveVisualMinClipSec();
    expect(plan!.durations[0]).toBeGreaterThanOrEqual(floor);
    expect(plan!.durations[1]).toBeGreaterThanOrEqual(floor);
    // The second beat has the longer voice window, so it must never be the shorter clip.
    expect(plan!.durations[1]).toBeGreaterThanOrEqual(plan!.durations[0]);
  });

  it("computeTtsHardCutMontagePlan works with partial TTS windows", () => {
    const beats = [
      { text: "First sentence here.", holdSec: 3, voiceStartSec: 0, voiceEndSec: 2.5 },
      { text: "Second without timestamps.", holdSec: 3 },
      { text: "Third anchored.", holdSec: 3, voiceStartSec: 5.0, voiceEndSec: 7.0 },
    ];
    const plan = computeTtsHardCutMontagePlan(beats, 7.0, [0, 1, 2], 0);
    expect(plan).not.toBeNull();
    expect(plan!.xfadeSec).toBe(0);
    expect(plan!.cutStartsSec[0]).toBeCloseTo(0, 1);
    expect(plan!.cutStartsSec[2]).toBeGreaterThan(plan!.cutStartsSec[1]!);
  });

  it("plans interval screen labels every 30s with years and keywords", () => {
    const labels = planIntervalScreenLabels(
      0,
      65,
      [
        { text: "In 1933 Hitler became chancellor.", holdSec: 20, powerWord: "Hitler" },
        { text: "War began in 1939 across Europe.", holdSec: 20, powerWord: "War" },
        { text: "The invasion changed everything.", holdSec: 25, powerWord: "Invasion" },
      ],
      SCREEN_LABEL_INTERVAL_SEC
    );
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(labels[0].startTime).toBeCloseTo(0, 0);
    expect(labels[1].startTime).toBeCloseTo(30, 0);
    expect(labels[0].endTime - labels[0].startTime).toBeCloseTo(YEAR_LABEL_ON_SCREEN_SEC, 1);
    expect(labels.some((l) => /1933|1939/.test(l.displayText))).toBe(true);
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

  it("extracts voiceover keywords in narration order", () => {
    expect(extractVoiceoverKeywords("In 1945 costs hit $4.2 billion")).toEqual(["1945", "$4.2 BILLION"]);
    expect(extractVoiceoverKeywords("Unemployment hit 25 procent")).toEqual(["25%"]);
    expect(extractVoiceoverKeywords("Amsterdam groeide in 2020")).toEqual(["2020"]);
    expect(extractVoiceoverKeywords("No numbers here")).toEqual([]);
    expect(extractVoiceoverKeywords("€10 miljard en 15%")).toEqual(["€10 MILJARD", "15%"]);
  });

  it("parses faceless subtitle lines from voiceover keywords only", () => {
    const lines = parseFacelessSubtitleLines("Elon Musk founded SpaceX in 2002");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("2002");
    expect(lines[0]!.emphasis).toBe(true);
    expect(parseFacelessSubtitleLines("No stats in this sentence")).toEqual([]);
  });

  it("builds faceless typewriter drawtext chain bottom-left", () => {
    const lines = parseFacelessSubtitleLines("Hitler rose to power in 1933");
    const chain = buildFacelessTypewriterDrawtextChain("vprep", "vout", lines, 4.0, "bottom-left");
    expect(chain).toContain("drawtext=");
    expect(chain).toContain("x=56");
    expect(chain).toContain("enable=");
    expect(chain).toContain("text='1'");
    expect(chain).toContain("[vout]");
  });
});
