import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { placePrimaryGraphics, isGraphicBackdrop } from "./edlToTimeline";
import type { TimelineGraphic, TimelineVideoClip } from "./projectTimeline";

/**
 * VIDEO 640 (179d309) — two production faults the earlier tests could not see:
 *
 *   1  FIX B/D/E/F never ran: the last stage looped over `sceneVisualResults[si].beats`, and
 *      `fetchSceneVisuals` returns `{ clips, beatDurations, clipBeatIndices }` — no `beats`. Every
 *      scene had zero sentences; no [FinalReviewWindow] or [FinalReadyYouTube] line in 639 or 640.
 *      The earlier tests ran the helpers and only READ the wiring's text.
 *   2  "Kardashians" again and again: every sentence without a picture gets the film-subject card,
 *      and two neighbouring ones (s1b2 26.55 s, s1b3 30.05 s) were placed as two graphics, so the
 *      same title came in twice in a row.
 *
 * These tests run the stage the pipeline runs (`runFinalReadyYoutubeStage`) with the shape
 * `fetchSceneVisuals` really returns, and `placePrimaryGraphics` with 640's own windows.
 */

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const bodyOf = (signature: string): string => {
  const at = PIPE.indexOf(signature);
  expect(at).toBeGreaterThan(0);
  return PIPE.slice(at, PIPE.indexOf("\n}\n", at));
};

type VP = typeof import("./videoPipeline");
type BVRM = typeof import("./beatVisualRelevance");
let vp: VP;
let bvr: BVRM;
let dir: string;
const video = (name: string, seconds: number): string => {
  const p = path.join(dir, name);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=gray:s=64x36:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", p]);
  return p;
};
beforeAll(async () => {
  vp = await import("./videoPipeline");
  bvr = await import("./beatVisualRelevance");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-640-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};

/* ═══════════════════════ shared: a render's state and the shape fetchSceneVisuals returns ═══════════════════════ */

let n = 0;
const moment = (seconds = 6, videoId = "5ae6199e012718d5") => video(`scene_2_ytfu_1m${n}_t${1400 + n++}d38__pid_youtube_cc-${videoId}.mp4`, seconds);
const beat = (index: number, text: string) => ({ index, text, holdSec: 3.5, keywords: [] as string[] });

function renderState(beatsByScene: Record<number, ReturnType<typeof beat>[]>) {
  return {
    lateYoutubeCandidates: [] as string[],
    beatRelevance: bvr.createBeatRelevanceLedger(),
    beatImageGate: { judgementAttempts: 0 },
    visionReviewPool: { beats: new Map() },
    usedContentKeys: new Set<string>(),
    /** Written by `applyVoiceAlignmentToBeats` — the render's own record of each scene's sentences. */
    sceneBeatsBySceneIndex: new Map(Object.entries(beatsByScene).map(([k, v]) => [Number(k), v])),
  };
}
type State = ReturnType<typeof renderState>;
const asDedup = (d: State) => d as unknown as Parameters<VP["runFinalReadyYoutubeStage"]>[0];

/** EXACTLY what `fetchSceneVisualsInner` returns: no `beats` field. */
const sceneResult = (clipBeatIndices: number[]) => ({
  clips: clipBeatIndices.map((b) => `/w/scene_clip_b${b}.mp4`),
  beatDurations: clipBeatIndices.map(() => 3.5),
  clipBeatIndices,
});

/** The picture editor as `adoptClip` reports it: one look per unjudged moment, a FIT registers the approval. */
const editor = (d: State, s: number, b: number, fits: (p: string) => boolean) =>
  vi.fn(async (_beat: unknown, _scene: number, paths: string[]) => {
    for (const p of paths) {
      if (!d.beatRelevance.byBeat.has(bvr.beatRelevanceBeatKey(s, b, "path", p))) {
        d.beatRelevance.spendByBeat.set(`s${s}b${b}`, (d.beatRelevance.spendByBeat.get(`s${s}b${b}`) ?? 0) + 1);
        d.beatImageGate.judgementAttempts++;
        d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(s, b, "path", p), {
          decision: { verdict: fits(p) ? "fits" : "does_not_fit", evaluated: true },
        } as never);
      }
      if (fits(p)) {
        vp.noteApprovedPickForBeat(d, s, b, vp.clipContentKey(p));
        return p;
      }
    }
    return null;
  });

function closedScene(d: object, sceneIndex: number) {
  const placer = vi.fn(async (_clip: string, _beat: number) => ({ hold: 3.5 }));
  vp.openLatePlacement(d, sceneIndex, placer);
  vp.markSceneClosed(d, sceneIndex);
  return placer;
}
function handTo(d: object, s: number, b: number, paths: string[]) {
  for (const p of paths) vp.noteLookaheadCandidateReady(d, vp.youtubeTurnKey(s, b), p);
  return vp.takeReadyLookaheadCandidates(d, vp.youtubeTurnKey(s, b));
}
const FAST = { windowMs: 200, looksMs: 5_000 };
const FINAL = { sceneReturned: true, final: true } as const;

/* ═══════════════════════ 1 — D/E/F reach production ═══════════════════════ */

describe("VIDEO 640 — the last YouTube stage runs on the scene shape the pipeline really has", () => {
  it("the result fetchSceneVisuals returns has no beats; the render's record has them", () => {
    const inner = bodyOf("async function fetchSceneVisualsInner(");
    expect(inner).toContain("return { clips: usable, beatDurations: usableDurations, clipBeatIndices: usableBeatIndices };");
    expect(inner).toContain("await applyVoiceAlignmentToBeats(beats, sceneAudioPath, scene.duration, dedup, scene.index);");
    expect(PIPE).toContain("dedup.sceneBeatsBySceneIndex.set(sceneIndex, beats);");
  });

  it("640 s2b3 replayed: no beats on the result, a handed moment never judged → looked at, approved, placed", async () => {
    quiet();
    const d = renderState({ 2: [beat(0, "a"), beat(1, "b"), beat(2, "c"), beat(3, "An empire built on visibility.")] });
    const placer = closedScene(d, 2);
    const fit = moment();
    handTo(d, 2, 3, [fit]);
    const look = editor(d, 2, 3, () => true);
    /** s2b0 has its clip; s2b1–s2b3 have none (640). */
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 2 }], [sceneResult([0])], look, FAST);
    expect(look).toHaveBeenCalledTimes(1);
    expect(look.mock.calls[0]![1]).toBe(2);
    expect(look.mock.calls[0]![2]).toEqual([fit]);
    expect(await vp.placeApprovedAfterSceneClosed(d, 2, FINAL)).toEqual([{ beatIndex: 3, clip: fit, hold: 3.5 }]);
    expect(placer).toHaveBeenCalledWith(fit, 3);
  });

  it("what 179d309 did: the same scene read from result.beats has no sentences, so nothing is ever looked at", () => {
    const d = renderState({});
    expect(vp.sentencesOfScene(d, 2, sceneResult([0]))).toEqual([]);
    const d2 = renderState({ 2: [beat(3, "x")] });
    expect(vp.sentencesOfScene(d2, 2, sceneResult([0])).map((b) => b.index)).toEqual([3]);
  });

  it("a review still running for that sentence gets its window first (FIX D), inside the stage", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = renderState({ 1: [beat(0, "a"), beat(1, "b")] });
    let finish!: () => void;
    vp.noteReviewInFlight(d, vp.youtubeTurnKey(1, 1), new Promise<void>((r) => (finish = r)));
    setTimeout(() => finish(), 20);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 1 }], [sceneResult([0])], editor(d, 1, 1, () => true), { windowMs: 2_000, looksMs: 1_000 });
    expect(logs.some((l) => l.startsWith("[FinalReviewWindow] started ladders=0 reviews=1"))).toBe(true);
    expect(logs.some((l) => l.startsWith("[FinalReviewWindow] ended") && l.includes("stillRunning=0"))).toBe(true);
  });

  it("FIX F inside the stage: approved moment prepared to 2.29 s → refused by the 3 s rule → the next one placed", async () => {
    quiet();
    const d = renderState({ 0: [beat(0, "s0b0")] });
    closedScene(d, 0);
    const short = moment(2.29);
    const next = moment(6);
    handTo(d, 0, 0, [short, next]);
    const look = editor(d, 0, 0, () => true);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [sceneResult([])], look, FAST);
    expect(look).toHaveBeenCalledTimes(2);
    expect(await vp.placeApprovedAfterSceneClosed(d, 0, FINAL)).toEqual([{ beatIndex: 0, clip: next, hold: 3.5 }]);
  });

  it("a sentence with a clip is never asked; a sentence with nothing handed costs no look", async () => {
    quiet();
    const d = renderState({ 0: [beat(0, "with clip"), beat(1, "nothing handed")] });
    const shown = moment();
    handTo(d, 0, 0, [shown]);
    /** STEP 0 — the moment's seconds are the clip s0b0 shows: no footage of this render is left for s0b1. */
    d.usedContentKeys.add(vp.clipContentKey(shown));
    const look = editor(d, 0, 0, () => true);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [sceneResult([0])], look, FAST);
    expect(look).not.toHaveBeenCalled();
  });

  it("the stage starts no search or download, and the pipeline calls exactly this stage before the final F2 pass", () => {
    expect(bodyOf("export async function runFinalReadyYoutubeStage(")).not.toMatch(
      /fetchYouTubeCCClips|tryBeatRealYouTubeFootage|claimYoutubeTurn|searchYouTube|runCentralYoutubeTurn|downloadYoutube/
    );
    const call = PIPE.indexOf("await runFinalReadyYoutubeStage(visualDedup, scenes, sceneVisualResults, (beat, sceneIndex, ready) =>");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(PIPE.indexOf("for (let si = 0; si < scenes.length; si++) await placeLate(si, true);"));
    /** No other read of a scene result's `beats` feeds the last look. */
    expect(bodyOf("export async function runFinalReadyYoutubeStage(")).not.toContain("?.beats");
    expect(bodyOf("export function sentencesOfScene(")).toContain("dedup.sceneBeatsBySceneIndex.get(sceneIndex) ?? result?.beats ?? []");
  });
});

/* ═══════════════════════ 2 — one card for one moment ═══════════════════════ */

describe("VIDEO 640 — neighbouring sentences with the same card are one card, not the title again", () => {
  const shot = (id: string, start: number, end: number) =>
    ({ id, source: { provider: "youtube", archiveAssetId: 60352 }, timelineStart: start, timelineEnd: end, sourceIn: 0, sourceOut: end - start }) as TimelineVideoClip;
  const card = (beatId: string, start: number, end: number, title: string) => ({
    beatId, startSec: start, endSec: end, onlyWithoutApprovedFiller: true,
    graphic: { graphicType: "chapter_card", data: { title, label: title }, reason: "CHAPTER_CARD_FALLBACK: film subject" },
  });
  const counter = (beatId: string, start: number, end: number) => ({
    beatId, startSec: start, endSec: end,
    graphic: { graphicType: "counter", data: { label: "$1 billion", toValue: 1, unit: "billion" }, reason: "data" },
  });
  const cards = (graphics: TimelineGraphic[]) => graphics.filter((g) => g.data?.primaryVisual === true);

  it("640 s1b2 + s1b3: two neighbouring 'Kardashians' cards were two graphics; now one card over both sentences", () => {
    const clips = [shot("vc_d9e5333839", 23.05, 26.55)];
    const graphics: TimelineGraphic[] = [];
    const placed = placePrimaryGraphics(clips, graphics, [
      card("s1b2", 26.55, 30.05, "Kardashians"),
      card("s1b3", 30.05, 33.55, "Kardashians"),
    ] as never);
    expect(placed).toHaveLength(1);
    expect(cards(graphics)).toHaveLength(1);
    expect(cards(graphics)[0]!.start).toBe(26.55);
    expect(cards(graphics)[0]!.end).toBe(33.55);
    /** Both sentences are still covered: one ground, no hole, nothing borrowed. */
    const grounds = clips.filter((c) => isGraphicBackdrop(c));
    expect(grounds).toHaveLength(1);
    expect(grounds[0]!.timelineStart).toBe(26.55);
    expect(grounds[0]!.timelineEnd).toBe(33.55);
    expect(grounds[0]!.transform?.opacity).toBe(0);
  });

  it("a different title next to it is a new moment: 640 s2b1 'Kardashians' → s2b2 'Kim Kardashian Media Event'", () => {
    const graphics: TimelineGraphic[] = [];
    placePrimaryGraphics([shot("vc_6ca450ecd3", 45.29, 48.79)], graphics, [
      card("s2b1", 48.79, 52.29, "Kardashians"),
      card("s2b2", 52.29, 55.79, "Kim Kardashian Media Event"),
      card("s2b3", 55.79, 59.29, "Kardashians"),
    ] as never);
    expect(cards(graphics).map((g) => g.label)).toEqual(["Kardashians", "Kim Kardashian Media Event", "Kardashians"]);
  });

  it("the same title after real footage is a new card (the sentence's own picture), placed as before", () => {
    const graphics: TimelineGraphic[] = [];
    placePrimaryGraphics([shot("a", 0, 16.05), shot("b", 23.05, 26.55)], graphics, [
      card("s1b0", 16.05, 23.05, "Kardashians"),
      card("s1b2", 26.55, 30.05, "Kardashians"),
    ] as never);
    expect(cards(graphics)).toHaveLength(2);
  });

  it("only chapter cards run on: a data graphic next to a card stays its own graphic", () => {
    const graphics: TimelineGraphic[] = [];
    placePrimaryGraphics([shot("a", 0, 2)], graphics, [counter("s0b0", 2, 5.5), card("s0b1", 5.5, 9, "Kardashians")] as never);
    expect(cards(graphics).map((g) => g.graphicType)).toEqual(["counter", "chapter_card"]);
  });

  it("the merged card is still a sentence's picture: protected, counted once by the graphic budget", async () => {
    quiet();
    const { emptyTimeline } = await import("./projectTimeline");
    const { directOnScreenText } = await import("./onScreenTextDirector");
    const clips = [shot("vc_d9e5333839", 23.05, 26.55)];
    const graphics: TimelineGraphic[] = [];
    placePrimaryGraphics(clips, graphics, [card("s1b2", 26.55, 30.05, "Kardashians"), card("s1b3", 30.05, 33.55, "Kardashians")] as never);
    const t = emptyTimeline(640);
    t.durationSec = 60;
    for (const track of t.tracks) if (track.kind === "GRAPHICS") track.graphics.push(...graphics);
    directOnScreenText(t);
    const kept = (t.tracks.find((x) => x.kind === "GRAPHICS") as { graphics: TimelineGraphic[] }).graphics.filter((g) => !g.disabled);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.data?.primaryVisual).toBe(true);
  });

  it("the budget rule and the protected rule are unchanged", () => {
    const DIRECTOR = fs.readFileSync(path.join(__dirname, "onScreenTextDirector.ts"), "utf8");
    expect(DIRECTOR).toContain("export const GRAPHIC_MOMENTS_PER_MINUTE = 3;");
    expect(DIRECTOR).toContain("export const SAME_MOMENT_SEC = 0.75;");
    expect(DIRECTOR).toContain('if ((el as { editedByUser?: boolean }).editedByUser === true || g?.data?.primaryVisual === true || el.id === "txt_opening_word") {');
  });
});
