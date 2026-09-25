/**
 * A YOUTUBE SHOT IS AT MOST FIVE SECONDS, AND IT IS ONE SHOT — RONDE 647.
 *
 * Video 604: one YouTube fragment (archive asset 57820, 30.6 s) held for 40.16 s, looped by the
 * renderer. The operator's rule:
 *
 *   §1  a YouTube shot is on screen for at most 5 s; the neighbouring NON-YouTube shot in the same
 *       scene takes the rest
 *   §2  a scene with no such shot cuts the fragment into pieces of at most 5 s from different
 *       moments, repeating only when the fragment runs out
 *   §3  no piece holds a hard cut of the original video
 *   §4  the real timeline builder applies it, and the validator accepts what it builds
 *   §5  the cuts are measured with the archive splitter's own detector, on a real file
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  YOUTUBE_MAX_SHOT_SEC,
  limitYoutubeShots,
  planYoutubePieces,
  shotSegments,
  type YoutubeSourceFacts,
} from "./youtubeShotLimit";
import { isYoutubeOrigin, productionShotCutDeps, youtubeSourceFactsFor } from "./youtubeShotCuts";
import { translateEdl } from "./edlToTimeline";
import { validateTimeline, NON_BLOCKING_ISSUES } from "./timelineValidator";
import type { TimelineVideoClip } from "./projectTimeline";
import type { EditDecision } from "./cinematicEditingEngine/types";
import { resolveFFmpegBin } from "./ffmpegBinary";

const run = promisify(execFile);
const oneShot = (sourceDurationSec: number): YoutubeSourceFacts => ({
  sourceDurationSec,
  cutsSec: [],
  measured: true,
});

const clip = (
  id: string,
  start: number,
  end: number,
  sceneIndex = 0,
  over: Partial<TimelineVideoClip> = {}
): TimelineVideoClip => ({
  id,
  kind: "video",
  source: { provider: "ww2", archiveAssetId: 1 },
  sourceIn: 0,
  timelineStart: start,
  timelineEnd: end,
  motion: "none",
  transitionIn: "hard_cut",
  transitionOut: "hard_cut",
  previewSource: "asset",
  sceneIndex,
  ...over,
});

const covers = (clips: TimelineVideoClip[]) => ({
  start: Math.min(...clips.map((c) => c.timelineStart)),
  end: Math.max(...clips.map((c) => c.timelineEnd)),
});

/* ═══════════ §1 ═══════════ */

describe("§1 — the neighbour in the same scene takes the time over five seconds", () => {
  it("VIDEO 604's shape: 40.16 s of YouTube followed by a stock shot", () => {
    const yt = clip("yt", 20.23, 60.39, 1, { sourceIn: 2 });
    const stock = clip("stock", 60.39, 65.95, 1, { source: { provider: "pexels", providerAssetId: "8382393" } });
    const { clips, notes } = limitYoutubeShots({
      clips: [yt, stock],
      youtube: new Map([["yt", oneShot(30.6)]]),
    });
    expect(clips).toHaveLength(2);
    expect(clips[0]!.timelineEnd - clips[0]!.timelineStart).toBeCloseTo(5, 3);
    expect(clips[1]!.timelineStart).toBeCloseTo(25.23, 3);
    expect(clips[1]!.timelineEnd).toBeCloseTo(65.95, 3);
    expect(covers(clips)).toEqual({ start: 20.23, end: 65.95 });
    expect(notes.join(" ")).toContain("starts 35.16s earlier");
  });

  it("the shot BEFORE takes it when the one after is YouTube too, or absent", () => {
    const wiki = clip("wiki", 0, 4, 0, { kind: "image", source: { provider: "wikimedia", providerAssetId: "x" } });
    const yt = clip("yt", 4, 16, 0);
    const { clips } = limitYoutubeShots({ clips: [wiki, yt], youtube: new Map([["yt", oneShot(30)]]) });
    expect(clips[0]!.timelineEnd).toBeCloseTo(11, 3);
    expect(clips[1]!.timelineStart).toBeCloseTo(11, 3);
    expect(clips[1]!.timelineEnd).toBeCloseTo(16, 3);
    /** Its first frame is still the planned one. */
    expect(clips[1]!.sourceIn).toBe(0);
  });

  it("a neighbour in ANOTHER scene is never used", () => {
    const yt = clip("yt", 0, 12, 0);
    const other = clip("other", 12, 20, 1, { source: { provider: "loc", providerAssetId: "y" } });
    const { clips } = limitYoutubeShots({ clips: [yt, other], youtube: new Map([["yt", oneShot(30)]]) });
    expect(clips.find((c) => c.id === "other")!.timelineStart).toBe(12);
    /** The YouTube time stays in its scene: split, not handed across the boundary. */
    const pieces = clips.filter((c) => c.id.startsWith("yt"));
    expect(pieces.length).toBe(3);
    expect(pieces.every((c) => c.sceneIndex === 0)).toBe(true);
  });

  it("a YouTube shot of five seconds or less is left in place", () => {
    const yt = clip("yt", 0, 4.5, 0, { sourceIn: 3 });
    const { clips, notes } = limitYoutubeShots({ clips: [yt], youtube: new Map([["yt", oneShot(30)]]) });
    expect(clips).toEqual([{ ...yt, sourceOut: 7.5 }]);
    expect(notes).toEqual([]);
  });

  it("footage that is not YouTube is never touched, however long", () => {
    const long = clip("loc", 0, 40, 0);
    const { clips } = limitYoutubeShots({ clips: [long], youtube: new Map() });
    expect(clips).toEqual([long]);
  });
});

/* ═══════════ §2 ═══════════ */

describe("§2 — a scene with only YouTube: pieces from different moments", () => {
  it("12 s becomes three 4 s pieces, the first at the planned moment, none repeated", () => {
    const { pieces, notes } = planYoutubePieces({ inSec: 6, durationSec: 12, facts: oneShot(30) });
    expect(pieces.map((p) => p.durationSec)).toEqual([4, 4, 4]);
    expect(pieces[0]!.inSec).toBe(6);
    const ins = pieces.map((p) => p.inSec);
    for (let i = 0; i < ins.length; i++) {
      for (let j = i + 1; j < ins.length; j++) {
        expect(Math.abs(ins[i]! - ins[j]!), "two pieces show the same frames").toBeGreaterThanOrEqual(4 - 1e-6);
      }
    }
    expect(notes.join(" ")).not.toContain("repeat");
  });

  it("VIDEO 604 with no neighbour: 40.16 s from a 30.6 s fragment repeats, and says so", () => {
    const { pieces, notes } = planYoutubePieces({ inSec: 0, durationSec: 40.16, facts: oneShot(30.6) });
    expect(pieces).toHaveLength(9);
    expect(pieces.every((p) => p.durationSec <= YOUTUBE_MAX_SHOT_SEC)).toBe(true);
    expect(notes.join(" ")).toMatch(/\d+ repeat/);
  });

  it("every piece of the timeline is at most five seconds, and the span is unchanged", () => {
    const yt = clip("yt", 10, 31, 2, { transitionIn: "crossfade", transitionInSec: 0.6 });
    const { clips } = limitYoutubeShots({ clips: [yt], youtube: new Map([["yt", oneShot(60)]]) });
    expect(clips.length).toBe(5);
    for (const c of clips) expect(c.timelineEnd - c.timelineStart).toBeLessThanOrEqual(5 + 1e-6);
    expect(covers(clips)).toEqual({ start: 10, end: 31 });
    /** The planned dissolve stays on the first piece; the rest are cuts. */
    expect(clips[0]!.transitionIn).toBe("crossfade");
    expect(clips.slice(1).every((c) => c.transitionIn === "hard_cut")).toBe(true);
    expect(new Set(clips.map((c) => c.id)).size).toBe(clips.length);
  });
});

/* ═══════════ §3 ═══════════ */

describe("§3 — no piece holds a cut of the original", () => {
  it("the source splits into its shots", () => {
    expect(shotSegments({ sourceDurationSec: 30, cutsSec: [12, 3, 12], measured: true })).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 12 },
      { start: 12, end: 30 },
    ]);
  });

  it("a planned in-point whose window crosses a cut is moved inside the shot", () => {
    const facts = { sourceDurationSec: 30, cutsSec: [10], measured: true };
    const { pieces, notes } = planYoutubePieces({ inSec: 8, durationSec: 4, facts });
    /** RONDE 654 — and a quarter second clear of the cut, so its last frame is not the one before it. */
    expect(pieces).toEqual([{ inSec: 5.75, durationSec: 4 }]);
    expect(notes.join(" ")).toContain("so the piece holds no cut");
  });

  it("a moment inside a shot that is too short is replaced by one that fits", () => {
    const facts = { sourceDurationSec: 30, cutsSec: [2, 4, 20], measured: true };
    const { pieces } = planYoutubePieces({ inSec: 2.5, durationSec: 5, facts });
    const [p] = pieces;
    const segs = shotSegments(facts);
    const home = segs.find((s) => p!.inSec >= s.start && p!.inSec < s.end)!;
    expect(p!.inSec + p!.durationSec).toBeLessThanOrEqual(home.end + 1e-6);
  });

  it("no piece of a split ever straddles a cut", () => {
    const facts = { sourceDurationSec: 40, cutsSec: [7, 15.5, 22, 31], measured: true };
    const { pieces } = planYoutubePieces({ inSec: 5, durationSec: 20, facts });
    const segs = shotSegments(facts);
    for (const p of pieces) {
      const home = segs.find((s) => p.inSec >= s.start - 1e-6 && p.inSec < s.end);
      expect(home, `piece at ${p.inSec}`).toBeDefined();
      expect(p.inSec + p.durationSec).toBeLessThanOrEqual(home!.end + 1e-6);
    }
  });

  /**
   * RONDE 654 — the operator: "1 beeld zonder overgang naar een volgend beeld". A source nobody
   * measured may hold a cut anywhere, so it is no longer cut blind: it is refused, and the slot goes
   * to another shot (see youtubeCutsOnTheShot.test.ts).
   */
  it("a source whose length or cuts are unknown is refused rather than cut blind", () => {
    const plan = planYoutubePieces({
      inSec: 3,
      durationSec: 9,
      facts: { sourceDurationSec: 0, cutsSec: [], measured: false },
    });
    expect(plan.pieces).toEqual([]);
    expect(plan.refused).toContain("not measured");
  });
});

/* ═══════════ §4 ═══════════ */

describe("§4 — the real timeline builder applies it", () => {
  const decision = (beatId: string, startSec: number, endSec: number, sceneIndex = 0): EditDecision => ({
    beatId,
    sceneIndex,
    clip: {
      candidateId: `c:${beatId}`,
      assetType: "video",
      localPath: null,
      remoteUrl: "https://x/a.mp4",
      trimStartSec: 0,
      trimEndSec: endSec - startSec,
      startSec,
      endSec,
      timingSource: "tts_word_alignment",
    },
    shot: { shotType: "wide", reason: "r" } as EditDecision["shot"],
    camera: { movement: "none", intensity: 0, reason: "r" },
    transitionIn: { type: "cut", durationSec: 0, reason: "r" },
    captions: [],
    motionGraphics: [],
    effects: [],
    sounds: [],
    pacing: { tone: "measured", cutSpeedMultiplier: 1, movementIntensity: 0.3, reason: "r" },
  });

  it("a YouTube beat held under the narration is cut to five seconds, and the plan validates", () => {
    const yt = { provider: "ww2", archiveAssetId: 57820 };
    const stock = { provider: "pexels", providerAssetId: "8382393", archiveAssetId: 9001 };
    const { timeline, youtubeShots } = translateEdl({
      videoId: 1,
      voice: { url: "https://x/voice.mp3", durationSec: 30 },
      inputs: [
        { decision: decision("s0b0", 0, 4), sceneOffsetSec: 0, identity: stock },
        { decision: decision("s0b1", 4, 8), sceneOffsetSec: 0, identity: yt, youtubeSource: oneShot(30.6) },
        { decision: decision("s0b2", 20, 24), sceneOffsetSec: 0, identity: stock },
      ],
    });
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clips = track && track.kind === "VIDEO" ? track.clips : [];
    const ytClips = clips.filter((c) => c.source.archiveAssetId === 57820);
    for (const c of ytClips) expect(c.timelineEnd - c.timelineStart).toBeLessThanOrEqual(5 + 1e-6);
    expect(timeline.durationSec).toBe(30);
    expect(youtubeShots.length).toBeGreaterThan(0);
    const blocking = validateTimeline(timeline).issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code));
    expect(blocking, JSON.stringify(blocking)).toEqual([]);
  });

  it("the loss check reads the pieces as one decision, and a moved in-point as intended", async () => {
    const { lostEditorialIntent } = await import("./cinematicPipeline");
    const yt = { provider: "ww2", archiveAssetId: 57820 };
    const inputs = [
      { decision: decision("s0b0", 0, 4), sceneOffsetSec: 0, identity: yt, youtubeSource: oneShot(30.6) },
    ];
    const translated = translateEdl({
      videoId: 1,
      voice: { url: "https://x/voice.mp3", durationSec: 14 },
      inputs,
    });
    expect(translated.youtubeAdjustedClipIds.length).toBe(1);
    const edl = { decisions: inputs.map((i) => i.decision) } as Parameters<typeof lostEditorialIntent>[0];
    /** Without the ids the three pieces look like two lost decisions — the false alarm fixed here. */
    expect(lostEditorialIntent(edl, translated.timeline).join(" ")).toContain("1 shot decision(s)");
    expect(lostEditorialIntent(edl, translated.timeline, translated.youtubeAdjustedClipIds)).toEqual([]);
  });

  it("without YouTube facts the builder's output is exactly as before", () => {
    const identity = { provider: "loc", providerAssetId: "item/1", mediaUrl: "https://x/a.mp4" };
    const { timeline, youtubeShots } = translateEdl({
      videoId: 1,
      voice: { url: "https://x/voice.mp3", durationSec: 30 },
      inputs: [{ decision: decision("s0b0", 0, 6), sceneOffsetSec: 0, identity }],
    });
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clips = track && track.kind === "VIDEO" ? track.clips : [];
    expect(clips).toHaveLength(1);
    expect(clips[0]!.timelineEnd).toBe(30);
    expect(youtubeShots).toEqual([]);
  });
});

/* ═══════════ §5 ═══════════ */

describe("§5 — cuts measured on a real file, and kept on the row", () => {
  it("YouTube origin: the provider, or the archive row's platform or note", () => {
    expect(isYoutubeOrigin({ provider: "youtube_cc" }, null)).toBe(true);
    expect(isYoutubeOrigin({ provider: "ww2", archiveAssetId: 1 }, { sourcePlatform: "youtube_cc" })).toBe(true);
    expect(isYoutubeOrigin({ provider: "ww2", archiveAssetId: 1 }, { sourceNote: "youtube_cc:abc@13s" })).toBe(true);
    expect(isYoutubeOrigin({ provider: "ww2", archiveAssetId: 1 }, { sourcePlatform: "pexels" })).toBe(false);
  });

  it("the archive splitter's detector finds the hard cut in a real two-shot video", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r647-"));
    try {
      const file = path.join(dir, "two_shots.mp4");
      await run(resolveFFmpegBin(), [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=3",
        "-f", "lavfi", "-i", "color=c=blue:size=320x240:rate=25:duration=3",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]",
        "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", file,
      ]);
      const measured = await productionShotCutDeps().detect(file);
      expect(measured.durationSec).toBeCloseTo(6, 0);
      expect(measured.cutsSec.length).toBeGreaterThanOrEqual(1);
      expect(measured.cutsSec.some((c) => Math.abs(c - 3) < 0.2), `cuts=${measured.cutsSec}`).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("measured once: a row that has its cuts is not fetched again; one without is measured and saved", async () => {
    const saved: Array<[number, number[], number]> = [];
    let fetched = 0;
    const deps = {
      getAsset: async (id: number) =>
        id === 1
          ? { sourcePlatform: "youtube_cc", durationSec: 30, shotCutsSec: [10] }
          : { sourcePlatform: "youtube_cc", durationSec: 30, shotCutsSec: null },
      fetchAsset: async (_id: number, dest: string) => {
        fetched++;
        fs.writeFileSync(dest, "x");
        return true;
      },
      detect: async () => ({ durationSec: 30.6, cutsSec: [12.5] }),
      save: async (id: number, cuts: number[], dur: number) => void saved.push([id, cuts, dur]),
      log: () => {},
    };
    expect(await youtubeSourceFactsFor({ provider: "ww2", archiveAssetId: 1 }, deps)).toEqual({
      sourceDurationSec: 30,
      cutsSec: [10],
      measured: true,
    });
    expect(fetched).toBe(0);
    expect(await youtubeSourceFactsFor({ provider: "ww2", archiveAssetId: 2 }, deps)).toEqual({
      sourceDurationSec: 30.6,
      cutsSec: [12.5],
      measured: true,
    });
    expect(saved).toEqual([[2, [12.5], 30.6]]);
    /** Not from YouTube: nothing is asked. */
    expect(
      await youtubeSourceFactsFor({ provider: "pexels" }, { ...deps, getAsset: async () => null })
    ).toBeNull();
  });
});
