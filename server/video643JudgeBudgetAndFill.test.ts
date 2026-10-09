import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  JUDGE_BUDGET_EXHAUSTED,
  JUDGE_BUDGET_MAX_CEILING_MS,
  JUDGE_BUDGET_MIN_CEILING_MS,
  createJudgeBudget,
  judgeBudgetCeilingMs,
} from "./judgeBudget";

/**
 * VIDEO 643 — A (the picture editor's own time), D (FIT → placed), E (several shots per sentence).
 *
 *     20:16:38  the last looks start: 9 sentences, 34 moments, one fixed 45 s window
 *     20:17:20  the film goes on — 9 reviews still running: 35.46 s of cards "REVIEW_TIMEOUT"
 *     20:18:51  s2b2's FIT arrives after the film was assembled — APPROVED_NOT_PLACED
 *     BeatFill 0: the fill lived inside the scenes, behind a scope that had expired (110 SCOPE_EXPIRED)
 *
 * Driven through the stage the pipeline runs (`runFinalReadyYoutubeStage`, `runFinalBeatFillStage`)
 * and the real late placement (`placeApprovedAfterSceneClosed`); only the picture editor is a stand-in.
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
beforeAll(async () => {
  vp = await import("./videoPipeline");
  bvr = await import("./beatVisualRelevance");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-643-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const logs: string[] = [];
const capture = () => {
  logs.length = 0;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let n = 0;
/** A YouTube moment file as the pipeline names it: its own seconds (`t…d…`) of one source video. */
const moment = (videoId = "d72b145386fde4d1") => {
  const p = path.join(dir, `scene_1_ytfu_0m${n}_t${3000 + 50 * n++}d40__pid_youtube_cc-${videoId}.mp4`);
  fs.writeFileSync(p, "moment");
  return p;
};
const beat = (index: number, holdSec = 3.5) => ({ index, text: `sentence ${index}`, holdSec, keywords: [] as string[] });

function renderState(beatsByScene: Record<number, ReturnType<typeof beat>[]>) {
  return {
    lateYoutubeCandidates: [] as string[],
    beatRelevance: bvr.createBeatRelevanceLedger(),
    beatImageGate: { judgementAttempts: 0, judgementsFits: 0, judgementsMismatch: 0 },
    visionReviewPool: { beats: new Map() },
    usedContentKeys: new Set<string>(),
    sceneBeatsBySceneIndex: new Map(Object.entries(beatsByScene).map(([k, v]) => [Number(k), v])),
  };
}
type State = ReturnType<typeof renderState>;
const asDedup = (d: State) => d as unknown as Parameters<VP["runFinalReadyYoutubeStage"]>[0];
const noClips = { clips: [] as string[], beatDurations: [] as number[], clipBeatIndices: [] as number[] };
const FINAL = { sceneReturned: true, final: true } as const;

/** The picture editor as `adoptClip` reports it, taking `ms` per review: a FIT registers its approval. */
const editor = (d: State, s: number, b: number, fits: (p: string) => boolean, ms = 0) =>
  vi.fn(async (_beat: unknown, _scene: number, paths: string[]) => {
    if (ms) await sleep(ms);
    for (const p of paths) {
      if (!d.beatRelevance.byBeat.has(bvr.beatRelevanceBeatKey(s, b, "path", p))) {
        d.beatRelevance.spendByBeat.set(`s${s}b${b}`, (d.beatRelevance.spendByBeat.get(`s${s}b${b}`) ?? 0) + 1);
        d.beatImageGate.judgementAttempts++;
        if (fits(p)) d.beatImageGate.judgementsFits++;
        else d.beatImageGate.judgementsMismatch++;
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

/* ═══════════════════════ A — the picture editor's own time ═══════════════════════ */

describe("A — the budget itself", () => {
  it("starts at what the stage had, grows by every look it is given, never past its ceiling", () => {
    let t = 1_000;
    const b = createJudgeBudget({ baseMs: 55_000, perLookMs: 5_000, ceilingMs: 180_000, now: () => t });
    expect(b.grantedMs()).toBe(55_000);
    b.grant(8);
    expect(b.grantedMs()).toBe(55_000);
    b.grant(26);
    /** 643: 34 moments → 170 s, more than the 133 s the last review needed. */
    expect(b.grantedMs()).toBe(170_000);
    b.grant(100);
    expect(b.grantedMs()).toBe(180_000);
    t += 60_000;
    expect(b.leftMs()).toBe(120_000);
    expect(b.usedMs()).toBe(60_000);
  });

  it("the ceiling follows the video's length, is never endless, never past force-export, never below what the stage had", () => {
    expect(judgeBudgetCeilingMs(57, Infinity, 55_000)).toBe(JUDGE_BUDGET_MIN_CEILING_MS);
    expect(judgeBudgetCeilingMs(600, Infinity, 55_000)).toBe(JUDGE_BUDGET_MAX_CEILING_MS);
    expect(judgeBudgetCeilingMs(120, Infinity, 55_000)).toBe(360_000);
    expect(judgeBudgetCeilingMs(120, 360_000, 55_000)).toBeGreaterThan(judgeBudgetCeilingMs(57, 360_000, 55_000));
    expect(judgeBudgetCeilingMs(600, 90_000, 55_000)).toBe(90_000);
    expect(judgeBudgetCeilingMs(600, -5_000, 55_000)).toBe(55_000);
    expect(Number.isFinite(judgeBudgetCeilingMs(Number.NaN, Infinity, 55_000))).toBe(true);
  });
});

describe("A — the last looks are not cut off by a clock that is not the picture editor's", () => {
  it("643 s2b2 replayed: a review needing longer than the old 45 s window finishes inside its own budget — FIT placed, no REVIEW_TIMEOUT", async () => {
    capture();
    const d = renderState({ 1: [beat(0)] });
    const placer = closedScene(d, 1);
    const [m1, m2, fit] = [moment(), moment(), moment()];
    handTo(d, 1, 0, [m1, m2, fit]);
    const look = editor(d, 1, 0, (p) => p === fit, 600);
    /** Scaled 643: the fixed window (100 ms ≈ 45 s) is shorter than the review (600 ms ≈ 133 s); 3 looks × 1 s = 3 s. */
    const budget = createJudgeBudget({ baseMs: 100, perLookMs: 1_000, ceilingMs: 5_000 });
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 1 }], [noClips], look, { windowMs: 50, budget });
    expect(look).toHaveBeenCalledTimes(1);
    expect(vp.reviewTimedOutBeforeFinalize(d, 1, 0)).toBe(false);
    expect(vp.judgeBudgetExhaustedFor(d, 1, 0)).toBe(false);
    expect(await vp.placeApprovedAfterSceneClosed(d, 1, FINAL)).toEqual([{ beatIndex: 0, clip: fit, hold: 3.5 }]);
    expect(placer).toHaveBeenCalledWith(fit, 0);
    expect(logs.some((l) => l.startsWith("[JudgeBudget] granted=3000ms") && l.includes("queued=3") && l.includes("FIT=1") && l.includes("MISMATCH=2") && l.includes("stop=ALL_REVIEWED"))).toBe(true);
  });

  it("the same review WITHOUT the budget (the fixed window of 643) is cut off and its FIT lost", async () => {
    capture();
    const d = renderState({ 1: [beat(0)] });
    closedScene(d, 1);
    const fit = moment();
    handTo(d, 1, 0, [moment(), moment(), fit]);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 1 }], [noClips], editor(d, 1, 0, (p) => p === fit, 600), { windowMs: 50, looksMs: 100 });
    expect(vp.reviewTimedOutBeforeFinalize(d, 1, 0)).toBe(true);
    expect(await vp.placeApprovedAfterSceneClosed(d, 1, FINAL)).toEqual([]);
    await sleep(700);
  });

  it("a review already running when its scene closed is carried into the budget, not named timed out at the window", async () => {
    capture();
    const d = renderState({ 1: [beat(0)] });
    closedScene(d, 1);
    vp.noteReviewInFlight(d, vp.youtubeTurnKey(1, 0), sleep(300));
    const t0 = Date.now();
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 1 }], [noClips], editor(d, 1, 0, () => false), {
      windowMs: 50,
      budget: createJudgeBudget({ baseMs: 2_000, perLookMs: 0, ceilingMs: 2_000 }),
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(vp.reviewTimedOutBeforeFinalize(d, 1, 0)).toBe(false);
    expect(vp.judgeBudgetExhaustedFor(d, 1, 0)).toBe(false);
    expect(logs.some((l) => l.includes("carried into the picture editor's own budget"))).toBe(true);
  });

  it("when the budget really runs out the stop is the budget's, named per sentence — not a REVIEW_TIMEOUT — and the render goes on", async () => {
    capture();
    const d = Object.assign(renderState({ 1: [beat(0)] }), { rejections: vp.createVisualDedupState(vp.getPipelinePerfProfile("1")).rejections });
    closedScene(d, 1);
    handTo(d, 1, 0, [moment()]);
    const t0 = Date.now();
    const stuck = vi.fn(() => new Promise<string | null>(() => {}));
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 1 }], [noClips], stuck, {
      windowMs: 50,
      budget: createJudgeBudget({ baseMs: 100, perLookMs: 100, ceilingMs: 300 }),
    });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(vp.judgeBudgetExhaustedFor(d, 1, 0)).toBe(true);
    expect(vp.reviewTimedOutBeforeFinalize(d, 1, 0)).toBe(false);
    expect(vp.graphicOnlyReasonFor(d as never, 1, 0)).toBe(JUDGE_BUDGET_EXHAUSTED);
    expect(logs.some((l) => l.includes("stop=JUDGE_BUDGET_EXHAUSTED") && l.includes("notReviewed=[s1b0]"))).toBe(true);
  });

  it("what was handed to THIS sentence is looked at before the leftovers offered to any next sentence", async () => {
    capture();
    const d = renderState({ 1: [beat(0)] });
    const leftover = moment("c6999ce951b2e30d");
    d.lateYoutubeCandidates = [leftover];
    const mine = moment();
    handTo(d, 1, 0, [mine]);
    const look = vi.fn(async (_paths: string[]) => null);
    await vp.finalReadyYoutubeLook(asDedup(d), 1, 0, look, async () => 4);
    expect(look.mock.calls[0]![0]).toEqual([mine, leftover]);
  });

  it("wired: the pipeline gives the stage its own budget, bounded by length and force-export; nothing in it reads a scene's clock", () => {
    expect(PIPE).toContain("const judgeBudget = createJudgeBudget({");
    expect(PIPE).toContain("ceilingMs: judgeBudgetCeilingMs(");
    expect(PIPE).toContain("pipelineEmergencyFinishMs(videoLength) - Date.now(),");
    expect(PIPE).toContain("{ budget: judgeBudget },");
    for (const sig of ["export async function runFinalReadyYoutubeStage(", "export async function runFinalBeatFillStage(", "export async function finalLooksWithin("]) {
      expect(bodyOf(sig)).not.toMatch(/remainingScopeMs|BEAT_FILL_MIN_SCOPE_MS|sceneFetchScope/);
    }
  });
});

/* ═══════════════════════ D — FIT → placed, no silent loss ═══════════════════════ */

describe("D — approved against placed", () => {
  it("every difference is named with the reason the render recorded; none recorded is UNRECORDED", () => {
    const d = {};
    vp.noteApprovedPickForBeat(d, 0, 0, "youtube_cc:aaaaaaaaaaaaaaaa@t100d40");
    vp.noteApprovedPickForBeat(d, 0, 1, "youtube_cc:bbbbbbbbbbbbbbbb@t100d40");
    vp.noteApprovedPickForBeat(d, 0, 2, "youtube_cc:cccccccccccccccc@t100d40");
    vp.noteApprovedPickForBeat(d, 0, 3, "youtube_cc:dddddddddddddddd@t100d40");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vp.noteApprovedNotPlaced(d, 0, 1, "approved after scene closed — not placed");
    vp.noteJudgeBudgetExhausted(d, 0, 3);
    const placed: Record<number, number> = { 0: 1, 1: 0, 2: 0, 3: 0 };
    const lines = vp.formatFitPlacementCheck(d, [0, 1, 2, 3].map((b) => ({ sceneIndex: 0, beatIndex: b })), (_s, b) => placed[b]!);
    expect(lines[0]).toBe("[FitPlacement] TOTAL approvedRealShots=4 placedRealShots=1 lost=3 causes={LIMIT=1 IN_REVIEW=1 UNRECORDED=1}");
    expect(lines).toContain("[FitPlacement] s0b1 approved=1 placed=0 lost=1 reason=approved after scene closed — not placed causes={LIMIT=1}");
    expect(lines).toContain("[FitPlacement] s0b2 approved=1 placed=0 lost=1 reason=UNRECORDED causes={UNRECORDED=1}");
    expect(lines).toContain(`[FitPlacement] s0b3 approved=1 placed=0 lost=1 reason=${JUDGE_BUDGET_EXHAUSTED} causes={IN_REVIEW=1}`);
    expect(lines.some((l) => l.includes("s0b0"))).toBe(false);
  });

  it("a FIT from the last looks goes FIT → approved → placed: nothing lost", async () => {
    capture();
    const d = renderState({ 1: [beat(0)] });
    closedScene(d, 1);
    const fit = moment();
    handTo(d, 1, 0, [fit]);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 1 }], [noClips], editor(d, 1, 0, () => true, 200), {
      windowMs: 50,
      budget: createJudgeBudget({ baseMs: 100, perLookMs: 3_000, ceilingMs: 5_000 }),
    });
    const placed = await vp.placeApprovedAfterSceneClosed(d, 1, FINAL);
    expect(placed.map((p) => p.clip)).toEqual([fit]);
    expect(vp.formatFitPlacementCheck(d, [{ sceneIndex: 1, beatIndex: 0 }], () => placed.length)[0]).toBe(
      "[FitPlacement] TOTAL approvedRealShots=1 placedRealShots=1 lost=0"
    );
  });

  it("wired: the check runs after the last placement pass, before generated images", () => {
    const finalPass = PIPE.indexOf("for (let si = 0; si < scenes.length; si++) await placeLate(si, true);");
    const check = PIPE.indexOf("for (const line of formatFitPlacementCheck(visualDedup, allSentences, realShotsOf, realShotKeysOf)) console.log(line);");
    const generated = PIPE.indexOf("await generateMissingBeatImages(scenes, sceneVisualResults, visualDedup, workDir, topicContext);");
    expect(finalPass).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(finalPass);
    expect(check).toBeLessThan(generated);
  });
});

/* ═══════════════════════ E — several good shots per sentence ═══════════════════════ */

/**
 * The film's result for scenes whose sentences already have shots, with the scene's late placer as the
 * pipeline opens it (a second picture only for the seconds still uncovered) and the pass that merges
 * what it placed (`placeLate`).
 */
function film(beatsByScene: Record<number, Array<{ beat: ReturnType<typeof beat>; shots: number[] }>>, clipSec: (clip: string) => number) {
  const d = renderState(Object.fromEntries(Object.entries(beatsByScene).map(([s, list]) => [s, list.map((x) => x.beat)])));
  const result = new Map<number, { clips: string[]; beatDurations: number[]; clipBeatIndices: number[] }>();
  for (const [sKey, list] of Object.entries(beatsByScene)) {
    const s = Number(sKey);
    const r = { clips: [] as string[], beatDurations: [] as number[], clipBeatIndices: [] as number[] };
    for (const { beat: b, shots } of list) for (const sec of shots) {
      r.clips.push(path.join(dir, `scene_${s}_first_b${b.index}_${n++}.mp4`));
      r.beatDurations.push(sec);
      r.clipBeatIndices.push(b.index);
    }
    result.set(s, r);
    const holdOf = (bi: number) => list.find((x) => x.beat.index === bi)!.beat.holdSec;
    vp.openLatePlacement(d, s, async (clip, bi) => {
      const left = vp.beatSecondsLeft(holdOf(bi), bi, r.clipBeatIndices, r.beatDurations);
      if (r.clipBeatIndices.includes(bi) && left < vp.BEAT_EXTRA_SHOT_MIN_SEC) return "has_picture";
      return { hold: Math.min(left, clipSec(clip)) };
    });
    vp.markSceneClosed(d, s);
  }
  const secondsLeft = (s: number, bi: number) => {
    const r = result.get(s)!;
    const b = beatsByScene[s]!.find((x) => x.beat.index === bi)!.beat;
    return vp.beatSecondsLeft(b.holdSec, bi, r.clipBeatIndices, r.beatDurations);
  };
  const io = (adoptAnother: (s: number, b: number) => Promise<string | null>) => ({
    hasRealPicture: (s: number, bi: number) => result.get(s)!.clipBeatIndices.includes(bi),
    secondsLeft,
    place: async (s: number) => {
      const placed = await vp.placeApprovedAfterSceneClosed(d, s, { sceneReturned: true, final: false, hasPicture: (bi) => secondsLeft(s, bi) < vp.BEAT_EXTRA_SHOT_MIN_SEC });
      const r = result.get(s)!;
      for (const p of placed) {
        r.clips.push(p.clip);
        r.beatDurations.push(p.hold);
        r.clipBeatIndices.push(p.beatIndex);
      }
    },
    adoptAnother,
  });
  const sentences = Object.entries(beatsByScene).flatMap(([s, list]) => list.map((x) => ({ sceneIndex: Number(s), beatIndex: x.beat.index })));
  const shotsOf = (s: number, bi: number) => result.get(s)!.clipBeatIndices.filter((x) => x === bi).length;
  const secondsOf = (s: number, bi: number) => result.get(s)!.beatDurations.filter((_, i) => result.get(s)!.clipBeatIndices[i] === bi).reduce((a, x) => a + x, 0);
  return { d, result, io, sentences, shotsOf, secondsOf, secondsLeft };
}
/** The picture editor handing out FITs for a sentence, in order, as `adoptAnotherFitForBeat` would (approval registered). */
const fitsFor = (d: object, queue: Record<string, string[]>) =>
  vi.fn(async (s: number, b: number) => {
    const next = queue[`${s}:${b}`]?.shift() ?? null;
    if (next) vp.noteApprovedPickForBeat(d, s, b, vp.clipContentKey(next));
    return next;
  });
const bigBudget = () => createJudgeBudget({ baseMs: 5_000, perLookMs: 0, ceilingMs: 5_000 });

describe("E — another FIT for a sentence, inside the picture editor's own time", () => {
  it("10 s sentence: first shot 3.5 s, two more FITs (3.0 s, 3.5 s) — three shots, exactly 10 s, then it stops", async () => {
    capture();
    const [a, b] = [moment(), moment("c6999ce951b2e30d")];
    const f = film({ 1: [{ beat: beat(0, 10), shots: [3.5] }] }, (c) => (c === a ? 3 : 4));
    const adopt = fitsFor(f.d, { "1:0": [a, b, moment()] });
    const out = await vp.runFinalBeatFillStage(f.d as never, f.sentences, bigBudget(), f.io(adopt));
    expect(out.added).toBe(2);
    expect(f.shotsOf(1, 0)).toBe(3);
    expect(f.secondsOf(1, 0)).toBeCloseTo(10, 5);
    expect(adopt).toHaveBeenCalledTimes(2);
    expect(logs.filter((l) => l.startsWith("[BeatFill] s1b0: added")).length).toBe(2);
  });

  it("two FITs from the SAME source (other seconds) are both placed", async () => {
    capture();
    const [a, b] = [moment("d72b145386fde4d1"), moment("d72b145386fde4d1")];
    const f = film({ 1: [{ beat: beat(0, 10), shots: [3.5] }] }, () => 3.2);
    await vp.runFinalBeatFillStage(f.d as never, f.sentences, bigBudget(), f.io(fitsFor(f.d, { "1:0": [a, b] })));
    expect(f.result.get(1)!.clips).toEqual(expect.arrayContaining([a, b]));
  });

  it("two FITs from DIFFERENT sources are both placed", async () => {
    capture();
    const [a, b] = [moment("aaaaaaaaaaaaaaaa"), moment("bbbbbbbbbbbbbbbb")];
    const f = film({ 1: [{ beat: beat(0, 10), shots: [3.5] }] }, () => 3.2);
    await vp.runFinalBeatFillStage(f.d as never, f.sentences, bigBudget(), f.io(fitsFor(f.d, { "1:0": [a, b] })));
    expect(f.result.get(1)!.clips).toEqual(expect.arrayContaining([a, b]));
  });

  it("the 3 s minimum: a sentence with 2.5 s uncovered is not asked for another shot", async () => {
    capture();
    const f = film({ 1: [{ beat: beat(0, 5.5), shots: [3] }] }, () => 4);
    const adopt = fitsFor(f.d, { "1:0": [moment()] });
    await vp.runFinalBeatFillStage(f.d as never, f.sentences, bigBudget(), f.io(adopt));
    expect(adopt).not.toHaveBeenCalled();
    expect(f.shotsOf(1, 0)).toBe(1);
  });

  it("the 3 s minimum after an extra shot: 10 s sentence, 3.5 s + 4.5 s placed — the 2 s left are not asked for", async () => {
    capture();
    const f = film({ 1: [{ beat: beat(0, 10), shots: [3.5] }] }, () => 4.5);
    const adopt = fitsFor(f.d, { "1:0": [moment(), moment(), moment()] });
    await vp.runFinalBeatFillStage(f.d as never, f.sentences, bigBudget(), f.io(adopt));
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(f.shotsOf(1, 0)).toBe(2);
    /** 2 s stay uncovered: under the 3 s minimum an extra shot is never asked for (the timeline holds the last shot). */
    expect(f.secondsLeft(1, 0)).toBeCloseTo(2, 5);
    expect(f.secondsOf(1, 0)).toBeCloseTo(8, 5);
  });

  it("a sentence without any real picture is the last looks' work, not the fill's", async () => {
    capture();
    const f = film({ 1: [{ beat: beat(0, 10), shots: [] }] }, () => 4);
    const adopt = fitsFor(f.d, { "1:0": [moment()] });
    await vp.runFinalBeatFillStage(f.d as never, f.sentences, bigBudget(), f.io(adopt));
    expect(adopt).not.toHaveBeenCalled();
  });

  it("a longer film: every sentence of several scenes is filled up to its length, never past it", async () => {
    capture();
    const scenes = { 0: [0, 1, 2].map((i) => ({ beat: beat(i, 8), shots: [3.5] })), 1: [0, 1, 2].map((i) => ({ beat: beat(i, 8), shots: [3.5] })) };
    const f = film(scenes, () => 6);
    const queue: Record<string, string[]> = {};
    for (const s of [0, 1]) for (const i of [0, 1, 2]) queue[`${s}:${i}`] = [moment(), moment(), moment()];
    await vp.runFinalBeatFillStage(f.d as never, f.sentences, bigBudget(), f.io(fitsFor(f.d, queue)));
    for (const s of [0, 1]) for (const i of [0, 1, 2]) {
      expect(f.shotsOf(s, i)).toBe(2);
      expect(f.secondsOf(s, i)).toBeLessThanOrEqual(8 + 1e-9);
      expect(f.secondsLeft(s, i)).toBeLessThan(vp.BEAT_EXTRA_SHOT_MIN_SEC);
    }
  });

  it("bounded by the same budget: a review still running when it runs out is named, the render goes on", async () => {
    capture();
    const f = film({ 1: [{ beat: beat(0, 10), shots: [3.5] }] }, () => 4);
    const t0 = Date.now();
    const out = await vp.runFinalBeatFillStage(f.d as never, f.sentences, createJudgeBudget({ baseMs: 150, perLookMs: 0, ceilingMs: 150 }), f.io(() => new Promise(() => {})));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(out.stop).toBe(JUDGE_BUDGET_EXHAUSTED);
    expect(logs.some((l) => l.includes(`(${JUDGE_BUDGET_EXHAUSTED})`))).toBe(true);
  });

  it("wired between the last looks and the final placement pass", () => {
    const stage = PIPE.indexOf("await runFinalReadyYoutubeStage(visualDedup, scenes, sceneVisualResults, (beat, sceneIndex, ready) =>");
    const fill = PIPE.indexOf("await runFinalBeatFillStage(visualDedup, allSentences, judgeBudget, {");
    const finalPass = PIPE.indexOf("for (let si = 0; si < scenes.length; si++) await placeLate(si, true);");
    expect(stage).toBeGreaterThan(0);
    expect(fill).toBeGreaterThan(stage);
    expect(fill).toBeLessThan(finalPass);
    expect(PIPE.slice(fill, fill + 900)).toContain("adoptAnother: (sceneIndex, beatIndex) => adoptAnotherFitForBeat(visualDedup, sceneIndex, beatIndex, workDir),");
  });
});

describe("E — what may be another shot: only a FIT, never a refused or used moment (`adoptAnotherFitForBeat`)", () => {
  const realDedup = () => vp.createVisualDedupState(vp.getPipelinePerfProfile("1"));
  const call = (paths: string[]) => ({ paths, beatText: "sentence 0", sourceQuery: "q", opts: {} });

  it("a moment the editor refused for THIS sentence (MISMATCH) is not offered again as its other picture", async () => {
    const d = realDedup();
    const [refused, other] = [moment(), moment()];
    d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(1, 0, "content", vp.clipContentKey(refused)), {
      decision: { verdict: "does_not_fit", evaluated: true, reason: "hard_mismatch" },
    } as never);
    (d.beatCandidateCalls ??= new Map()).set("1:0", [call([refused, other])]);
    const adopt = vi.fn(async (paths: string[]) => paths[0] ?? null);
    expect(await vp.adoptAnotherFitForBeat(d, 1, 0, dir, adopt)).toBe(other);
    expect(adopt.mock.calls[0]![0]).toEqual([other]);
  });

  it("a moment already in the film (same file or same seconds) is not offered — no duplicate, no overlap", async () => {
    const d = realDedup();
    const [used, fresh] = [moment(), moment()];
    d.usedPaths.add(used);
    (d.beatCandidateCalls ??= new Map()).set("1:0", [call([used, fresh])]);
    const adopt = vi.fn(async (paths: string[]) => paths[0] ?? null);
    expect(await vp.adoptAnotherFitForBeat(d, 1, 0, dir, adopt)).toBe(fresh);
  });

  it("the adoption is FIT-only (`fitOnly`): a held or unclear moment is never another picture", () => {
    expect(bodyOf("export async function adoptAnotherFitForBeat(")).toContain("{ ...call.opts, fitOnly: true }");
    expect(PIPE).toContain('if (opts.fitOnly && beatEvidence !== "FIT") {');
  });
});

/* ═══════════════════════ last check before commit — the gaps the review found ═══════════════════════ */

describe("A — a cancelled render does not wait for its picture editor", () => {
  it("the budget ends at once when the render is cancelled: the stage returns within a second, stop=RENDER_CANCELLED", async () => {
    capture();
    const d = renderState({ 1: [beat(0)] });
    closedScene(d, 1);
    handTo(d, 1, 0, [moment()]);
    let cancelled = false;
    setTimeout(() => (cancelled = true), 200);
    const t0 = Date.now();
    const budget = createJudgeBudget({ baseMs: 60_000, perLookMs: 0, ceilingMs: 60_000, stopWhen: () => cancelled });
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 1 }], [noClips], vi.fn(() => new Promise<string | null>(() => {})), { windowMs: 50, budget });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(budget.stopped()).toBe(true);
    expect(budget.leftMs()).toBe(0);
    expect(logs.some((l) => l.startsWith("[JudgeBudget] granted=") && l.includes("stop=RENDER_CANCELLED"))).toBe(true);
  });

  it("wired: the pipeline's budget stops on a cancelled or superseded render, and the render checks right after the stage", () => {
    const at = PIPE.indexOf("const judgeBudget = createJudgeBudget({");
    expect(PIPE.slice(at, at + 1200)).toContain("throwIfActiveRenderCancelled();\n          return false;");
    const stageEnd = PIPE.indexOf("      clearInterval(judgePulse);\n    }\n    throwIfActiveRenderCancelled();\n    for (let si = 0; si < scenes.length; si++) await placeLate(si, true);");
    expect(stageEnd).toBeGreaterThan(at);
  });
});

describe("E — the final fill has no deadline of its own, and names what the budget left unasked", () => {
  it("a look granted while the fill waits extends its wait (one budget, not a timer fixed at the start)", async () => {
    capture();
    const fit = moment();
    const f = film({ 1: [{ beat: beat(0, 10), shots: [3.5] }] }, () => 4);
    const budget = createJudgeBudget({ baseMs: 200, perLookMs: 100, ceilingMs: 3_000 });
    const adopt = vi.fn(async (s: number, b: number) => {
      await sleep(50);
      budget.grant(10);
      await sleep(350);
      vp.noteApprovedPickForBeat(f.d, s, b, vp.clipContentKey(fit));
      return adopt.mock.calls.length === 1 ? fit : null;
    });
    const out = await vp.runFinalBeatFillStage(f.d as never, f.sentences, budget, f.io(adopt));
    expect(f.result.get(1)!.clips).toContain(fit);
    expect(out.added).toBe(1);
  });

  it("when the budget runs out, every sentence not (fully) asked is named", async () => {
    capture();
    const f = film({ 1: [{ beat: beat(0, 10), shots: [3.5] }, { beat: beat(1, 10), shots: [3.5] }, { beat: beat(2, 10), shots: [3.5] }] }, () => 4);
    const out = await vp.runFinalBeatFillStage(f.d as never, f.sentences, createJudgeBudget({ baseMs: 150, perLookMs: 0, ceilingMs: 150 }), f.io(() => new Promise(() => {})));
    expect(out.stop).toBe(JUDGE_BUDGET_EXHAUSTED);
    expect(logs.some((l) => l.startsWith("[BeatFill] final stage done:") && l.includes("notAsked=[s1b0,s1b1,s1b2]"))).toBe(true);
  });

  it("10 s sentence filled 3 + 3 + 4: three FIT shots, exactly the narration, then nothing more is asked", async () => {
    capture();
    const [a, b] = [moment(), moment("bbbbbbbbbbbbbbbb")];
    const f = film({ 1: [{ beat: beat(0, 10), shots: [3] }] }, (c) => (c === a ? 3 : 4));
    const adopt = fitsFor(f.d, { "1:0": [a, b, moment()] });
    await vp.runFinalBeatFillStage(f.d as never, f.sentences, bigBudget(), f.io(adopt));
    expect(f.result.get(1)!.beatDurations).toEqual([3, 3, 4]);
    expect(f.secondsOf(1, 0)).toBeCloseTo(10, 5);
    expect(adopt).toHaveBeenCalledTimes(2);
  });

  it("never more than three extra shots per sentence (BEAT_FILL_MAX_EXTRA_CLIPS), even with seconds left", async () => {
    capture();
    const f = film({ 1: [{ beat: beat(0, 30), shots: [3] }] }, () => 3);
    const adopt = fitsFor(f.d, { "1:0": [moment(), moment(), moment(), moment(), moment()] });
    await vp.runFinalBeatFillStage(f.d as never, f.sentences, bigBudget(), f.io(adopt));
    expect(vp.BEAT_FILL_MAX_EXTRA_CLIPS).toBe(3);
    expect(f.shotsOf(1, 0)).toBe(4);
    expect(adopt).toHaveBeenCalledTimes(3);
  });
});

describe("D — the known losses are named, not UNRECORDED", () => {
  it("an approved moment refused by the 3 s rule after preparing is counted with that reason", async () => {
    capture();
    const d = renderState({ 1: [beat(0)] });
    closedScene(d, 1);
    const short = moment();
    handTo(d, 1, 0, [short]);
    const ed = editor(d, 1, 0, () => true);
    await vp.finalReadyYoutubeLook(asDedup(d), 1, 0, (ready) => ed(null, 1, ready), async () => 2.4);
    const lines = vp.formatFitPlacementCheck(d, [{ sceneIndex: 1, beatIndex: 0 }], () => 0);
    expect(lines[0]).toBe("[FitPlacement] TOTAL approvedRealShots=1 placedRealShots=0 lost=1 causes={TECHNICAL=1}");
    expect(lines[1]).toContain("reason=approved, prepared 2.40s < 3s (3 s rule)");
  });

  it("a FIT arriving after the film was assembled, once the budget ran out, is labelled by the budget — not REVIEW_TIMEOUT", async () => {
    capture();
    const d = renderState({ 1: [beat(0)] });
    closedScene(d, 1);
    await vp.placeApprovedAfterSceneClosed(d, 1, FINAL);
    vp.noteJudgeBudgetExhausted(d, 1, 0);
    handTo(d, 1, 0, [moment()]);
    const ed = editor(d, 1, 0, () => true);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 1, 0, (ready) => ed(null, 1, ready), async () => 4)).toBeNull();
    expect(logs.some((l) => l.includes("approved after the film was assembled — not placed (JUDGE_BUDGET_EXHAUSTED)"))).toBe(true);
  });
});
