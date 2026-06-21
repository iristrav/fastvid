import { describe, expect, it } from "vitest";
import {
  buildCinematicSfxAudioFilter,
  buildFacelessDrawtextVF,
  buildFacelessTypewriterDrawtextChain,
  buildStatCountSteps,
  cinematicEffectsEnabled,
  extractStatFromText,
  extractVoiceoverKeywords,
  extractYearsFromText,
  computeMontageBeatStarts,
  computeVoiceBeatWindows,
  computeVoiceSyncedClipDurations,
  computeTtsHardCutMontagePlan,
  pickVoiceBackfillBeatIndex,
  finalizeVoiceSyncedMontageDurations,
  planBeatAlignedYears,
  planIntervalScreenLabels,
  planVoiceSyncedScreenLabels,
  selectSpacedScreenLabels,
  buildYearCaption,
  buildYearDisplayText,
  buildYearDrawtextFilterChain,
  planPhotoShutterCues,
  YEAR_LABEL_ON_SCREEN_SEC,
  SCREEN_LABEL_INTERVAL_SEC,
  SCREEN_LABEL_FONT_SIZE,
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

  it("plans voice-synced year and place labels from second 10", () => {
    const labels = planVoiceSyncedScreenLabels(
      [
        { text: "Eerst was het rustig in Europa.", holdSec: 12 },
        { text: "Maar in Duitsland veranderde alles in 1933.", holdSec: 14 },
        { text: "In 1939 brak de oorlog uit in Polen.", holdSec: 14 },
        { text: "Berlijn viel en de wereld veranderde.", holdSec: 12 },
      ],
      62,
      0
    );
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(labels.every((l) => l.startTime >= 10)).toBe(true);
    expect(labels.some((l) => /^\d{4}$/.test(l.displayText))).toBe(true);
    expect(labels.some((l) => /DUITS|POLEN|BERLIJ/i.test(l.displayText))).toBe(true);
    expect(labels.every((l) => !/ — /.test(l.displayText))).toBe(true);
  });

  it("shows percentage label for geo stat beats like America 1%", () => {
    const labels = planVoiceSyncedScreenLabels(
      [{ text: "In America, only 1% of trips are by bike.", holdSec: 8 }],
      20,
      10
    );
    expect(labels.some((l) => l.displayText === "1%")).toBe(true);
    expect(labels.some((l) => /AMERIKA|AMERICA/i.test(l.displayText))).toBe(false);
  });

  it("spaces labels apart and caps count", () => {
    const picked = selectSpacedScreenLabels(
      [
        { year: "1933", caption: "", displayText: "1933", startTime: 11, endTime: 15 },
        { year: "1934", caption: "", displayText: "1934", startTime: 12, endTime: 16 },
        { year: "BERLIJN", caption: "", displayText: "BERLIJN", startTime: 25, endTime: 29 },
      ],
      60,
      10,
      9,
      2
    );
    expect(picked).toHaveLength(2);
    expect(picked[1]!.startTime - picked[0]!.endTime).toBeGreaterThanOrEqual(8.5);
  });

  it("computes word-weighted voice beat windows", () => {
    const windows = computeVoiceBeatWindows(
      [
        { text: "Korte zin.", holdSec: 3 },
        { text: "Een veel langere zin met extra woorden voor timing.", holdSec: 7 },
      ],
      10
    );
    expect(windows[0]!.dur).toBeLessThan(windows[1]!.dur);
    expect(windows[0]!.start).toBe(0);
    expect(windows[1]!.start).toBeCloseTo(windows[0]!.dur, 1);
  });

  it("uses TTS voiceStartSec windows when present", () => {
    const beats = [
      { text: "First.", holdSec: 3, voiceStartSec: 0, voiceEndSec: 2.5 },
      { text: "Second longer.", holdSec: 4, voiceStartSec: 2.5, voiceEndSec: 6.0 },
    ];
    const windows = computeVoiceBeatWindows(beats, 6.5);
    expect(windows[0]!.start).toBe(0);
    expect(windows[0]!.dur).toBeCloseTo(2.5, 1);
    expect(windows[1]!.start).toBeCloseTo(2.5, 1);
    expect(windows[1]!.dur).toBeCloseTo(4.0, 1);
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
    expect(plan!.durations[0]).toBeCloseTo(2.0, 1);
    expect(plan!.durations[1]).toBeCloseTo(3.5, 1);
  });

  it("computes voice-synced clip durations with xfade overlap", () => {
    const beats = [
      { text: "Eerste zin.", holdSec: 3 },
      { text: "Tweede zin met meer woorden.", holdSec: 4 },
      { text: "Derde.", holdSec: 2 },
    ];
    const voiceDur = 12;
    const xfade = 0.3;
    const durs = computeVoiceSyncedClipDurations(beats, voiceDur, [0, 1, 2], xfade);
    expect(durs).toHaveLength(3);
    const montageLen = durs.reduce((s, d) => s + d, 0) - 2 * xfade;
    expect(montageLen).toBeCloseTo(voiceDur, 1);
    expect(durs[1]).toBeGreaterThan(durs[0]);
    expect(durs[1]).toBeGreaterThan(durs[2]);
  });

  it("splits voice window when multiple clips map to one beat", () => {
    const beats = [
      { text: "Kort.", holdSec: 3 },
      { text: "Langere slot aan het einde van de voiceover.", holdSec: 7 },
    ];
    const voiceDur = 10;
    const xfade = 0.25;
    const durs = computeVoiceSyncedClipDurations(beats, voiceDur, [0, 1, 1], xfade, 0);
    expect(durs).toHaveLength(3);
    expect(durs[2]).toBeCloseTo(durs[1], 0);
    expect(durs[1]).toBeGreaterThan(durs[0]);
  });

  it("prefers later beats for backfill when end voice still needs footage", () => {
    const beats = [
      { text: "Opening zin.", holdSec: 3 },
      { text: "Midden.", holdSec: 3 },
      { text: "Afsluitende zin met veel woorden.", holdSec: 4 },
    ];
    const voiceDur = 12;
    const windows = computeVoiceBeatWindows(beats, voiceDur);
    const clipBeatIndices = [0, 1];
    const clipDurations = [windows[0]!.dur, windows[1]!.dur * 0.5];
    const pick = pickVoiceBackfillBeatIndex(beats, voiceDur, clipBeatIndices, clipDurations, 0.3);
    expect(pick).toBe(2);
  });

  it("finalizeVoiceSyncedMontageDurations scales down when montage runs long", () => {
    const seed = [6, 6, 6];
    const out = finalizeVoiceSyncedMontageDurations(seed, 10, [20, 20, 20], 0.3, 0);
    const montageLen = out.reduce((s, d) => s + d, 0) - 2 * 0.3;
    expect(montageLen).toBeLessThanOrEqual(10.3);
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

  it("builds yellow pill typewriter drawtext bottom-left", () => {
    const chain = buildYearDrawtextFilterChain("vmont", "vout", [
      {
        year: "1933",
        caption: "RISE TO POWER",
        displayText: "RISE TO POWER — 1933",
        startTime: 2,
        endTime: 6,
      },
    ]);
    expect(chain).toContain("drawbox");
    expect(chain).toContain("0xFFCC00");
    expect(chain).toContain("fontcolor=black");
    expect(chain).toContain(`fontsize=${SCREEN_LABEL_FONT_SIZE}`);
    expect(chain).toContain("1933");
    expect(chain).toContain("between(t\\,2.000\\,2.042)");
    expect(chain).toContain("y=h-");
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

  it("builds stat count steps for money", () => {
    const steps = buildStatCountSteps("$1 Billion");
    expect(steps[0]).toBe("$0");
    expect(steps.length).toBeGreaterThan(2);
  });
});
