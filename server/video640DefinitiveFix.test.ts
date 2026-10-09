import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { buildCinematicSceneInputs, type AdoptionFacts, type ProductionBeat, type SceneFacts } from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import { blackByTimelineSpans } from "./edlToTimeline";
import type { Scene } from "./pipeline/types";
import type { ProjectTimeline, TimelineGraphic } from "./projectTimeline";
import { beatNamedEntitiesByKind, extractActionCue, extractPersonNamesFromText, extractVisualPlacePhrase } from "./videoPipeline";

/**
 * VIDEO 640 — THE DEFINITIVE FIX: MOVING FOOTAGE FIRST, GRAPHICS ONLY WHERE THERE IS NONE.
 *
 *   A–B  the last YouTube stage runs on the real scene shape and recovers what a closed scene left
 *   C–D  an approved moment under 3 s → the next moment already found (2.29 s and 2.60 s, as in 640),
 *        and the 3 s gate measures even when the scene's clock has run out (the 640 cause)
 *   E–F  real footage is never replaced by a graphic
 *   G    laid-out sentences cover their scene: no 15 s card
 *   H–I  one title once; the budget counts a protected card's TEXT, its ground stays
 *
 * Run through the production chain: `buildCinematicSceneInputs` → `runCinematicPipeline` (the
 * timeline, the holds, the on-screen text director and its budget), and `runFinalReadyYoutubeStage`.
 */

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-640def-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};

/* ═══════════════════════ the film of 640, as the planner receives it ═══════════════════════ */

const EXTRACTORS = {
  people: (t: string) => extractPersonNamesFromText(t),
  place: (t: string) => extractVisualPlacePhrase(t),
  action: (t: string) => extractActionCue(t),
  namedEntities: (t: string) => beatNamedEntitiesByKind(t),
};
/** Laid out, like all 12 beats of 640 (`laidOut=12`): no voice timing, only the hold budget. */
const beat = (index: number, text: string, holdSec = 3.5): ProductionBeat => ({
  index, text, searchQuery: "", powerWord: "", keywords: [], holdSec, visualDescription: "",
});
const adoption = (s: number, b: number): AdoptionFacts => ({
  provider: "youtube_cc", providerAssetId: `yt-${s}-${b}`, sourceUrl: `https://youtube.invalid/${s}${b}`,
  assetTitle: "moment", query: "moment",
});
/** Sentences that name nothing of their own, so a missing picture becomes the film-subject card. */
const NAMELESS = [
  "But is any of it what it seems?",
  "And what does that really mean?",
  "Is it all just a performance?",
  "How long can that last?",
];
function scene(index: number, duration: number, holds: number[], pictured: boolean[]): SceneFacts {
  const beats = holds.map((h, i) => beat(i, NAMELESS[i % NAMELESS.length]!, h));
  return {
    scene: { index, text: beats.map((b) => b.text).join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration } as Scene,
    beats,
    clips: beats.map((_, i) =>
      pictured[i]
        ? { facts: { localPath: `/tmp/v640-s${index}b${i}.mp4`, durationSec: 12, widthPx: 1920, heightPx: 1080 }, adoption: adoption(index, i) }
        : null
    ) as SceneFacts["clips"],
  };
}
/** 640: scene 0 16.05 s (b1–b3 pictured), scene 1 29.24 s (holds 7/3.5/3.5/3.5, only b1), scene 2 15.03 s (only b0). */
const FILM_640 = () => [
  scene(0, 16.05, [3.5, 3.5, 3.5, 3.5], [false, true, true, true]),
  scene(1, 29.24, [7, 3.5, 3.5, 3.5], [false, true, false, false]),
  scene(2, 15.03, [3.5, 3.5, 3.5, 3.5], [true, false, false, false]),
];
function plan640(scenes = FILM_640()) {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const built = buildCinematicSceneInputs({ scenes, extractors: EXTRACTORS, filmSubject: "Kardashians" });
  const result = runCinematicPipeline({
    videoId: 640,
    scenes: built.scenes,
    ...(built.primaryGraphics?.length ? { primaryGraphics: built.primaryGraphics } : {}),
    voice: { url: "voice.mp3", durationSec: 60.32 },
  });
  vi.restoreAllMocks();
  return { built, timeline: result.timeline as ProjectTimeline, logs };
}
const graphicsOf = (t: ProjectTimeline): TimelineGraphic[] =>
  (t.tracks.find((k) => k.kind === "GRAPHICS") as { graphics: TimelineGraphic[] } | undefined)?.graphics ?? [];
const cards = (t: ProjectTimeline) => graphicsOf(t).filter((g) => !g.disabled && g.data?.primaryVisual === true);
const windowOf = (built: ReturnType<typeof plan640>["built"], s: number, b: number) =>
  built.beatWindows.find((w) => w.sceneIndex === s && w.beatIndex === b)!;

/* ═══════════════════════ G — no 15 s card ═══════════════════════ */

describe("TEST G — laid-out sentences cover their scene's narration; a card is never stretched over it", () => {
  it("640 scene 1: holds 17.50 s in a 29.24 s scene → spread, s1b3's window ends where the scene ends", () => {
    const { built, logs } = plan640();
    const w = windowOf(built, 1, 3);
    expect(w.endSec).toBeCloseTo(16.05 + 29.24, 2);
    expect(w.endSec - w.startSec).toBeCloseTo(3.5 * (29.24 / 17.5), 2);
    expect(logs.some((l) => l.includes("[CinematicInputs] scene=1 laid-out beats spread over the narration: holds 17.50s → scene 29.24s"))).toBe(true);
  });

  it("on the timeline, no card runs past its own sentence (640 had 15.24 s for a 3.5 s card)", () => {
    const { built, timeline } = plan640();
    for (const g of cards(timeline)) {
      const owner = built.beatWindows.filter((w) => w.startSec < g.end - 0.01 && w.endSec > g.start + 0.01);
      const span = Math.max(...owner.map((w) => w.endSec)) - Math.min(...owner.map((w) => w.startSec));
      expect(g.end - g.start).toBeLessThanOrEqual(span + 0.01);
    }
    expect(Math.max(...cards(timeline).map((g) => g.end - g.start))).toBeLessThan(15);
  });

  it("a scene with measured beats, or beats that already fill it, is laid out exactly as before", () => {
    const measured = scene(0, 20, [3.5, 3.5], [true, true]);
    measured.beats = measured.beats.map((b, i) => ({ ...b, voiceStartSec: i * 4, voiceEndSec: i * 4 + 4 }));
    const a = plan640([measured]);
    expect(windowOf(a.built, 0, 1).endSec).toBe(8);
    const full = plan640([scene(0, 7, [3.5, 3.5], [true, true])]);
    expect(windowOf(full.built, 0, 1).endSec).toBeCloseTo(7, 3);
    expect(full.logs.some((l) => l.includes("laid-out beats spread"))).toBe(false);
  });
});

/* ═══════════════════════ E/F — footage before graphics ═══════════════════════ */

describe("TEST E/F — moving footage is never replaced by a graphic", () => {
  it("F — every sentence that has a clip gets its clip and no full-frame graphic", () => {
    const { built, timeline } = plan640();
    const graphicBeats = (built.primaryGraphics ?? []).map((p) => p.beatId);
    for (const [s, b] of [[0, 1], [0, 2], [0, 3], [1, 1], [2, 0]] as const) {
      expect(graphicBeats).not.toContain(`s${s}b${b}`);
      const w = windowOf(built, s, b);
      expect(cards(timeline).some((g) => g.start < w.endSec - 0.01 && g.end > w.startSec + 0.01)).toBe(false);
    }
  });

  it("E — a FIT that arrives in the last stage is placed; the sentence then plans footage, not a card", async () => {
    quiet();
    const d = state({ 2: [vbeat(0), vbeat(1), vbeat(2), vbeat(3)] });
    closedScene(d, 2);
    const ladder = deferred<string | null>();
    const fit = moment(6);
    vp.noteLadderForBeat(d, 2, 3, 0, ladder.promise);
    await vp.takeLateApprovedPicks(d, 2, 1);
    vp.noteApprovedPickForBeat(d, 2, 3, vp.clipContentKey(fit));
    setTimeout(() => ladder.resolve(fit), 20);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 2 }], [result([0])], editor(d, 2, 3, () => true), { windowMs: 2_000, looksMs: 1_000 });
    expect(await vp.placeApprovedAfterSceneClosed(d, 2, FINAL)).toEqual([{ beatIndex: 3, clip: fit, hold: 3.5 }]);
    /** That sentence now reaches the planner WITH its clip: no card for it. */
    const film = FILM_640();
    film[2] = scene(2, 15.03, [3.5, 3.5, 3.5, 3.5], [true, false, false, true]);
    const { built } = plan640(film);
    expect((built.primaryGraphics ?? []).map((p) => p.beatId)).not.toContain("s2b3");
  });
});

/* ═══════════════════════ H/I — one title once, the budget counts card text ═══════════════════════ */

describe("TEST H/I — the same title is not a new moment, and the budget holds for protected cards", () => {
  it("640: the title 'Kardashians' is drawn once; the other cards keep their ground without words", () => {
    const { timeline } = plan640();
    const shown = cards(timeline).filter((g) => g.data?.titleHidden !== true);
    const titled = shown.filter((g) => g.graphicType === "chapter_card").map((g) => g.label);
    expect(titled.filter((t) => t === "Kardashians")).toHaveLength(1);
    /** No card is switched off: every sentence without footage keeps its picture (no black). */
    expect(cards(timeline).length).toBeGreaterThan(titled.length);
    expect(blackByTimelineSpans(timeline)).toEqual([]);
  });

  it("I — at most 3 visible text/graphic moments per started minute, protected cards included", () => {
    const { timeline } = plan640();
    const visible = graphicsOf(timeline).filter((g) => !g.disabled && g.data?.titleHidden !== true);
    for (let minute = 0; minute * 60 < timeline.durationSec; minute++) {
      const inMinute = visible.filter((g) => Math.floor(g.start / 60) === minute);
      expect(inMinute.length).toBeLessThanOrEqual(3);
    }
  });

  it("H — two neighbouring sentences with the same card are one card (s1b2 + s1b3 in 640)", () => {
    const { built, timeline } = plan640();
    const s1b2 = windowOf(built, 1, 2);
    const s1b3 = windowOf(built, 1, 3);
    const over = cards(timeline).filter((g) => g.start < s1b3.endSec - 0.01 && g.end > s1b2.startSec + 0.01);
    expect(over).toHaveLength(1);
  });

  it("a second pass of the director over the same timeline gives a title back when it now has room", async () => {
    quiet();
    const { timeline } = plan640();
    const hidden = cards(timeline).filter((g) => g.data?.titleHidden === true);
    expect(hidden.length).toBeGreaterThan(0);
    /** The user removes the other cards of the film: the first hidden one now has room and is no repeat. */
    const keep = hidden[0]!;
    for (const g of graphicsOf(timeline)) if (g !== keep) g.disabled = true;
    const { directOnScreenText } = await import("./onScreenTextDirector");
    directOnScreenText(timeline);
    expect(keep.data?.titleHidden).toBe(false);
  });

  it("a card the user edited always shows its words on screen, whatever the budget decided before", async () => {
    quiet();
    const { timeline } = plan640();
    const hidden = cards(timeline).find((g) => g.data?.titleHidden === true)!;
    (hidden as { editedByUser?: boolean }).editedByUser = true;
    hidden.label = "My own title";
    const { timelineToRemotionProps } = await import("./remotionProps");
    const props = timelineToRemotionProps({ timeline });
    const spec = props.graphics.find((g) => g.id === hidden.id)!;
    expect(spec.data.titleHidden).toBe(false);
    const other = props.graphics.find((g) => g.id !== hidden.id && g.data.titleHidden === true);
    expect(other).toBeDefined();
  });

  it("Remotion draws a title-hidden card's ground and no words; the opening word and user edits are untouched", () => {
    const GRAPHICS = fs.readFileSync(path.join(__dirname, "remotion", "components", "Graphics.tsx"), "utf8");
    expect(GRAPHICS).toContain("body = g.data?.titleHidden === true ? null : (");
    const DIRECTOR = fs.readFileSync(path.join(__dirname, "onScreenTextDirector.ts"), "utf8");
    expect(DIRECTOR).toContain("export const GRAPHIC_MOMENTS_PER_MINUTE = 3;");
    expect(DIRECTOR).toContain('(i.el as TimelineGraphic).graphicType === "chapter_card" &&');
    expect(DIRECTOR).toContain("(i.el as { editedByUser?: boolean }).editedByUser !== true;");
  });
});

/* ═══════════════════════ A–D — the last YouTube stage, for real ═══════════════════════ */

let n = 0;
const moment = (seconds: number) => video(`scene_0_ytfu_1m${n}_t${1300 + n++}d23__pid_youtube_cc-5ae6199e012718d5.mp4`, seconds);
const vbeat = (index: number) => ({ index, text: `sentence ${index}`, holdSec: 3.5, keywords: [] as string[] });
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
const result = (clipBeatIndices: number[]) => ({ clips: clipBeatIndices.map(() => "/w/c.mp4"), beatDurations: clipBeatIndices.map(() => 3.5), clipBeatIndices });
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
function handTo(d: object, s: number, b: number, paths: string[]) {
  for (const p of paths) vp.noteLookaheadCandidateReady(d, vp.youtubeTurnKey(s, b), p);
  return vp.takeReadyLookaheadCandidates(d, vp.youtubeTurnKey(s, b));
}
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const FINAL = { sceneReturned: true, final: true } as const;
const FAST = { windowMs: 100, looksMs: 5_000 };

describe("TEST A–D — the last YouTube stage on the real scene shape", () => {
  it("A — fetchSceneVisuals' shape has no beats; the stage reads the render's record and reaches D/E/F", async () => {
    quiet();
    const d = state({ 0: [vbeat(0), vbeat(1)] });
    closedScene(d, 0);
    handTo(d, 0, 1, [moment(6)]);
    const look = editor(d, 0, 1, () => true);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [result([0])], look, FAST);
    expect(look).toHaveBeenCalledTimes(1);
  });

  it("B — review still running when the scene closed, past the window: the moment is recovered and placed", async () => {
    quiet();
    const d = state({ 1: [vbeat(0), vbeat(1), vbeat(2), vbeat(3), vbeat(4)] });
    const placer = closedScene(d, 1);
    const m = moment(6);
    handTo(d, 1, 4, [m]);
    vp.noteReviewInFlight(d, vp.youtubeTurnKey(1, 4), new Promise(() => {}));
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 1 }], [result([])], editor(d, 1, 4, () => true), FAST);
    expect(await vp.placeApprovedAfterSceneClosed(d, 1, FINAL)).toContainEqual({ beatIndex: 4, clip: m, hold: 3.5 });
    expect(placer).toHaveBeenCalledWith(m, 4);
  });

  for (const [label, s, b, seconds] of [["C — s0b0", 0, 0, 2.29], ["D — s2b2", 2, 2, 2.6]] as const) {
    it(`${label}: approved moment prepared to ${seconds} s → refused by the 3 s rule → the next moment found is placed`, async () => {
      quiet();
      const d = state({ [s]: [vbeat(0), vbeat(1), vbeat(2), vbeat(3)] });
      closedScene(d, s);
      const short = moment(seconds);
      const next = moment(6);
      handTo(d, s, b, [short, next]);
      const look = editor(d, s, b, () => true);
      await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: s }], [result([])], look, FAST);
      expect(look).toHaveBeenCalledTimes(2);
      expect(await vp.placeApprovedAfterSceneClosed(d, s, FINAL)).toContainEqual({ beatIndex: b, clip: next, hold: 3.5 });
    });
  }

  it("the 640 cause: inside a scene whose clock ran out the old probe reads 0; the 3 s gate's probe still measures", async () => {
    quiet();
    const f = moment(2.29);
    const got: { scoped?: number; gate?: number } = {};
    await vp
      .withSceneFetchTimeout(async () => {
        await new Promise((r) => setTimeout(r, 40));
        got.scoped = await vp.probeVideoDurationSec(f);
        got.gate = await vp.probeDurationForMinimumRule(f);
        return null;
      }, 10, "test scene clock")
      .catch(() => null);
    for (let i = 0; i < 100 && got.gate === undefined; i++) await new Promise((r) => setTimeout(r, 50));
    expect(got.scoped).toBe(0);
    expect(got.gate).toBeGreaterThan(2.2);
    expect(got.gate).toBeLessThan(3);
    const { belowArchiveMinimumDuration, MIN_VIDEO_DURATION_SEC } = await import("./archiveIngestion");
    expect(MIN_VIDEO_DURATION_SEC).toBe(3);
    expect(belowArchiveMinimumDuration(got.scoped!)).toBe(false);
    expect(belowArchiveMinimumDuration(got.gate!)).toBe(true);
  });

  it("the gate before review and FIX F both use that probe; the rule itself is the archive's, unchanged", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE).toContain("if (isYoutubeMomentPath(p) && belowArchiveMinimumDuration(await probeDurationForMinimumRule(p))) {");
    expect(PIPE).toContain("  measure: (clip: string) => Promise<number> = probeDurationForMinimumRule,\n");
    expect(PIPE).toContain("return sceneFetchScopeStorage.exit(() => probeVideoDurationSec(filePath));");
  });
});
