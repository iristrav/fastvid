/**
 * A GENERATED PICTURE IS PAID FOR ONLY WHEN IT CAN BE USED.
 *
 * Production, 12–13 October: every generated picture was refused before it reached the film.
 *
 *   649 s0b0  17:21:49  [BeatShortlist] stopped looking — shortlist spent  → "generated, but not approved"
 *   651 s1b0  13:06:11  [BeatShortlist] stopped looking — shortlist spent  → "generated, but not approved"
 *   651 s1b0  14:57:33  [BeatShortlist] stopped looking — shortlist spent  → "generated, but not approved"
 *   652 s1b0  19:51:41  judge:UNREVIEWED (OpenAI cooled down)            → "generated, but not approved"
 *
 * Nothing approved was lost after approval; the loss is BEFORE the look: a picture made for a
 * sentence whose looks were already spent (or while nobody could look) is never put to the picture
 * editor. The pass now asks first. Approval, the technical gate and the placement are unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateMissingBeatImages } from "./videoPipeline";
import { beatsWithoutPicture, setStillImageGeneratorForTests } from "./generatedImageFallback";
import { admitToShortlist, beatShortlistExhausted, createBeatShortlistState, maxShortlistPerBeat } from "./beatShortlist";
import { GENERATED_IMAGE_PROVIDER } from "./generatedImageFallback";
import { GENERATED_VIDEO_PROVIDER } from "./elevenLabsVideoGeneration";
import { REPLICATE_VIDEO_PROVIDER } from "./replicateVideoGeneration";
import { sentenceCoverage } from "./sentenceCoverage";
import { deliveryGate } from "./deliveryGate";
import { emptyTimeline, videoTrack, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const bodyOf = (name: string) => {
  const at = PIPE.indexOf(name);
  return PIPE.slice(at, PIPE.indexOf("\n}\n", at));
};

const SENTENCE = "The harvest failed that summer.";
const beat = {
  index: 0, text: SENTENCE, searchQuery: "dry wheat field drought", powerWord: "", keywords: [], holdSec: 4,
  visualDescription: "aerial view of a dry wheat field under a hot sun",
};

describe("a generated picture is not paid for when the sentence's looks are spent", () => {
  let videoCalls = 0;
  let stillCalls = 0;
  beforeEach(async () => {
    videoCalls = 0;
    stillCalls = 0;
    vi.stubEnv("ELEVENLABS_VIDEO_API_KEY", "test-key-not-real");
    vi.stubEnv("REPLICATE_API_TOKEN", "");
    const { setVideoClipGeneratorForTests } = await import("./elevenLabsVideoGeneration");
    setVideoClipGeneratorForTests(async () => {
      videoCalls++;
      return false;
    });
    setStillImageGeneratorForTests(async () => {
      stillCalls++;
      return false;
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    const { setVideoClipGeneratorForTests } = await import("./elevenLabsVideoGeneration");
    setVideoClipGeneratorForTests(null);
    setStillImageGeneratorForTests(null);
  });

  const run = async (spentLooks: number) => {
    const shortlist = createBeatShortlistState();
    for (let i = 0; i < spentLooks; i++) admitToShortlist(shortlist, 0, 0, `youtube_cc:v${i}@t0d4`);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    try {
      await generateMissingBeatImages(
        [{ index: 0, text: SENTENCE, isChapterCard: false }] as never,
        [{ clips: [], beatDurations: [], clipBeatIndices: [] }] as never,
        { sceneBeatsBySceneIndex: new Map([[0, [beat]]]), beatImageGate: { askImpossible: false }, beatShortlist: shortlist } as never,
        "/tmp/video652-looks-spent",
        undefined
      );
    } finally {
      spy.mockRestore();
    }
    return { logs, shortlist };
  };

  it("looks spent → neither ElevenLabs nor the still generator is asked, and the log says why", async () => {
    const { logs, shortlist } = await run(maxShortlistPerBeat());
    expect(beatShortlistExhausted(shortlist, 0, 0)).toBe(true);
    expect(videoCalls).toBe(0);
    expect(stillCalls).toBe(0);
    expect(logs).toContain(
      `[GENERATED_IMAGE_FALLBACK] s0b0 not generated — the sentence's ${maxShortlistPerBeat()} looks are spent, so nobody could approve a generated picture`
    );
  });

  it("a look left → the existing order is unchanged: ElevenLabs first, then the still", async () => {
    const { logs } = await run(maxShortlistPerBeat() - 1);
    expect(videoCalls).toBe(1);
    expect(stillCalls).toBe(1);
    expect(logs.some((l) => l.includes("looks are spent"))).toBe(false);
  });

  it("no shortlist recorded at all (state absent) → not treated as spent", async () => {
    expect(beatShortlistExhausted(undefined, 0, 0)).toBe(false);
  });
});

describe("what happens to a generated picture after it is made (unchanged, proven here)", () => {
  it("it goes through the one adoptClip — technical gate and picture editor — never around it", () => {
    for (const fn of ["async function fetchBeatGeneratedImage(", "async function fetchBeatElevenLabsVideo(", "async function fetchBeatReplicateVideo("]) {
      const body = bodyOf(fn);
      expect(body, fn).toContain("adoptClip(offered, dedup, sceneIndex, beat.index, sentence, workDir,");
      expect(body, fn).toContain("generated, but not approved for the sentence — not used");
    }
  });

  it("an adopted generated picture is pushed under its own sentence, which then has a picture", () => {
    const gen = bodyOf("export async function generateMissingBeatImages(");
    expect(gen).toContain("target.clips.push(clip);");
    expect(gen).toContain("(target.clipBeatIndices ??= []).push(beat.index);");
    /** A sentence with a pushed clip is no longer asked by any later fallback. */
    expect(beatsWithoutPicture([{ index: 0 }, { index: 1 }], [0])).toEqual([{ index: 1 }]);
  });

  it("the generic moving floor runs after it and only for sentences still without a picture, so it never displaces it", () => {
    const gen = PIPE.indexOf("await generateMissingBeatImages(scenes, sceneVisualResults, visualDedup, workDir, topicContext);");
    const floor = PIPE.indexOf("await placeGenericMovingFallbacks(");
    expect(gen).toBeGreaterThan(0);
    expect(floor).toBeGreaterThan(gen);
    expect(bodyOf("export async function placeGenericMovingFallbacks(")).toContain(
      "for (const beat of beatsWithoutPicture(beats, result?.clipBeatIndices ?? [])) {"
    );
  });

  it("the stop checks come before any generation and leave the approval rules as they were", () => {
    const gen = bodyOf("export async function generateMissingBeatImages(");
    const spent = gen.indexOf("if (beatShortlistExhausted(dedup.beatShortlist, si, beat.index)) {");
    const ask = gen.indexOf("const clip = await fetchBeatGeneratedImage(");
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(ask);
    expect(gen.slice(spent, ask)).toContain("continue;");
  });
});

/* ═══════════ on the timeline: an approved generated picture covers its sentence, an unjudged one does not ═══════════ */

describe("a generated picture on the timeline, for every AI route", () => {
  const clip = (provider: string, approved: boolean): TimelineVideoClip =>
    ({
      id: `g-${provider}`, kind: "video",
      source: { provider, providerAssetId: `g-${provider}`, archiveAssetId: 9, ...(approved ? { contentApproval: "judge_fit" } : {}) },
      sourceIn: 0, sourceOut: 5, timelineStart: 0, timelineEnd: 5,
      motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset", sceneIndex: 0, beatIndex: 0,
    }) as TimelineVideoClip;
  const timelineWith = (c: TimelineVideoClip): ProjectTimeline => {
    const t = emptyTimeline(652);
    t.durationSec = 5;
    videoTrack(t).push(c);
    t.sentences = [{ sceneIndex: 0, beatIndex: 0, startSec: 0, endSec: 5, timingBasis: "measured", text: SENTENCE }];
    return t as ProjectTimeline;
  };

  for (const provider of [GENERATED_IMAGE_PROVIDER, GENERATED_VIDEO_PROVIDER, REPLICATE_VIDEO_PROVIDER]) {
    it(`${provider}: approved for its sentence → the sentence is covered, named as AI footage, and the delivery gate allows it`, () => {
      const cov = sentenceCoverage(timelineWith(clip(provider, true)));
      expect(cov.sentences[0]).toMatchObject({ status: "covered", approvedFootageSec: 5, aiGeneratedSec: 5 });
      expect(cov.sentences[0]!.kinds).toContain("ai_generated_footage");
      const gate = deliveryGate({
        videoId: 652, route: "cinematic_timeline", timelineExists: true, assetsOnly: true, delivered: null,
        clips: [{ clipId: `g-${provider}`, archiveAssetId: 9, provider, providerAssetId: `g-${provider}`, resolved: true, fromArchive: true, isPlaceholder: false }],
        sentenceCoverage: cov,
      });
      expect(gate.allow, gate.allow ? "" : JSON.stringify(gate.failures)).toBe(true);
    });

    it(`${provider}: without the picture editor's approval it is NOT cover — nothing unjudged is forced through`, () => {
      const cov = sentenceCoverage(timelineWith(clip(provider, false)));
      expect(cov.sentences[0]!.status).not.toBe("covered");
      expect(cov.sentences[0]!.approvedFootageSec).toBe(0);
    });
  }
});
