/**
 * AUDIT — graphics and wrong or repeated pictures (videos 627/628).
 *
 *   RC1  a hole was filled with shots approved for OTHER sentences, never judged for this one
 *        (627: 37.6 s of eleven `_fill` shots under the Henri Guisan / D-Day sentences);
 *   RC2  the motion-graphics planner planned graphics no component can draw
 *        (627: 14 planned, 5 drawn — `highlight_box` without a region, `chart`, `arrow`, …);
 *   RC3  nothing said what KIND of picture a sentence wants (MediaForm was only logged);
 *   RC4  the editorial engine generated cards into a map nothing read;
 *   RC5  `sentenceAlreadyDressed` — checked: it only ever drops a sentence's duplicate graphics.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { holdPictureUnderVoice, translateEdl } from "./edlToTimeline";
import { fillerFitsFor } from "./cinematicProduction";
import { planMotionGraphics, plannedGraphicIsDrawable, statesAQuantity } from "./cinematicEditingEngine/motionGraphicsPlanner";
import { buildBeatVisualIntent, mediaFormsForIntent } from "./beatVisualIntent";
import { graphicIsRenderable } from "./graphicsVocabulary";
import { timelineToRemotionProps } from "./remotionProps";
import type { TimelineVideoClip } from "./projectTimeline";
import type { EditDecision, MotionGraphicInstruction } from "./cinematicEditingEngine/types";
import type { VisualIntent } from "./visualMatchingV2/types";
import type { Scene } from "./pipeline/types";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

/* ═══════════════════════ fixtures ═══════════════════════ */

const clip = (id: string, start: number, end: number, sceneIndex = 0, beatIndex = 0): TimelineVideoClip => ({
  id,
  kind: "video",
  source: { provider: "loc", providerAssetId: id, mediaUrl: `https://x/${id}.mp4` },
  timelineStart: start,
  timelineEnd: end,
  motion: "none",
  transitionIn: "hard_cut",
  transitionOut: "hard_cut",
  previewSource: "asset",
  sceneIndex,
  beatIndex,
});

/** Sentence A (0–4 s) has shot a, sentences B (4–9 s) and C (9–13 s) have none, sentence D has d. */
const WINDOWS = [
  { sceneIndex: 0, beatIndex: 0, startSec: 0, endSec: 4 },
  { sceneIndex: 0, beatIndex: 1, startSec: 4, endSec: 9 },
  { sceneIndex: 0, beatIndex: 2, startSec: 9, endSec: 13 },
  { sceneIndex: 0, beatIndex: 3, startSec: 13, endSec: 17 },
];
const film = () => [clip("a", 0, 4, 0, 0), clip("x", 20, 24, 1, 0), clip("y", 24, 28, 1, 1), clip("d", 13, 17, 0, 3)].sort(
  (p, q) => p.timelineStart - q.timelineStart
);
/** Approvals as the picture editor gave them: shot id → the sentences it was judged to fit. */
const approvals = (fits: Record<string, string[]>) => (filler: TimelineVideoClip, s: number, b: number) =>
  (fits[filler.id] ?? []).includes(`s${s}b${b}`);
const fillersIn = (clips: TimelineVideoClip[]) => clips.filter((c) => /_fill\d+$/.test(c.id));

function makeIntent(overrides: Partial<VisualIntent> = {}): VisualIntent {
  return {
    beatId: "b0", spokenText: "It was a normal day.", visualSubject: "", visualAction: "", visualLocation: "",
    visualTime: "", historicalContext: "", emotion: "", visualDescription: "", primaryKeyword: "",
    secondaryKeyword: "", negativeKeywords: [], secondaryVisualSubjects: [], objects: [], brands: [],
    companies: [], people: [], countries: [], events: [], intentHash: "h", cacheHit: false,
    ...overrides,
  };
}
const scene = (overrides: Partial<Scene> = {}): Scene => ({
  index: 0, text: "text", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8, ...overrides,
});
function decision(beatId: string, graphics: MotionGraphicInstruction[]): EditDecision {
  return {
    beatId,
    sceneIndex: 0,
    clip: {
      candidateId: `loc:${beatId}`, assetType: "video", localPath: null, remoteUrl: "https://x/a.mp4",
      trimStartSec: 0, trimEndSec: 6, startSec: 0, endSec: 6, timingSource: "tts_word_alignment",
    },
    shot: { shotType: "wide", reason: "r" } as EditDecision["shot"],
    camera: { movement: "none", intensity: 0, reason: "r" },
    transitionIn: { type: "cut", durationSec: 0, reason: "r" },
    captions: [],
    motionGraphics: graphics,
    effects: [] as never,
    sounds: [],
    pacing: { tone: "measured", cutSpeedMultiplier: 1, movementIntensity: 0.3, reason: "r" },
  };
}
const identity = { provider: "loc", providerAssetId: "item/1", mediaUrl: "https://x/a.mp4" };

/** One sentence per kind of subject, each stating a number with its unit. */
const TOPICS: Array<{ topic: string; text: string; stat: string }> = [
  { topic: "WWII", text: "By 1945, 70 million people had been mobilised.", stat: "70 million" },
  { topic: "Tesla", text: "Tesla delivered 1.8 million cars in 2023.", stat: "1.8 million" },
  { topic: "sport", text: "The final drew 1.5 billion viewers worldwide.", stat: "1.5 billion" },
  { topic: "science", text: "The mirror reflects 98% of infrared light.", stat: "98%" },
  { topic: "economics", text: "Inflation reached 9% in a single year.", stat: "9%" },
  { topic: "geography", text: "The Amazon basin covers 7 million square kilometres.", stat: "7 million" },
];

/* ═══════════════════════ TEST 1/2 — _fill only with a verdict for THIS sentence ═══════════════════════ */

describe("RC1 — a borrowed shot fills a hole only where it was approved for that sentence", () => {
  it("TEST 1: a shot approved only for sentence A is not put under sentence B — the hole is held", () => {
    const clips = film();
    holdPictureUnderVoice({
      clips,
      voiceDurationSec: 28,
      fillerFits: fillerFitsFor(WINDOWS, approvals({ x: ["s1b0"], y: ["s1b1"], d: ["s0b3"] })),
    });
    expect(fillersIn(clips)).toEqual([]);
    /** The existing hold: the outgoing shot reaches the next one, no other sentence's picture. */
    const a = clips.find((c) => c.id === "a")!;
    expect(a.timelineEnd).toBe(13);
  });

  it("TEST 2: a shot already APPROVED for sentences B and C may fill their hole", () => {
    const clips = film();
    holdPictureUnderVoice({
      clips,
      voiceDurationSec: 28,
      fillerFits: fillerFitsFor(WINDOWS, approvals({ x: ["s0b1", "s0b2"] })),
    });
    const fillers = fillersIn(clips);
    expect(fillers.length).toBeGreaterThan(0);
    expect(fillers.every((f) => f.id.startsWith("x_fill"))).toBe(true);
  });

  it("a piece that runs under two sentences needs the approval of both", () => {
    const fits = fillerFitsFor(WINDOWS, approvals({ x: ["s0b1"] }));
    expect(fits(clip("x", 0, 1), 5, 8)).toBe(true);
    expect(fits(clip("x", 0, 1), 8, 11)).toBe(false);
    /** A span no sentence covers has nobody to approve it. */
    expect(fits(clip("x", 0, 1), 40, 42)).toBe(false);
  });

  it("without the check (tests, other callers) the fill behaves exactly as before", () => {
    const clips = film();
    holdPictureUnderVoice({ clips, voiceDurationSec: 28 });
    expect(fillersIn(clips).length).toBeGreaterThan(0);
  });

  it("production passes the picture editor's own verdicts, per sentence, no new look", () => {
    const pipe = read("videoPipeline.ts");
    const at = pipe.indexOf("fillerApprovedFor: (filler, sceneIndex, beatPosition) => {");
    expect(at).toBeGreaterThan(0);
    const body = pipe.slice(at, at + 1200);
    expect(body).toContain("relevanceVerdictForRenderedAsset(visualDedup.beatRelevance, {");
    expect(body).toContain('return found?.verdict === "fits" && found.evaluated !== false && !found.reprieved;');
    expect(body).not.toMatch(/judgePicture|checkBeatRelevance|judgeBeatClipRelevance/);
    expect(read("cinematicProduction.ts")).toContain(
      "...(params.fillerApprovedFor ? { fillerFits: fillerFitsFor(built.beatWindows, params.fillerApprovedFor) } : {}),"
    );
    /** The 40 % borrowed-shot refusal (6dbbd5c) is untouched. */
    expect(read("deliveryGate.ts")).toContain("export const MAX_BORROWED_SHOT_SHARE = 0.4;");
  });
});

/* ═══════════════════════ TEST 3/4 — only drawable graphics are planned ═══════════════════════ */

describe("RC2 — the planner plans only what the renderer can draw", () => {
  it("TEST 3: a highlight_box without bounds is not planned", () => {
    const graphics = planMotionGraphics(makeIntent({ objects: ["headset"] }), undefined, 0, 4);
    expect(graphics.find((g) => g.graphicType === "highlight_box")).toBeUndefined();
    expect(plannedGraphicIsDrawable({ graphicType: "highlight_box", data: { label: "x" }, startSec: 0, durationSec: 2, reason: "r" })).toBe(false);
    /** With a region it is drawable — the rule is the renderer's, not a ban on the type. */
    expect(
      plannedGraphicIsDrawable({
        graphicType: "highlight_box", data: { label: "x", normX: 0.2, normY: 0.2, normW: 0.3, normH: 0.3 }, startSec: 0, durationSec: 2, reason: "r",
      })
    ).toBe(true);
  });

  it("chart, arrow, animated_icon and comparison are not planned", () => {
    const g = [
      ...planMotionGraphics(makeIntent({ spokenText: "Revenue growth accelerated sharply." }), undefined, 0, 4),
      ...planMotionGraphics(makeIntent({ visualAction: "the chart shows a sharp rise" }), undefined, 0, 4),
      ...planMotionGraphics(makeIntent({ companies: ["Apple"] }), undefined, 0, 4),
      ...planMotionGraphics(makeIntent({ spokenText: "Sales this year versus sales last year." }), undefined, 0, 4),
    ].map((x) => x.graphicType);
    for (const t of ["chart", "arrow", "animated_icon", "comparison"]) expect(g).not.toContain(t);
  });

  it("TEST 4: a drawable graphic is planned, reaches the timeline and arrives in Remotion's props", () => {
    const planned = planMotionGraphics(makeIntent({ spokenText: "Adoption reached 87% of users." }), scene({ statCallout: "87%" }), 0, 4);
    expect(planned.length).toBeGreaterThan(0);
    const { timeline } = translateEdl({ videoId: 1, inputs: [{ decision: decision("b0", planned), sceneOffsetSec: 0, identity }] });
    const track = timeline.tracks.find((t) => t.kind === "GRAPHICS");
    const onTrack = track && track.kind === "GRAPHICS" ? track.graphics : [];
    expect(onTrack.length).toBe(planned.length);
    for (const g of onTrack) expect(graphicIsRenderable(g.graphicType, g.data ?? {}, g.label ?? null)).toBe(true);
    const props = timelineToRemotionProps({ timeline });
    expect(props.graphics.map((g) => g.id).sort()).toEqual(onTrack.map((g) => g.id).sort());
  });

  it("every graphic the planner returns, for any sentence, is drawable", () => {
    const intents = [
      makeIntent({ objects: ["headset"], companies: ["Apple"], visualAction: "shows", spokenText: "Sales grew versus last year." }),
      makeIntent({ visualLocation: "Paris, France" }),
      makeIntent({ visualTime: "1969", events: ["Apollo 11 landing"] }),
      ...TOPICS.map((t) => makeIntent({ spokenText: t.text })),
    ];
    for (const i of intents) for (const g of planMotionGraphics(i, scene({ statCallout: "87%" }), 0, 4)) {
      expect(plannedGraphicIsDrawable(g), `${g.graphicType} planned and undrawable`).toBe(true);
    }
  });
});

/* ═══════════════════════ TEST 5/6 — the sentence's preferred form, a preference only ═══════════════════════ */

describe("RC3 — what kind of picture a sentence wants", () => {
  it("TEST 5: the preferred form is on the intent the selection point builds", () => {
    const intent = buildBeatVisualIntent({ sceneIndex: 0, beatIndex: 0, statesQuantity: true });
    expect(intent.mediaForm?.preferred[0]).toBe("DATA_VISUALIZATION");
    const pipe = read("videoPipeline.ts");
    const at = pipe.indexOf("const _intent = ensureBeatVisualIntent(dedup.beatIntent, {");
    expect(pipe.slice(at, at + 500)).toContain("statesQuantity: statesAQuantity(beatText),");
    /** And the render log line prints the same need. */
    expect(read("beatVisualIntent.ts")).toContain("formatMediaFormNeed(intent.mediaForm ?? mediaFormsForIntent(intent))");
  });

  it("TEST 6: the footage forms stay acceptable, so normal sourcing still answers", () => {
    const need = mediaFormsForIntent({ people: ["Elon Musk"] }, true);
    expect(need.preferred).toEqual(["DATA_VISUALIZATION", "PERSON"]);
    expect(need.acceptable).toEqual(expect.arrayContaining(["PERSON", "REAL_FOOTAGE", "PHOTO", "B_ROLL"]));
    /** "Tesla's market value exploded": a chart is preferred, nothing drawable exists — no graphic is planned. */
    expect(statesAQuantity("Tesla's market value exploded.")).toBe(true);
    expect(planMotionGraphics(makeIntent({ spokenText: "Tesla's market value exploded." }), undefined, 0, 4)).toEqual([]);
    /** A sentence with no quantity keeps exactly the old need. */
    expect(mediaFormsForIntent({ people: ["Elon Musk"] }, false)).toEqual(mediaFormsForIntent({ people: ["Elon Musk"] }));
  });

  it("a year or a bare number is not a quantity; typed fields alone still prove no chart", () => {
    expect(statesAQuantity("In 1945 the war ended.")).toBe(false);
    expect(statesAQuantity("He had 3 brothers.")).toBe(false);
    expect(mediaFormsForIntent({ action: ["rose by 40 percent"] }).preferred).not.toContain("DATA_VISUALIZATION");
  });
});

/* ═══════════════════════ TEST 7 — sentenceAlreadyDressed drops duplicates only ═══════════════════════ */

describe("RC5 — a sentence's second clip carries the same graphics, and only that copy is dropped", () => {
  it("TEST 7: the planner gives every clip of one sentence the same graphics (only the timing moves)", () => {
    const intent = makeIntent({ spokenText: "Adoption reached 87% of users.", visualLocation: "Paris, France" });
    const a = planMotionGraphics(intent, scene({ statCallout: "87%" }), 0, 3);
    const b = planMotionGraphics(intent, scene({ statCallout: "87%" }), 3, 2);
    expect(b.map((g) => [g.graphicType, g.data])).toEqual(a.map((g) => [g.graphicType, g.data]));
  });

  it("two clips of one sentence put its graphics on screen once; another sentence keeps its own", () => {
    const g = planMotionGraphics(makeIntent({ spokenText: "Adoption reached 87% of users." }), scene({ statCallout: "87%" }), 0, 3);
    const other = planMotionGraphics(makeIntent({ visualLocation: "Paris, France" }), undefined, 0, 3);
    const { timeline } = translateEdl({
      videoId: 1,
      inputs: [
        { decision: decision("s0b0", g), sceneOffsetSec: 0, identity },
        { decision: decision("s0b0", g), sceneOffsetSec: 3, identity },
        { decision: decision("s0b1", other), sceneOffsetSec: 6, identity },
      ],
    });
    const track = timeline.tracks.find((t) => t.kind === "GRAPHICS");
    const onTrack = track && track.kind === "GRAPHICS" ? track.graphics : [];
    expect(onTrack.length).toBe(g.length + other.length);
  });
});

/* ═══════════════════════ RC4 — no editorial cards nobody reads ═══════════════════════ */

describe("RC4 — the editorial engine's unused cards are not generated", () => {
  it("the pipeline no longer generates them, and the progress counts the timeline's graphics only", () => {
    const pipe = read("videoPipeline.ts");
    expect(pipe).not.toContain("generateGraphicClip(plan, workDir)");
    expect(pipe).not.toContain("visualDedup.graphicClips.set(");
    expect(pipe).toContain("graphicsPlanned: cinematicProgress.graphicsPlanned,");
  });
});

/* ═══════════════════════ TEST 8 — every kind of subject ═══════════════════════ */

describe("TEST 8 — the same rules for every subject", () => {
  it.each(TOPICS)("$topic: the quantity is read, the form is preferred, the stat graphic is drawable", ({ text, stat }) => {
    expect(statesAQuantity(text)).toBe(true);
    expect(mediaFormsForIntent({}, statesAQuantity(text)).preferred[0]).toBe("DATA_VISUALIZATION");
    const planned = planMotionGraphics(makeIntent({ spokenText: text }), scene({ statCallout: stat }), 0, 4);
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every(plannedGraphicIsDrawable)).toBe(true);
  });

  it.each(TOPICS)("$topic: a hole is never filled with that topic's shot from another sentence", () => {
    const clips = film();
    holdPictureUnderVoice({ clips, voiceDurationSec: 28, fillerFits: fillerFitsFor(WINDOWS, approvals({ x: ["s1b0"] })) });
    expect(fillersIn(clips)).toEqual([]);
  });
});
