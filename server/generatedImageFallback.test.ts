/**
 * GENERATED_IMAGE_FALLBACK — a generated still for a sentence nothing else could illustrate.
 *
 * Order: REAL/ARCHIVE/OPEN/STOCK → DATA/MAP GRAPHIC → AI GENERATED IMAGE → CHAPTER_CARD.
 *
 *   1  no existing picture → a generated image is chosen (and the pass runs after every source);
 *   2  a good existing picture → no generation;
 *   3  a data graphic or map can be the picture → no generation;
 *   4  the generated image is asked for with the sentence and its VisualIntent;
 *   5  too little or unsuitable content → no generation, the chapter card;
 *   6  a generated still reaches a real MP4 as the sentence's visual, for its whole sentence;
 *   7  a generated still is never lent to another sentence as a _fill.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GENERATED_IMAGE_PROVIDER,
  beatsWithoutPicture,
  generatedImageDecision,
  generatedImagePrompt,
  generatedStillSec,
} from "./generatedImageFallback";
import { CHAPTER_CARD_FALLBACK } from "./cinematicEditingEngine/motionGraphicsPlanner";
import {
  buildCinematicSceneInputs,
  dataOrMapGraphicForBeat,
  intentFrom,
  type ProductionBeat,
  type SceneFacts,
} from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import { renderTimeline } from "./timelineRenderer";
import { resolveFFmpegBin } from "./ffmpegBinary";
import { holdPictureUnderVoice, isGraphicBackdrop } from "./edlToTimeline";
import { isAIGeneratedClip } from "./documentaryStyle";
import {
  beatNamedEntitiesByKind,
  extractActionCue,
  extractPersonNamesFromText,
  extractVisualPlacePhrase,
} from "./videoPipeline";
import type { ProjectTimeline, TimelineVideoClip } from "./projectTimeline";

const PIPELINE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const EXTRACTORS = {
  people: (t: string) => extractPersonNamesFromText(t),
  place: (t: string) => extractVisualPlacePhrase(t),
  action: (t: string) => extractActionCue(t),
  namedEntities: (t: string) => beatNamedEntitiesByKind(t),
};
const beat = (index: number, text: string): ProductionBeat => ({
  index, text, searchQuery: "", powerWord: "", keywords: [], holdSec: 4, visualDescription: "",
  voiceStartSec: index * 4, voiceEndSec: index * 4 + 4,
});
/** What `fetchBeatGeneratedImage` asks, from the sentence alone (no picture, budget left). */
const decisionFor = (text: string) => {
  const intent = intentFrom(beat(0, text), 0, 0, null, EXTRACTORS);
  return generatedImageDecision({
    hasPicture: false,
    graphicCanStandIn: dataOrMapGraphicForBeat(intent, undefined, 0, 4) !== null,
    people: intent.people,
    budgetLeft: 3,
  });
};
const ALLOWED = { hasPicture: false, graphicCanStandIn: false, people: [] as string[], forbidden: [] as string[], budgetLeft: 3 };

/* ═══════════════════════ 1 — no usable picture: a generated image may be used ═══════════════════════ */

describe("1 — no existing picture → a generated image is chosen", () => {
  it("a sentence with no picture, no graphic stand-in, no person and budget left may be generated", () => {
    expect(generatedImageDecision(ALLOWED)).toEqual({ generate: true });
    expect(decisionFor("Scientists edited a single gene to treat the disease.")).toEqual({ generate: true });
  });

  it("a named event is not a person: \"The Marshall Plan\" may be generated", () => {
    expect(generatedImageDecision({ ...ALLOWED, people: ["Marshall Plan"] })).toEqual({ generate: true });
  });

  it("only the sentences without a clip are asked", () => {
    const beats = [{ index: 0 }, { index: 1 }, { index: 2 }];
    expect(beatsWithoutPicture(beats, [0, 2]).map((b) => b.index)).toEqual([1]);
  });

  it("the pass runs after every source and the main-subject rescue, before the film-without-picture check", () => {
    const pass = PIPELINE.indexOf("await generateMissingBeatImages(scenes, sceneVisualResults, visualDedup, workDir, topicContext);");
    expect(pass).toBeGreaterThan(-1);
    expect(PIPELINE.lastIndexOf("} // end for (chunk of chunks)", pass)).toBeGreaterThan(PIPELINE.lastIndexOf("[MainSubject] Scene", pass));
    expect(PIPELINE.indexOf("const firstEmptySi = filmWithoutPictureRefusal(", pass)).toBeGreaterThan(pass);
  });

  it("the generated still goes through adoptClip — the same gates and picture editor — and is logged", () => {
    const body = PIPELINE.slice(PIPELINE.indexOf("async function fetchBeatGeneratedImage("));
    const fn = body.slice(0, body.indexOf("\n}\n"));
    expect(fn).toContain("adoptClip(offered, dedup, sceneIndex, beat.index, sentence, workDir");
    expect(fn).toContain("[${GENERATED_IMAGE_FALLBACK}] ${where} used provider=");
    /** Not a filename the metadata judge reads as stock AI footage: the picture editor decides. */
    expect(isAIGeneratedClip(`/w/scene_0_genimg_b1__pid_${GENERATED_IMAGE_PROVIDER}-0123abcd.mp4`)).toBe(false);
  });
});

/* ═══════════════════════ 2 — an existing picture always wins ═══════════════════════ */

describe("2 — a good existing picture → no AI generation", () => {
  it("a sentence with an approved picture is never generated", () => {
    expect(generatedImageDecision({ ...ALLOWED, hasPicture: true })).toEqual({ generate: false, reason: "has_picture" });
    expect(beatsWithoutPicture([{ index: 0 }, { index: 1 }], [0, 1])).toEqual([]);
  });

  it("the pass asks only sentences no clip was pushed for, so a found picture is never replaced", () => {
    const body = PIPELINE.slice(PIPELINE.indexOf("async function generateMissingBeatImages("));
    expect(body.slice(0, body.indexOf("\n}\n"))).toContain("beatsWithoutPicture(beats, result?.clipBeatIndices ?? [])");
  });
});

/* ═══════════════════════ 3 — a data graphic or map comes before generation ═══════════════════════ */

describe("3 — a data/map graphic → no AI generation", () => {
  it("a sentence whose figure can be drawn gets the data graphic, not a generated image", () => {
    const inflation = intentFrom(beat(0, "Inflation reached 10% in 2022."), 0, 0, null, EXTRACTORS);
    const canStandIn = dataOrMapGraphicForBeat(inflation, undefined, 0, 4) !== null;
    expect(canStandIn).toBe(true);
    expect(generatedImageDecision({ ...ALLOWED, graphicCanStandIn: canStandIn })).toEqual({ generate: false, reason: "graphic_stands_in" });
    expect(decisionFor("Inflation reached 10% in 2022.")).toEqual({ generate: false, reason: "graphic_stands_in" });
  });

  it("production asks the same graphic check before generating", () => {
    const body = PIPELINE.slice(PIPELINE.indexOf("async function fetchBeatGeneratedImage("));
    expect(body.slice(0, body.indexOf("\n}\n"))).toContain("graphicCanStandIn: dataOrMapGraphicForBeat(intent, scene,");
  });
});

/* ═══════════════════════ 5 — unsuitable content → the chapter card ═══════════════════════ */

describe("5 — too little or unsuitable content → no generation, the chapter card", () => {
  it("no likeness of a real person, nothing the plan forbids, and a bounded number per film", () => {
    expect(generatedImageDecision({ ...ALLOWED, people: ["Winston Churchill"] })).toEqual({ generate: false, reason: "names_a_person" });
    expect(generatedImageDecision({ ...ALLOWED, forbidden: ["modern footage", "AI generated"] })).toEqual({ generate: false, reason: "plan_forbids_ai" });
    expect(generatedImageDecision({ ...ALLOWED, budgetLeft: 0 })).toEqual({ generate: false, reason: "film_budget_spent" });
  });

  it("a sentence and plan that name too little to show get no generated image (no generic picture)", () => {
    expect(generatedImagePrompt({ sentence: "It was just that.", visualDescription: "documentary broll scene" })).toBeNull();
    expect(generatedImagePrompt({ sentence: "Why?" })).toBeNull();
  });

  it("such a sentence, left without a clip, gets the existing chapter card — logged CHAPTER_CARD_FALLBACK", () => {
    const text = "Winston Churchill refused to surrender.";
    expect(decisionFor(text)).toEqual({ generate: false, reason: "names_a_person" });
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      const built = buildCinematicSceneInputs({
        scenes: [{
          scene: { index: 0, text, visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 4 },
          beats: [beat(0, text)],
          clips: [null] as SceneFacts["clips"],
        }],
        extractors: EXTRACTORS,
      });
      const card = built.primaryGraphics?.[0]?.graphic;
      expect(card?.graphicType).toBe("chapter_card");
      expect(card?.reason.startsWith(CHAPTER_CARD_FALLBACK)).toBe(true);
    } finally {
      console.log = log;
    }
    expect(logs.some((l) => l.startsWith(`[${CHAPTER_CARD_FALLBACK}] s0b0`))).toBe(true);
    expect(logs.some((l) => l.includes("GENERATED_IMAGE_FALLBACK"))).toBe(false);
  });
});

/* ═══════════════════════ 4 — the sentence and its VisualIntent are the prompt ═══════════════════════ */

describe("4 — the generated image uses the sentence + VisualIntent", () => {
  it("\"The Marshall Plan helped rebuild Europe…\" asks for the rebuilding, not a card with the name", () => {
    const prompt = generatedImagePrompt({
      sentence: "The Marshall Plan helped rebuild Europe after World War II.",
      visualDescription: "workers rebuilding bombed European city streets with aid shipments in the late 1940s",
    })!;
    expect(prompt).toContain("workers rebuilding bombed European city streets with aid shipments in the late 1940s");
    expect(prompt).toContain('"The Marshall Plan helped rebuild Europe after World War II."');
    expect(prompt).toMatch(/No text, no letters, no captions/);
  });

  it("the prompt carries the director's description and the exact sentence", () => {
    const prompt = generatedImagePrompt({
      sentence: "Scientists cut a single gene inside a living cell.",
      visualDescription: "a scientist editing DNA under a microscope in a laboratory",
      searchQuery: "CRISPR gene editing laboratory",
    })!;
    expect(prompt).toContain("a scientist editing DNA under a microscope in a laboratory");
    expect(prompt).toContain("CRISPR gene editing laboratory");
    expect(prompt).toContain('"Scientists cut a single gene inside a living cell."');
    expect(prompt).toMatch(/not a photograph/i);
    expect(prompt).toMatch(/no recognisable real person/i);
  });

  it("without a plan the sentence alone is the subject", () => {
    expect(generatedImagePrompt({ sentence: "Farmers lost their harvest to the drought." })).toContain("Farmers lost their harvest to the drought.");
  });

});

/* ═══════════════════════ 6 — the generated still in the timeline and the MP4 ═══════════════════════ */

describe("6 — a generated still reaches a real MP4 as the sentence's visual", () => {
  const W = 1280;
  const H = 720;
  let dir = "";
  let red = "";
  let blue = "";
  let timeline: ProjectTimeline;
  let out = "";

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "genimg-"));
    red = path.join(dir, "red.mp4");
    blue = path.join(dir, "scene_0_genimg_b1__pid_stability-0123abcd.mp4");
    for (const [file, colour] of [[red, "red"], [blue, "blue"]] as const) {
      await promisify(execFile)(resolveFFmpegBin(), [
        "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${colour}:s=${W}x${H}:d=8:r=12`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
      ]);
    }
    const texts = ["The drought began in spring.", "Farmers lost their harvest to the drought."];
    const beats = texts.map((t, i) => beat(i, t));
    const facts: SceneFacts = {
      scene: { index: 0, text: texts.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8 },
      beats,
      clips: [
        {
          facts: { localPath: red, durationSec: 8, widthPx: W, heightPx: H },
          adoption: { provider: "internet_archive", providerAssetId: "ia-0", sourceUrl: "https://archive.invalid/0.mp4", assetTitle: "drought", query: "drought" },
        },
        /** What `generateMissingBeatImages` pushes: the generated still, adopted under its own sentence. */
        {
          facts: { localPath: blue, durationSec: 8, widthPx: W, heightPx: H },
          adoption: { provider: GENERATED_IMAGE_PROVIDER, providerAssetId: "0123abcd", sourceUrl: null, assetTitle: "farmers in a dry field", query: "farmers drought" },
        },
      ] as SceneFacts["clips"],
    };
    const built = buildCinematicSceneInputs({ scenes: [facts], extractors: EXTRACTORS });
    timeline = runCinematicPipeline({ videoId: 1, scenes: built.scenes, includeSubtitles: false }).timeline as ProjectTimeline;
    timeline.format = { ...timeline.format, widthPx: W, heightPx: H, fps: 12 };
    delete timeline.look;
    for (const track of timeline.tracks) {
      if (track.kind === "SFX" || track.kind === "AMBIENT" || track.kind === "MUSIC" || track.kind === "VOICE") track.clips = [];
      if (track.kind === "TEXT") track.texts = [];
      if (track.kind === "CAPTIONS") track.captions = [];
      if (track.kind === "GRAPHICS") track.graphics = [];
    }
    out = path.join(dir, "film.mp4");
    await renderTimeline({
      timeline,
      workDir: path.join(dir, "work"),
      outputPath: out,
      resolveMedia: async (clip) => (clip.source.provider === GENERATED_IMAGE_PROVIDER ? blue : red),
    });
  }, 600_000);

  afterAll(() => {
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp dir is not a test failure */
    }
  });

  it("the timeline carries the generated still as a normal clip under sentence 2, no graphic stand-in", () => {
    const video = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clips = video && video.kind === "VIDEO" ? video.clips : [];
    const generated = clips.find((c) => c.source.provider === GENERATED_IMAGE_PROVIDER);
    expect(generated, "the generated still is not on the VIDEO track").toBeDefined();
    expect(generated!.beatIndex).toBe(1);
    expect(generated!.timelineStart).toBeCloseTo(4, 2);
    /** The whole sentence (4–8 s), no other shot inside it. */
    expect(generated!.timelineEnd).toBeCloseTo(8, 2);
    expect(clips.some(isGraphicBackdrop)).toBe(false);
    expect(clips.some((c) => /_fill\d+$/.test(c.id))).toBe(false);
  });

  it("the still is made as long as the sentence is spoken, plus a second", () => {
    expect(generatedStillSec({ holdSec: 4, voiceStartSec: 10, voiceEndSec: 17.5 })).toBe(8.5);
    expect(generatedStillSec({ holdSec: 6 })).toBe(7);
  });

  it("the rendered MP4 shows the generated picture under its sentence and the real shot under the other", async () => {
    const colourAt = async (sec: number) => {
      const raw = path.join(dir, `f${sec}.raw`);
      await promisify(execFile)(resolveFFmpegBin(), [
        "-y", "-hide_banner", "-loglevel", "error", "-ss", String(sec), "-i", out,
        "-frames:v", "1", "-vf", "scale=16:9", "-f", "rawvideo", "-pix_fmt", "rgb24", raw,
      ]);
      const px = fs.readFileSync(raw);
      let r = 0, b = 0;
      for (let i = 0; i + 2 < px.length; i += 3) { r += px[i]!; b += px[i + 2]!; }
      return { r, b };
    };
    const first = await colourAt(2);
    const second = await colourAt(6);
    expect(first.r).toBeGreaterThan(first.b * 3);
    expect(second.b).toBeGreaterThan(second.r * 3);
  });
});

/* ═══════════════════════ 7 — never lent to another sentence ═══════════════════════ */

describe("7 — a generated still is never lent to another sentence as a _fill", () => {
  const shot = (id: string, start: number, end: number, provider: string, beatIndex: number): TimelineVideoClip => ({
    id, kind: "video", source: { provider, providerAssetId: id, mediaUrl: `https://x/${id}.mp4` },
    timelineStart: start, timelineEnd: end, motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut",
    previewSource: "asset", sceneIndex: 0, beatIndex,
  });
  /** a (0–4 s), a hole from 4 to 13 s, then d; g and h elsewhere in the film. */
  const film = (provider: string) => [
    shot("a", 0, 4, "loc", 0), shot("d", 13, 17, "loc", 3), shot("g", 20, 24, provider, 5), shot("h", 24, 28, provider, 6),
  ];

  it("a hole the fill would cover with other shots is not covered with a generated still", () => {
    const clips = film(GENERATED_IMAGE_PROVIDER);
    holdPictureUnderVoice({ clips, voiceDurationSec: 28 });
    const fills = clips.filter((c) => /_fill\d+$/.test(c.id));
    expect(fills.some((c) => c.id.startsWith("g_") || c.id.startsWith("h_"))).toBe(false);
    expect(fills.every((c) => c.source.provider !== GENERATED_IMAGE_PROVIDER)).toBe(true);
  });

  it("the same film with real shots there is filled as before (the rule only takes generated stills out)", () => {
    const clips = film("loc");
    holdPictureUnderVoice({ clips, voiceDurationSec: 28 });
    expect(clips.some((c) => /^(g|h)_fill\d+$/.test(c.id))).toBe(true);
  });
});
