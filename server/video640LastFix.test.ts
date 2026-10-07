import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { buildCinematicSceneInputs, type ProductionBeat, type SceneFacts } from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import { blackByTimelineSpans } from "./edlToTimeline";
import { SAME_TITLE_WINDOW_SEC } from "./onScreenTextDirector";
import type { Scene } from "./pipeline/types";
import type { ProjectTimeline, TimelineGraphic } from "./projectTimeline";
import { beatNamedEntitiesByKind, extractActionCue, extractPersonNamesFromText, extractVisualPlacePhrase } from "./videoPipeline";

/**
 * VIDEO 640 — THE LAST FIX BEFORE COMMIT.
 *
 *   TEST 1   a YouTube moment from the film's stock reaches the last stage by the one registration
 *            every YouTube route uses, and is placed after its scene closed
 *   TEST 2   a moment already approved, rejected or placed is never reviewed again
 *   TEST 3–5 the three production routes that read `.beats` now get the sentences, and do their work
 *   GRAPHICS one subject card is a fallback, not a title per sentence — and not gone for good either
 */

/** The editorial reorder asks a model; here it answers "swap the two clips" and the prompt is kept. */
const prompts: string[] = [];
vi.mock("./_core/llm", async (orig) => ({
  ...(await orig<typeof import("./_core/llm")>()),
  invokeLLM: vi.fn(async (req: { messages: Array<{ content: string }> }) => {
    prompts.push(String(req.messages[1]?.content ?? ""));
    return { choices: [{ message: { content: JSON.stringify({ order: [1, 0], reasoning: "r", changes: "swap" }) } }] };
  }),
}));

type VP = typeof import("./videoPipeline");
type BVRM = typeof import("./beatVisualRelevance");
let vp: VP;
let bvr: BVRM;
let dir: string;
const video = (file: string, seconds: number): string => {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=gray:s=64x36:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  return file;
};
beforeAll(async () => {
  vp = await import("./videoPipeline");
  bvr = await import("./beatVisualRelevance");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-640last-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};
const PIPE = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════════════ the render's state, as the stage reads it ═══════════════════════ */

let n = 0;
const moment = (seconds: number) => video(path.join(dir, `scene_0_ytfu_1m${n}_t${1300 + n++}d23__pid_youtube_cc-5ae6199e012718d5.mp4`), seconds);
/** The beats `applyVoiceAlignmentToBeats` records for a scene (`sceneBeatsBySceneIndex`). */
const vbeat = (index: number, text = `sentence ${index}`) => ({ index, text, holdSec: 3.5, keywords: [] as string[] });
function state(beatsByScene: Record<number, ReturnType<typeof vbeat>[]>) {
  return {
    lateYoutubeCandidates: [] as string[],
    beatRelevance: bvr.createBeatRelevanceLedger(),
    beatImageGate: { judgementAttempts: 0 },
    visionReviewPool: { beats: new Map() },
    usedContentKeys: new Set<string>(),
    sceneBeatsBySceneIndex: new Map(Object.entries(beatsByScene).map(([k, v]) => [Number(k), v])),
  };
}
type State = ReturnType<typeof state>;
const asDedup = (d: State) => d as unknown as Parameters<VP["runFinalReadyYoutubeStage"]>[0];
/** What `fetchSceneVisualsInner` returns: no `beats`. */
const result = (clipBeatIndices: number[]) => ({ clips: clipBeatIndices.map((i) => `/w/c${i}.mp4`), beatDurations: clipBeatIndices.map(() => 3.5), clipBeatIndices });
/** The picture editor: a model look (one judgement) for a picture not yet judged for this sentence. */
const editor = (d: State, s: number, b: number, fits: (p: string) => boolean) =>
  vi.fn(async (_beat: unknown, _scene: number, paths: string[]) => {
    for (const p of paths) {
      if (!d.beatRelevance.byBeat.has(bvr.beatRelevanceBeatKey(s, b, "path", p))) {
        d.beatRelevance.spendByBeat.set(`s${s}b${b}`, (d.beatRelevance.spendByBeat.get(`s${s}b${b}`) ?? 0) + 1);
        d.beatImageGate.judgementAttempts++;
        d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(s, b, "path", p), { decision: { verdict: fits(p) ? "fits" : "does_not_fit", evaluated: true } } as never);
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
const FINAL = { sceneReturned: true, final: true } as const;
const FAST = { windowMs: 100, looksMs: 5_000 };

/* ═══════════════════════ TEST 1 — the film's stock, through to the timeline ═══════════════════════ */

/**
 * The real stock (`youtubeShotStock`): the download and the cut are local ffmpeg files instead of
 * the network. A beat's moment is then made the way `offerMoments` makes it — the shot copied to
 * the moment's path, tagged `__pid_youtube_cc-<id>` — and handed on through the very callback
 * `tryBeatRealYouTubeFootage` gives `fetchYouTubeCCClips` (`noteLookaheadCandidateReady`).
 * `fetchYouTubeCCClips` itself needs the pool and the YouTube service; its two exits are pinned below.
 */
let film = 640_100;
async function stockMoments(videoId: string, count: number): Promise<string[]> {
  const { startYoutubeShotStock, takeStockShots, youtubeStockSettled, releaseYoutubeShotStock } = await import("./youtubeShotStock");
  const id = film++;
  startYoutubeShotStock(id, [{ videoId, title: "The Kardashians — red carpet", durationSec: 600, serves: 3 }], {
    workDir: dir,
    download: async (_v, _s, seconds, out) => fs.existsSync(video(out, Math.min(seconds, 18))),
    cut: async (file) => [0, 6, 12].map((t, i) => ({ path: video(`${file}.shot${i}.mp4`, 6), startSec: t, endSec: t + 6 })),
    startFor: () => 0,
    log: () => {},
  });
  await youtubeStockSettled(id);
  const took = await takeStockShots(id, videoId, 0, () => false, count);
  expect(took.shots).toHaveLength(count);
  const paths = took.shots.map((shot, m) => {
    const momentPath = path.join(dir, `scene_1_ytfu_0m${m}_t${shot.sourceStartSec}d6__pid_youtube_cc-${videoId}.mp4`);
    fs.copyFileSync(shot.path, momentPath);
    return momentPath;
  });
  releaseYoutubeShotStock(id);
  return paths;
}

describe("TEST 1 — a stock moment is registered like every YouTube moment and placed after its scene closed", () => {
  it("lookahead: stock → moment → onCandidateReady → own turn takes it (assigned) → review still running at close → stage → placed", async () => {
    quiet();
    const d = state({ 1: [vbeat(0), vbeat(1), vbeat(2)] });
    const [m] = await stockMoments("stockA", 1);
    expect(vp.isYoutubeMomentPath(m!)).toBe(true);
    vp.noteLookaheadCandidateReady(d, vp.youtubeTurnKey(1, 2), m!);
    expect(vp.takeReadyLookaheadCandidates(d, vp.youtubeTurnKey(1, 2))).toEqual([m]);
    vp.noteReviewInFlight(d, vp.youtubeTurnKey(1, 2), new Promise(() => {}));
    const placer = closedScene(d, 1);
    expect(vp.pendingYoutubeForBeat(d, 1, 2)).toEqual([m]);
    const look = editor(d, 1, 2, () => true);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 1 }], [result([0, 1])], look, FAST);
    expect(look).toHaveBeenCalledTimes(1);
    expect(await vp.placeApprovedAfterSceneClosed(d, 1, FINAL)).toContainEqual({ beatIndex: 2, clip: m, hold: 3.5 });
    expect(placer).toHaveBeenCalledWith(m, 2);
  });

  it("lookahead: the scene closed before the sentence's own turn took its stock moments → the stage takes them → placed", async () => {
    quiet();
    const d = state({ 1: [vbeat(0), vbeat(1), vbeat(2)] });
    const [a, b] = await stockMoments("stockB", 2);
    vp.noteLookaheadCandidateReady(d, vp.youtubeTurnKey(1, 1), a!);
    vp.noteLookaheadCandidateReady(d, vp.youtubeTurnKey(1, 1), b!);
    const placer = closedScene(d, 1);
    const look = editor(d, 1, 1, (p) => p === b);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 1 }], [result([0, 2])], look, FAST);
    expect(look.mock.calls[0]![2]).toEqual([a, b]);
    expect(await vp.placeApprovedAfterSceneClosed(d, 1, FINAL)).toContainEqual({ beatIndex: 1, clip: b, hold: 3.5 });
    expect(placer).toHaveBeenCalledWith(b, 1);
  });

  it("own turn: fetchYouTubeCCClips' answer (or what a cut-short turn found) is assigned → stage → placed", async () => {
    quiet();
    const d = state({ 1: [vbeat(0), vbeat(1), vbeat(2)] });
    const [m] = await stockMoments("stockC", 1);
    /** Exactly what `tryBeatRealYouTubeFootage` does with the paths of a sentence's own turn. */
    vp.noteYoutubeAssigned(d, vp.youtubeTurnKey(1, 0), [m!]);
    const placer = closedScene(d, 1);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 1 }], [result([1, 2])], editor(d, 1, 0, () => true), FAST);
    expect(await vp.placeApprovedAfterSceneClosed(d, 1, FINAL)).toContainEqual({ beatIndex: 0, clip: m, hold: 3.5 });
    expect(placer).toHaveBeenCalledWith(m, 0);
  });

  it("the route's wiring: offerMoments hands every stock moment on; the one caller registers both exits; the stock wait hands out nothing", () => {
    const src = PIPE();
    expect(src).toContain("results.push(momentPath);\n                  scriptGuided?.onCandidateReady?.(momentPath);");
    expect(src.match(/await fetchYouTubeCCClips\(/g)).toHaveLength(1);
    expect(src).toContain("onCandidateReady: (p: string) => noteLookaheadCandidateReady(dedup, youtubeTurnKey(sceneIndex, beat.index), p)");
    expect(src).toContain("if (!req.lookahead) noteYoutubeAssigned(dedup, youtubeTurnKey(sceneIndex, beat.index), paths);");
    expect(src).toContain("if (!req.lookahead) noteYoutubeAssigned(dedup, youtubeTurnKey(sceneIndex, beat.index), found);");
    expect(src).toContain("  noteYoutubeAssigned(dedup, turnKey, list);\n  return list.filter((p) => fs.existsSync(p));");
    const start = src.indexOf("export async function waitForYoutubeStockBeforePictures(");
    const wait = src.slice(start, src.indexOf("\n}\n", start));
    expect(wait).not.toMatch(/takeStockShots|noteLookaheadCandidateReady|noteYoutubeAssigned/);
  });
});

/* ═══════════════════════ TEST 2 — nothing is reviewed twice ═══════════════════════ */

describe("TEST 2 — a moment already approved, rejected or placed is not reviewed again by the stage", () => {
  it("rejected for this sentence, approved and placed, placed for another sentence → only the fresh one costs a look", async () => {
    quiet();
    const d = state({ 0: [vbeat(0), vbeat(1)] });
    const rejected = moment(6);
    const approvedPlaced = moment(6);
    const placedElsewhere = moment(6);
    const fresh = moment(6);
    const verdict = (p: string, v: "fits" | "does_not_fit") =>
      d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(0, 1, "path", p), { decision: { verdict: v, evaluated: true } } as never);
    verdict(rejected, "does_not_fit");
    verdict(approvedPlaced, "fits");
    d.usedContentKeys.add(vp.clipContentKey(approvedPlaced));
    d.usedContentKeys.add(vp.clipContentKey(placedElsewhere));
    d.beatImageGate.judgementAttempts = 2;
    vp.noteYoutubeAssigned(d, vp.youtubeTurnKey(0, 1), [rejected, approvedPlaced, placedElsewhere, fresh]);
    closedScene(d, 0);
    const look = editor(d, 0, 1, () => false);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [result([0])], look, FAST);
    expect(look).toHaveBeenCalledTimes(1);
    expect(look.mock.calls[0]![2]).toEqual([fresh]);
    expect(d.beatImageGate.judgementAttempts).toBe(3);

    /** The stage once more: everything now has its verdict — no look, no judgement. */
    const again = editor(d, 0, 1, () => false);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [result([0])], again, FAST);
    expect(again).not.toHaveBeenCalled();
    expect(d.beatImageGate.judgementAttempts).toBe(3);
  });
});

/* ═══════════════════════ TEST 3–5 — the routes that read `.beats` ═══════════════════════ */

/** Production shape: the record holds the sentences, the scene result does not. */
const SENTENCES = [
  vbeat(0, "A close-up of her hands holding the contract"),
  vbeat(1, "An aerial wide shot of the Calabasas skyline"),
  vbeat(2, "A close-up of the ring on her finger"),
];
const record = () => state({ 77: SENTENCES });
const sceneResult = () => ({
  clips: ["/w/scene_77_a__pid_youtube_cc-aaa.mp4", "/w/scene_77_b__pid_youtube_cc-bbb.mp4", "/w/scene_77_c__pid_youtube_cc-ccc.mp4"],
  beatDurations: [3.5, 3.5, 3.5],
  clipBeatIndices: [0, 1, 2],
});

describe("TEST 3 — editorial reorder: production shape → the record's sentences → the editor sees them → reorders", () => {
  it("the prompt carries each clip's sentence; the answer is applied", async () => {
    const { editorialReorderScene } = await import("./editorialReorder");
    quiet();
    const d = record();
    const vr = { ...sceneResult(), clips: sceneResult().clips.slice(0, 2), beatDurations: [3.5, 3.5], clipBeatIndices: [0, 1] };
    prompts.length = 0;
    const out = await editorialReorderScene(77, "scene", "Kardashians", 7, vr.clips, vr.beatDurations, vr.clipBeatIndices, vp.sentencesOfScene(d, 77, vr));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("A close-up of her hands holding the contract");
    expect(prompts[0]).toContain("An aerial wide shot of the Calabasas skyline");
    expect(out.clips).toEqual([vr.clips[1], vr.clips[0]]);
    expect(out.clipBeatIndices).toEqual([1, 0]);
  });

  it("what the pipeline did before: the result's own `.beats` — the editor saw no sentence at all", async () => {
    const { editorialReorderScene } = await import("./editorialReorder");
    quiet();
    const vr = { ...sceneResult(), clips: sceneResult().clips.slice(0, 2), beatDurations: [3.5, 3.5], clipBeatIndices: [0, 1] };
    prompts.length = 0;
    await editorialReorderScene(77, "scene", "Kardashians", 7, vr.clips, vr.beatDurations, vr.clipBeatIndices, (vr as { beats?: [] }).beats);
    expect(prompts[0]).not.toContain("close-up of her hands");
  });
});

describe("TEST 4 — shot-sequence optimizer: production shape → sentences → shot types → no three alike in a row", () => {
  it("each clip's type comes from its sentence; close-up, wide, close-up instead of two close-ups first", async () => {
    const { optimizeShotSequence } = await import("./shotSequenceOptimizer");
    quiet();
    const d = record();
    const vr = { ...sceneResult(), clipBeatIndices: [0, 2, 1] };
    const out = optimizeShotSequence(77, vr.clips, vr.beatDurations, vr.clipBeatIndices, vp.sentencesOfScene(d, 77, vr));
    expect(new Set(out.shotCategories)).toEqual(new Set(["close_up", "establishing"]));
    expect(out.shotCategories).not.toContain("unknown");
    const blind = optimizeShotSequence(77, vr.clips, vr.beatDurations, vr.clipBeatIndices, (vr as { beats?: [] }).beats);
    expect(blind.shotCategories).toEqual(["unknown", "unknown", "unknown"]);
  });
});

describe("TEST 5 — the beat funnel report: every planned sentence has its line, also one nothing was recorded for", () => {
  it("planned from the record → a sentence with no audit record is reported; from `.beats` it vanished", async () => {
    const { createBeatOutcomeAudit, renderBeatFunnelReport } = await import("./beatOutcomeAudit");
    const { createRejectionRegistry } = await import("./rejectionRegistry");
    const d = record();
    const vr = sceneResult();
    const planned = vp.sentencesOfScene(d, 77, vr).map((b) => ({ sceneIndex: 77, beatIndex: b.index }));
    const lines = renderBeatFunnelReport(createBeatOutcomeAudit(), planned, createRejectionRegistry());
    for (const b of [0, 1, 2]) expect(lines.some((l) => l.includes(`scene=77 beat=${b} status=`))).toBe(true);
    expect(lines.find((l) => l.includes("TOTAL"))).toContain("TOTAL beats=3");
    const before = renderBeatFunnelReport(createBeatOutcomeAudit(), ((vr as { beats?: [] }).beats ?? []).map(() => ({ sceneIndex: 77, beatIndex: 0 })), createRejectionRegistry());
    expect(before.find((l) => l.includes("TOTAL"))).toContain("TOTAL beats=0");
  });
});

describe("TEST 3–5 — the pipeline feeds the three routes from the record; Visual Rhythm is left as it was", () => {
  it("three call sites read `sentencesOfScene`, none reads the result's `.beats`", () => {
    const src = PIPE();
    expect(src).toContain("              /** VIDEO 640 — the scene's sentences from the render's record; the result has no `beats`. */\n              sentencesOfScene(visualDedup, scene.index, vr)\n            );");
    expect(src).toContain("optimizeShotSequence(scenes[i].index, vr.clips, vr.beatDurations, vr.clipBeatIndices, sentencesOfScene(visualDedup, scenes[i].index, vr));");
    expect(src).toContain("for (const b of sentencesOfScene(visualDedup, sceneIndex, svr)) planned.push({ sceneIndex, beatIndex: b.index });");
    expect(src).not.toContain("vr.clipBeatIndices,\n              vr.beats\n");
    expect(src).not.toContain("for (const b of svr?.beats ?? [])");
  });
});

/* ═══════════════════════ GRAPHICS — a subject card is a fallback ═══════════════════════ */

const EXTRACTORS = {
  people: (t: string) => extractPersonNamesFromText(t),
  place: (t: string) => extractVisualPlacePhrase(t),
  action: (t: string) => extractActionCue(t),
  namedEntities: (t: string) => beatNamedEntitiesByKind(t),
};
const pbeat = (index: number, text: string, holdSec: number): ProductionBeat => ({
  index, text, searchQuery: "", powerWord: "", keywords: [], holdSec, visualDescription: "",
});
function scene(index: number, duration: number, texts: string[], pictured: boolean[]): SceneFacts {
  const beats = texts.map((t, i) => pbeat(i, t, duration / texts.length));
  return {
    scene: { index, text: texts.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration } as Scene,
    beats,
    clips: beats.map((_, i) =>
      pictured[i]
        ? {
            facts: { localPath: `/tmp/v640last-s${index}b${i}.mp4`, durationSec: 30, widthPx: 1920, heightPx: 1080 },
            adoption: { provider: "youtube_cc", providerAssetId: `yt-${index}-${i}`, sourceUrl: `https://youtube.invalid/${index}${i}`, assetTitle: "moment", query: "moment" },
          }
        : null
    ) as SceneFacts["clips"],
  };
}
/**
 * 100 s: a nameless sentence at 0 s (subject card), a place at 25 s (its own card), a nameless
 * sentence at 30 s (the subject again, 30 s later), 45 s of footage, a nameless sentence at 80 s.
 */
const FILM = () => [
  scene(0, 20, ["But is any of it what it seems?", "They smile for the cameras.", "The family business grows.", "Every week a new episode."], [false, true, true, true]),
  scene(1, 20, ["The show films every day.", "Kim Kardashian attended the Met Gala in New York.", "And what does that really mean?", "The cameras keep rolling."], [true, false, false, true]),
  scene(2, 40, ["The ratings climb.", "The brand grows.", "The deals multiply.", "The empire expands."], [true, true, true, true]),
  scene(3, 20, ["Is it all just a performance?", "Fans keep watching.", "Critics keep writing.", "The story goes on."], [false, true, true, true]),
];
function plan(scenes = FILM()) {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const built = buildCinematicSceneInputs({ scenes, extractors: EXTRACTORS, filmSubject: "Kardashians" });
  const out = runCinematicPipeline({
    videoId: 640,
    scenes: built.scenes,
    ...(built.primaryGraphics?.length ? { primaryGraphics: built.primaryGraphics } : {}),
    voice: { url: "voice.mp3", durationSec: 100 },
  });
  vi.restoreAllMocks();
  return { built, timeline: out.timeline as ProjectTimeline, logs };
}
const graphicsOf = (t: ProjectTimeline): TimelineGraphic[] =>
  (t.tracks.find((k) => k.kind === "GRAPHICS") as { graphics: TimelineGraphic[] } | undefined)?.graphics ?? [];
const cardsOf = (t: ProjectTimeline) => graphicsOf(t).filter((g) => !g.disabled && g.data?.primaryVisual === true);
const titled = (t: ProjectTimeline) => cardsOf(t).filter((g) => g.data?.titleHidden !== true);

describe("GRAPHICS — the film-subject card is a fallback, not a title for every sentence without footage", () => {
  it("1 — the same subject 30 s after it was drawn: the card keeps its ground, its title stays off (and the log says why)", () => {
    const { timeline, logs } = plan();
    const subject = cardsOf(timeline).filter((g) => g.label === "Kardashians");
    const at30 = subject.find((g) => Math.abs(g.start - 30) < 0.5)!;
    expect(at30).toBeDefined();
    expect(at30.data?.titleHidden).toBe(true);
    expect(logs.some((l) => l.includes('[GRAPHIC_BUDGET_EXCEEDED]') && l.includes('title off "Kardashians" — the same title was on screen 30.0s ago'))).toBe(true);
  });

  it("2 — a different card between them is shown: the sentence's own place, not the subject again", () => {
    const { timeline } = plan();
    const other = titled(timeline).find((g) => g.label !== "Kardashians" && g.start > 20 && g.start < 30);
    expect(other).toBeDefined();
  });

  it("3 — the same subject after real footage and more than a minute: its title is drawn again", () => {
    const { timeline } = plan();
    const shown = titled(timeline).filter((g) => g.label === "Kardashians").map((g) => Math.round(g.start));
    expect(shown).toEqual([0, 80]);
    expect(SAME_TITLE_WINDOW_SEC).toBe(60);
  });

  it("4 — no card holds longer than its own sentence; nothing goes black", () => {
    const { built, timeline } = plan();
    for (const g of cardsOf(timeline)) {
      const w = built.beatWindows.find((x) => g.start >= x.startSec - 0.05 && g.start < x.endSec - 0.05)!;
      expect(g.end - g.start).toBeLessThanOrEqual(w.endSec - w.startSec + 0.05);
      expect(g.end - g.start).toBeLessThan(15);
    }
    expect(blackByTimelineSpans(timeline)).toEqual([]);
  });

  it("5 — footage always wins: no full-frame card over a sentence that has its clip", () => {
    const { built, timeline } = plan();
    const scenes = FILM();
    for (const w of built.beatWindows) {
      const hasClip = scenes[w.sceneIndex]!.clips[w.beatIndex] != null;
      if (!hasClip) continue;
      const over = cardsOf(timeline).filter((g) => g.start < w.endSec - 0.05 && g.end > w.startSec + 0.05);
      expect(over).toEqual([]);
    }
  });
});
