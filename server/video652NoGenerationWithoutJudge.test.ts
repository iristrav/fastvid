/**
 * VIDEO 652 — NO PAID AI GENERATION WHILE NOBODY CAN APPROVE THE RESULT.
 *
 * OpenAI's quota ran out at 19:48:48 (`[BeatImageGate] THIS RENDER HAS NO PICTURE EDITOR`), and the
 * generated-image pass still asked Stability for s1b0 and s1b5 and started ElevenLabs at 19:51:41.
 * Every generated picture was then refused as "generated, but not approved". The pass now stops on
 * the two signals the adoption guard already reads; the approval rules are not touched.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vision = vi.hoisted(() => ({ unavailable: false }));
vi.mock("./visualQualityGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./visualQualityGate")>()),
  visionPipelineIsUnavailable: () => vision.unavailable,
}));

import { generateMissingBeatImages } from "./videoPipeline";
import { pictureEditorUnavailableReason, setStillImageGeneratorForTests } from "./generatedImageFallback";

/** A sentence whose figure a data graphic can show: `fetchBeatGeneratedImage` answers it without any request. */
const SENTENCE = "Inflation reached 10% in 2022.";
const scene = { index: 0, text: SENTENCE, isChapterCard: false };
const beat = { index: 0, text: SENTENCE, searchQuery: "", powerWord: "", keywords: [], holdSec: 4, visualDescription: "" };

type Run = { logs: string[]; results: Array<{ clips: string[]; beatDurations: number[]; clipBeatIndices: number[] }> };
async function runPass(askImpossible: boolean): Promise<Run> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  const results = [{ clips: [] as string[], beatDurations: [] as number[], clipBeatIndices: [] as number[] }];
  const dedup = {
    sceneBeatsBySceneIndex: new Map([[0, [beat]]]),
    beatImageGate: { askImpossible },
  };
  try {
    await generateMissingBeatImages([scene] as never, results as never, dedup as never, "/tmp/video652-no-judge", undefined);
  } finally {
    spy.mockRestore();
  }
  return { logs, results };
}

/** `fetchBeatGeneratedImage` always says why a sentence was not generated; that line proves it was asked. */
const askedTheGenerator = (r: Run) => r.logs.some((l) => /\[GENERATED_IMAGE_FALLBACK\] s0b0 not generated/.test(l));

describe("VIDEO 652 — the generated-image pass stops when the picture editor is unavailable", () => {
  let stillCalls = 0;
  beforeEach(() => {
    vision.unavailable = false;
    stillCalls = 0;
    setStillImageGeneratorForTests(async () => {
      stillCalls++;
      return null;
    });
  });
  afterEach(() => setStillImageGeneratorForTests(null));

  it("1. askImpossible = true → fetchBeatGeneratedImage is never called, nothing is generated", async () => {
    const r = await runPass(true);
    expect(askedTheGenerator(r)).toBe(false);
    expect(stillCalls).toBe(0);
    expect(r.results[0]!.clips).toEqual([]);
  });

  it("2. the vision pipeline is unavailable → fetchBeatGeneratedImage is never called", async () => {
    vision.unavailable = true;
    const r = await runPass(false);
    expect(askedTheGenerator(r)).toBe(false);
    expect(stillCalls).toBe(0);
    expect(r.results[0]!.clips).toEqual([]);
  });

  it("3. both signals false → the existing behaviour: the sentence is asked, its own rules decide", async () => {
    const r = await runPass(false);
    expect(askedTheGenerator(r)).toBe(true);
    expect(r.logs.some((l) => l.includes("graphic_stands_in"))).toBe(true);
    expect(r.logs.some((l) => l.includes("stopped —"))).toBe(false);
  });

  it("4. the reason for stopping is named in the log", async () => {
    const judge = await runPass(true);
    expect(judge.logs).toContain(
      "[GENERATED_IMAGE_FALLBACK] stopped — the picture editor cannot be reached in this render (judge unavailable); nothing is generated, the sentences keep their fallbacks"
    );
    vision.unavailable = true;
    const clip = await runPass(false);
    expect(clip.logs).toContain(
      "[GENERATED_IMAGE_FALLBACK] stopped — the vision pipeline is unavailable in this process; nothing is generated, the sentences keep their fallbacks"
    );
  });
});

describe("VIDEO 652 — the stop reason itself", () => {
  it("names each signal, and is null only when the picture editor can be asked", () => {
    expect(pictureEditorUnavailableReason({ visionPipelineUnavailable: false, askImpossible: false })).toBeNull();
    expect(pictureEditorUnavailableReason({ visionPipelineUnavailable: false, askImpossible: true })).toMatch(/judge unavailable/);
    expect(pictureEditorUnavailableReason({ visionPipelineUnavailable: true, askImpossible: false })).toMatch(/vision pipeline is unavailable/);
    expect(pictureEditorUnavailableReason({ visionPipelineUnavailable: true, askImpossible: true })).not.toBeNull();
  });

  it("in production the stop sits beside the existing stops, before the generator is asked, and returns", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const loop = PIPE.slice(PIPE.indexOf("export async function generateMissingBeatImages("));
    const body = loop.slice(0, loop.indexOf("\n}\n"));
    const standingDown = body.indexOf("if (imageServiceStandingDown()) {");
    const stop = body.indexOf("const noJudge = pictureEditorUnavailableReason({");
    const ask = body.indexOf("const clip = await fetchBeatGeneratedImage(");
    expect(standingDown).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(standingDown);
    expect(stop).toBeLessThan(ask);
    expect(body.slice(stop, ask)).toContain("visionPipelineUnavailable: visionPipelineIsUnavailable(),");
    expect(body.slice(stop, ask)).toContain("askImpossible: dedup.beatImageGate?.askImpossible === true,");
    expect(body.slice(stop, ask)).toContain("return;");
  });
});

/* ═══════════ ElevenLabs: the only route to it runs through the same pass ═══════════ */

/**
 * `fetchBeatGeneratedVideo` (ElevenLabs first, Replicate second) is called from exactly one place,
 * `fetchBeatGeneratedImage`, which is called from exactly one place, `generateMissingBeatImages`.
 * So the stop above also keeps ElevenLabs from being asked. Mocked generator, no request is sent.
 */
describe("VIDEO 652 — ElevenLabs video is not asked during a judging outage, and stays available otherwise", () => {
  const FIELD = "The harvest failed that summer.";
  const fieldBeat = {
    index: 0, text: FIELD, searchQuery: "dry wheat field drought", powerWord: "", keywords: [], holdSec: 4,
    visualDescription: "aerial view of a dry wheat field under a hot sun",
  };
  let videoCalls = 0;
  beforeEach(async () => {
    vision.unavailable = false;
    videoCalls = 0;
    vi.stubEnv("ELEVENLABS_VIDEO_API_KEY", "test-key-not-real");
    vi.stubEnv("REPLICATE_API_TOKEN", "");
    const { setVideoClipGeneratorForTests } = await import("./elevenLabsVideoGeneration");
    setVideoClipGeneratorForTests(async () => {
      videoCalls++;
      return false;
    });
    setStillImageGeneratorForTests(async () => false);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    const { setVideoClipGeneratorForTests } = await import("./elevenLabsVideoGeneration");
    setVideoClipGeneratorForTests(null);
    setStillImageGeneratorForTests(null);
  });

  const run = async (askImpossible: boolean) => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await generateMissingBeatImages(
        [{ index: 0, text: FIELD, isChapterCard: false }] as never,
        [{ clips: [], beatDurations: [], clipBeatIndices: [] }] as never,
        { sceneBeatsBySceneIndex: new Map([[0, [fieldBeat]]]), beatImageGate: { askImpossible } } as never,
        "/tmp/video652-elevenlabs",
        undefined
      );
    } finally {
      spy.mockRestore();
    }
  };

  it("the code has one route to ElevenLabs: generateMissingBeatImages → fetchBeatGeneratedImage → fetchBeatGeneratedVideo → fetchBeatElevenLabsVideo", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE.match(/await fetchBeatGeneratedVideo\(/g)).toHaveLength(1);
    expect(PIPE.match(/await fetchBeatGeneratedImage\(/g)).toHaveLength(1);
    const image = PIPE.slice(PIPE.indexOf("async function fetchBeatGeneratedImage("));
    expect(image.slice(0, image.indexOf("\n}\n"))).toContain("await fetchBeatGeneratedVideo(");
    /** The dispatcher asks ElevenLabs first, Replicate second; nothing else calls the ElevenLabs rung. */
    expect(PIPE.match(/await fetchBeatElevenLabsVideo\(/g)).toHaveLength(1);
    const video = PIPE.slice(PIPE.indexOf("async function fetchBeatGeneratedVideo("));
    expect(video.slice(0, video.indexOf("\n}\n"))).toContain("await fetchBeatElevenLabsVideo(");
  });

  it("askImpossible = true → the ElevenLabs generator is never called", async () => {
    await run(true);
    expect(videoCalls).toBe(0);
  });

  it("vision pipeline unavailable → the ElevenLabs generator is never called", async () => {
    vision.unavailable = true;
    await run(false);
    expect(videoCalls).toBe(0);
  });

  it("the picture editor available → ElevenLabs is still asked first, exactly once (fallback kept)", async () => {
    await run(false);
    expect(videoCalls).toBe(1);
  });
});
