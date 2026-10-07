import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * VIDEO 639 — ready YouTube moments vanished when a sentence's scene closed while their review was
 * still running (931e090, the first render after FIX A/B/C):
 *
 *     READY → ASSIGNED → REVIEWING → scene closes → result never taken → not own, not late
 *           → the last look (FIX B) found own=0 late=0 → chapter card            (s0b2 s1b4 s1b5 s2b3)
 *
 *   FIX D  a short, hard window in which reviews ALREADY running get their turn;
 *   FIX E  a moment handed to a sentence and never judged stays findable for that sentence;
 *   FIX F  an approved moment that falls under 3 s after preparing → the next moment already found.
 * Nothing searches, downloads or raises a ceiling; the 3 s rule is the archive's own.
 */

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const BVR = fs.readFileSync(path.join(__dirname, "beatVisualRelevance.ts"), "utf8");
const bodyOf = (signature: string): string => {
  const at = PIPE.indexOf(signature);
  expect(at).toBeGreaterThan(0);
  return PIPE.slice(at, PIPE.indexOf("\n}\n", at));
};
const NO_SEARCH = /fetchYouTubeCCClips|tryBeatRealYouTubeFootage|claimYoutubeTurn|searchYouTube|runCentralYoutubeTurn|downloadYoutube|lookahead\.take/;

type VP = typeof import("./videoPipeline");
type BVRM = typeof import("./beatVisualRelevance");
let vp: VP;
let bvr: BVRM;
let dir: string;
beforeAll(async () => {
  vp = await import("./videoPipeline");
  bvr = await import("./beatVisualRelevance");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-639-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};

const momentOnDisk = (name: string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "moment");
  return p;
};
/** 639's own moments: two YouTube videos, several moments each. */
let n = 0;
const moment = (video = "d72b145386fde4d1") => momentOnDisk(`scene_1_ytfu_0m${n}_t${3600 + n++}d39__pid_youtube_cc-${video}.mp4`);

/** A render's state with the pieces the last look reads: the relevance ledger and the film ceiling. */
const renderState = () => ({
  lateYoutubeCandidates: [] as string[],
  beatRelevance: bvr.createBeatRelevanceLedger(),
  beatImageGate: { judgementAttempts: 0 } as { judgementAttempts: number },
  visionReviewPool: { beats: new Map() },
  usedContentKeys: new Set<string>(),
});
type RenderState = ReturnType<typeof renderState>;
const asDedup = (d: RenderState) => d as unknown as Parameters<VP["finalReadyYoutubeLook"]>[0];

/** A verdict already on file for this sentence (what `beatVisualRelevance` records after a real look). */
const verdictOnFile = (d: RenderState, s: number, b: number, clip: string, verdict: "fits" | "does_not_fit") =>
  d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(s, b, "path", clip), {
    decision: { verdict, evaluated: true, allowed: verdict === "fits" },
  } as never);

/** The picture editor as `adoptClip` reports it: a FIT registers the approval, a look costs one. */
const editor = (d: RenderState, s: number, b: number, fits: (p: string) => boolean) =>
  vi.fn(async (paths: string[]) => {
    for (const p of paths) {
      const known = d.beatRelevance.byBeat.get(bvr.beatRelevanceBeatKey(s, b, "path", p));
      if (!known) {
        d.beatRelevance.spendByBeat.set(`s${s}b${b}`, (d.beatRelevance.spendByBeat.get(`s${s}b${b}`) ?? 0) + 1);
        d.beatImageGate.judgementAttempts++;
        verdictOnFile(d, s, b, p, fits(p) ? "fits" : "does_not_fit");
      }
      if (fits(p)) {
        vp.noteApprovedPickForBeat(d, s, b, vp.clipContentKey(p));
        return p;
      }
    }
    return null;
  });
const playsFor = (seconds: Record<string, number>) => vi.fn(async (clip: string) => seconds[clip] ?? 6);
const FINAL = { sceneReturned: true, final: true } as const;

/** A scene that closed with its film not assembled yet: its push is still open to its own sentences. */
function closedScene(d: object, sceneIndex: number) {
  const placer = vi.fn(async (_clip: string, _beat: number) => ({ hold: 8.14 }));
  vp.openLatePlacement(d, sceneIndex, placer);
  vp.markSceneClosed(d, sceneIndex);
  return placer;
}
/** The sentence's turn takes its ready moments (G3 / PARTIAL): READY → ASSIGNED. */
function handTo(d: object, s: number, b: number, paths: string[]) {
  for (const p of paths) vp.noteLookaheadCandidateReady(d, vp.youtubeTurnKey(s, b), p);
  return vp.takeReadyLookaheadCandidates(d, vp.youtubeTurnKey(s, b));
}
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

/* ═══════════════════════ A — FIX D: a review running at scene close gets its turn ═══════════════════════ */

describe("TEST A — FIX D: a review already running when the scene closes finishes inside the final window", () => {
  it("ready → assigned → review started → scene closes → FIT inside the window → approved and placed", async () => {
    quiet();
    const d = renderState();
    const placer = closedScene(d, 0);
    const clip = moment();
    handTo(d, 0, 2, [clip]);
    /** 639 s0b2: the sentence's ladder was still preparing its approved picture when the scene closed. */
    const ladder = deferred<string | null>();
    vp.noteLadderForBeat(d, 0, 2, vp.approvedPicksForBeat(d, 0, 2), ladder.promise);
    await vp.takeLateApprovedPicks(d, 0, 1);
    vp.noteApprovedPickForBeat(d, 0, 2, vp.clipContentKey(clip));
    setTimeout(() => ladder.resolve(clip), 30);

    const still = await vp.awaitFinalReviewWindow(d, [{ sceneIndex: 0, beatIndex: 2 }], 2_000);
    expect(still).toEqual([]);
    expect(await vp.placeApprovedAfterSceneClosed(d, 0, FINAL)).toEqual([{ beatIndex: 0 + 2, clip, hold: 8.14 }]);
    expect(placer).toHaveBeenCalledWith(clip, 2);
  });

  it("without the window the same answer is lost (what 639 did) — the window is what places it", async () => {
    quiet();
    const d = renderState();
    closedScene(d, 0);
    const clip = moment();
    const ladder = deferred<string | null>();
    vp.noteLadderForBeat(d, 0, 2, 0, ladder.promise);
    await vp.takeLateApprovedPicks(d, 0, 1);
    vp.noteApprovedPickForBeat(d, 0, 2, vp.clipContentKey(clip));
    setTimeout(() => ladder.resolve(clip), 30);
    expect(await vp.placeApprovedAfterSceneClosed(d, 0, FINAL)).toEqual([]);
  });

  it("an in-flight review of handed moments is waited for too, and the wait is hard-bounded", async () => {
    quiet();
    const d = renderState();
    const review = deferred<string | null>();
    vp.noteReviewInFlight(d, vp.youtubeTurnKey(1, 4), review.promise);
    setTimeout(() => review.resolve(null), 20);
    expect(await vp.awaitFinalReviewWindow(d, [{ sceneIndex: 1, beatIndex: 4 }], 2_000)).toEqual([]);

    const stuck = deferred<string | null>();
    vp.noteReviewInFlight(d, vp.youtubeTurnKey(1, 5), stuck.promise);
    const t0 = Date.now();
    expect(await vp.awaitFinalReviewWindow(d, [{ sceneIndex: 1, beatIndex: 5 }], 80)).toEqual([{ sceneIndex: 1, beatIndex: 5 }]);
    expect(Date.now() - t0).toBeLessThan(1_000);
    /** Never silent: the sentence's graphic names why. */
    const { createRejectionRegistry } = await import("./rejectionRegistry");
    Object.assign(d, { rejections: createRejectionRegistry() });
    expect(vp.graphicOnlyReasonFor(d as never, 1, 5)).toBe(vp.REVIEW_TIMEOUT_BEFORE_FINALIZE);
  });

  it("the window is a few seconds, from an existing limit, and only awaits work already running", () => {
    expect(vp.FINAL_REVIEW_WINDOW_MS).toBe(vp.ARCHIVE_JUDGE_MIN_MS);
    expect(vp.FINAL_REVIEW_WINDOW_MS).toBeLessThanOrEqual(10_000);
    expect(vp.FINAL_LOOK_TURN_MS).toBe(vp.JUDGED_BEAT_TURN_MS);
    for (const sig of ["export async function awaitFinalReviewWindow(", "export async function finalLooksWithin(", "async function settledWithin("]) {
      expect(bodyOf(sig)).not.toMatch(NO_SEARCH);
    }
  });

  it("wired before the last looks, the final F2 pass and generated images; for sentences without a picture", () => {
    /** VIDEO 640 — the wiring is one function now; run for real in video640FinalStageAndCards.test.ts. */
    const stage = bodyOf("export async function runFinalReadyYoutubeStage(");
    expect(stage.indexOf("await awaitFinalReviewWindow(dedup, withoutPicture,")).toBeGreaterThan(0);
    expect(stage.indexOf("await awaitFinalReviewWindow(dedup, withoutPicture,")).toBeLessThan(stage.indexOf("await finalLooksWithin(dedup, finalLooks,"));
    const call = PIPE.indexOf("await runFinalReadyYoutubeStage(visualDedup, scenes, sceneVisualResults,");
    const finalPass = PIPE.indexOf("for (let si = 0; si < scenes.length; si++) await placeLate(si, true);");
    const generated = PIPE.indexOf("await generateMissingBeatImages(scenes, sceneVisualResults, visualDedup, workDir, topicContext);");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(finalPass);
    expect(finalPass).toBeLessThan(generated);
  });
});

/* ═══════════════════════ B/C — FIX E: an interrupted review stays findable ═══════════════════════ */

describe("TEST B/C — FIX E: a handed moment with no verdict is found again by the last look", () => {
  it("B — assigned, review interrupted by scene close, pending → recovered → FIT → placed", async () => {
    quiet();
    const d = renderState();
    const placer = closedScene(d, 1);
    const [a, b2] = [moment(), moment("c6999ce951b2e30d")];
    /** 639 s1b4: six moments taken at 14:39:32, scene closed at 14:39:39 — no verdict on any. */
    handTo(d, 1, 4, [a, b2]);
    expect(vp.takeReadyLookaheadCandidates(d, vp.youtubeTurnKey(1, 4))).toEqual([]);
    expect(vp.pendingYoutubeForBeat(d, 1, 4)).toEqual([a, b2]);

    const look = editor(d, 1, 4, (p) => p === b2);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 1, 4, look, playsFor({}))).toBe(b2);
    expect(look).toHaveBeenCalledWith([a, b2]);
    expect(await vp.placeApprovedAfterSceneClosed(d, 1, FINAL)).toEqual([{ beatIndex: 4, clip: b2, hold: 8.14 }]);
    expect(placer).toHaveBeenCalledWith(b2, 4);
  });

  it("C — the pending moment is refused → nothing placed, the normal fallback follows", async () => {
    quiet();
    const d = renderState();
    const placer = closedScene(d, 1);
    handTo(d, 1, 5, [moment()]);
    const look = editor(d, 1, 5, () => false);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 1, 5, look, playsFor({}))).toBeNull();
    expect(look).toHaveBeenCalledTimes(1);
    expect(await vp.placeApprovedAfterSceneClosed(d, 1, FINAL)).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
  });

  it("a YouTube turn cut short still files what it was handed (the pending set is fed by every hand-out)", () => {
    const body = bodyOf("async function tryBeatRealYouTubeFootage(");
    expect(body).toContain("if (!req.lookahead) noteYoutubeAssigned(dedup, youtubeTurnKey(sceneIndex, beat.index), paths);");
    expect(body).toContain("if (!req.lookahead) noteYoutubeAssigned(dedup, youtubeTurnKey(sceneIndex, beat.index), found);");
    expect(bodyOf("export function takeReadyLookaheadCandidates(")).toContain("noteYoutubeAssigned(dedup, turnKey, list);");
    const adopt = bodyOf("export async function adoptHistoricalBeatVideoPool(");
    expect(adopt).toContain("noteReviewInFlight(dedup, youtubeTurnKey(sceneIndex, beat.index), new Promise<void>((r) => (reviewDone = r)));");
    expect(adopt).toContain(".finally(reviewDone);");
  });

  it("pending is per sentence only: another sentence's moments, missing files, used or gate-refused moments are not", () => {
    const d = renderState();
    const [mine, theirs, gone, used, refused] = [moment(), moment(), moment(), moment(), moment()];
    handTo(d, 2, 3, [mine, gone, used, refused]);
    handTo(d, 2, 0, [theirs]);
    fs.rmSync(gone);
    d.usedContentKeys.add(vp.clipContentKey(used));
    d.visionReviewPool.beats.set("2:3", { refusedBeforeEditor: new Map([[vp.clipContentKey(refused), "entity_evidence"]]) });
    expect(vp.pendingYoutubeForBeat(d, 2, 3)).toEqual([mine]);
    expect(vp.pendingYoutubeForBeat(d, 2, 0)).toEqual([theirs]);
  });
});

/* ═══════════════════════ D/E — no second review ═══════════════════════ */

describe("TEST D/E — a verdict already given is never asked again", () => {
  it("D — already APPROVED for this sentence: not pending, no second review", async () => {
    const d = renderState();
    const clip = moment();
    handTo(d, 0, 0, [clip]);
    verdictOnFile(d, 0, 0, clip, "fits");
    expect(vp.pendingYoutubeForBeat(d, 0, 0)).toEqual([]);
    const look = editor(d, 0, 0, () => true);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 0, 0, look, playsFor({}))).toBeNull();
    expect(look).not.toHaveBeenCalled();
  });

  it("E — already REJECTED for this sentence: not pending, no second review", async () => {
    const d = renderState();
    const clip = moment();
    handTo(d, 0, 1, [clip]);
    verdictOnFile(d, 0, 1, clip, "does_not_fit");
    expect(vp.pendingYoutubeForBeat(d, 0, 1)).toEqual([]);
    const look = editor(d, 0, 1, () => true);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 0, 1, look, playsFor({}))).toBeNull();
    expect(look).not.toHaveBeenCalled();
  });

  it("already PLACED: the sentence has its picture, so the wiring never asks", () => {
    /** VIDEO 640 — behaviour, not text: see video640FinalStageAndCards.test.ts ("a sentence with a clip"). */
    expect(bodyOf("export async function runFinalReadyYoutubeStage(")).toContain(
      ".filter((b) => !(results[si]?.clipBeatIndices ?? []).includes(b.index))"
    );
  });
});

/* ═══════════════════════ F/G — the ceilings stay hard ═══════════════════════ */

describe("TEST F/G — look ceilings: 5 per sentence, 120 per film, unchanged and obeyed", () => {
  it("the ceilings themselves are unchanged", () => {
    expect(bvr.maxRelevanceLooksPerBeat()).toBe(5);
    expect(BVR).toContain("return Number.isFinite(n) && n >= 1 && n <= 20 ? n : MAX_JUDGEMENTS_PER_BEAT + 1;");
    const GATE = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(GATE).toContain('return envInt("MAX_BEAT_IMAGE_JUDGEMENTS", 120, 0, 500);');
    expect(bodyOf("export async function finalReadyYoutubeLook(")).not.toMatch(/finalSay|MAX_BEAT_RELEVANCE_LOOKS|maxRelevanceLooks/);
  });

  it("F — the sentence already spent its 5 looks: a pending moment gets no 6th look (BEAT_LOOK_CEILING)", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
    const d = renderState();
    handTo(d, 1, 1, [moment()]);
    d.beatRelevance.spendByBeat.set("s1b1", 5);
    const look = editor(d, 1, 1, () => true);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 1, 1, look, playsFor({}))).toBeNull();
    expect(look).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("reason=BEAT_LOOK_CEILING"))).toBe(true);
  });

  it("F — never more fresh moments than looks left; a review still running holds one back", async () => {
    quiet();
    const d = renderState();
    const ms = [moment(), moment(), moment(), moment()];
    handTo(d, 1, 2, ms);
    d.beatRelevance.spendByBeat.set("s1b2", 2);
    vp.noteReviewInFlight(d, vp.youtubeTurnKey(1, 2), new Promise(() => {}));
    const look = editor(d, 1, 2, () => false);
    await vp.finalReadyYoutubeLook(asDedup(d), 1, 2, look, playsFor({}));
    /** 5 − 2 spent − 1 running = 2 looks. */
    expect(look).toHaveBeenCalledWith(ms.slice(0, 2));
    expect(d.beatRelevance.spendByBeat.get("s1b2")).toBe(4);
  });

  it("G — the film's 120 looks are spent: no extra look (FILM_LOOK_CEILING)", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
    const d = renderState();
    handTo(d, 2, 1, [moment()]);
    d.beatImageGate.judgementAttempts = 120;
    const look = editor(d, 2, 1, () => true);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 2, 1, look, playsFor({}))).toBeNull();
    expect(look).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("reason=FILM_LOOK_CEILING"))).toBe(true);
  });
});

/* ═══════════════════════ H/J — no new search ═══════════════════════ */

describe("TEST H/J — finding a lost moment again never searches or downloads", () => {
  it("H — the recovery path calls no search, download or YouTube turn", () => {
    for (const sig of [
      "export async function finalReadyYoutubeLook(",
      "export function pendingYoutubeForBeat(",
      "export function noteYoutubeAssigned(",
      "export function noteReviewInFlight(",
    ]) {
      expect(bodyOf(sig)).not.toMatch(NO_SEARCH);
    }
  });

  it("J — after a placement failure only moments already on disk reach the editor", async () => {
    quiet();
    const d = renderState();
    const [a, b2] = [moment(), moment()];
    handTo(d, 1, 1, [a, b2]);
    const look = editor(d, 1, 1, () => true);
    await vp.finalReadyYoutubeLook(asDedup(d), 1, 1, look, playsFor({ [a]: 2.44 }));
    for (const call of look.mock.calls) for (const p of call[0]) expect([a, b2]).toContain(p);
  });

  it("the search limit is still 2 per video", async () => {
    const { MAX_YOUTUBE_SEARCHES_PER_VIDEO } = await import("./youtubeSearchBudget");
    expect(MAX_YOUTUBE_SEARCHES_PER_VIDEO).toBe(2);
  });
});

/* ═══════════════════════ I — FIX F: placement fails → next existing moment ═══════════════════════ */

describe("TEST I — FIX F: an approved moment under 3 s after preparing → the next moment already found", () => {
  it("639 s1b1: A approved, prepared to 2.44 s, refused by the 3 s rule → B is tried → B placed", async () => {
    quiet();
    const d = renderState();
    const placer = closedScene(d, 1);
    const [a, b2, c] = [moment(), moment(), moment("c6999ce951b2e30d")];
    handTo(d, 1, 1, [a, b2, c]);
    const look = editor(d, 1, 1, () => true);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 1, 1, look, playsFor({ [a]: 2.44 }))).toBe(b2);
    expect(look).toHaveBeenCalledTimes(2);
    expect(look.mock.calls[1]![0]).toEqual([b2, c]);
    expect(await vp.placeApprovedAfterSceneClosed(d, 1, FINAL)).toEqual([{ beatIndex: 1, clip: b2, hold: 8.14 }]);
    expect(placer).toHaveBeenCalledTimes(1);
  });

  it("the boundary is the archive's own: 2.99 s refused, 3.00 s and 3.01 s placed — no stretch, no loop", async () => {
    quiet();
    for (const [secs, placed] of [[2.99, false], [3.0, true], [3.01, true]] as const) {
      const d = renderState();
      const only = moment();
      handTo(d, 0, 0, [only]);
      const got = await vp.finalReadyYoutubeLook(asDedup(d), 0, 0, editor(d, 0, 0, () => true), playsFor({ [only]: secs }));
      expect(got === only).toBe(placed);
    }
    const { MIN_VIDEO_DURATION_SEC } = await import("./archiveIngestion");
    expect(MIN_VIDEO_DURATION_SEC).toBe(3);
    expect(bodyOf("export async function finalReadyYoutubeLook(")).toContain("belowArchiveMinimumDuration(seconds)");
    expect(bodyOf("export async function finalReadyYoutubeLook(")).not.toMatch(/setpts|stream_loop|tpad|loop=/);
  });
});

/* ═══════════════════════ K/L/M — fallbacks and FIX B unchanged ═══════════════════════ */

describe("TEST K/L/M — real footage before graphics; no moment → normal fallback; LATE still works", () => {
  it("K — a recovered FIT is placed in the last F2 pass, before any generated image or graphic stand-in", async () => {
    quiet();
    const d = renderState();
    closedScene(d, 2);
    const clip = moment();
    handTo(d, 2, 3, [clip]);
    await vp.finalReadyYoutubeLook(asDedup(d), 2, 3, editor(d, 2, 3, () => true), playsFor({}));
    const placed = await vp.placeApprovedAfterSceneClosed(d, 2, FINAL);
    expect(placed.map((p) => p.clip)).toEqual([clip]);
    /** The sentence now has its clip; a card or generated image is only for sentences without one. */
    expect(PIPE.indexOf("await finalLooksWithin(visualDedup, finalLooks);")).toBeLessThan(
      PIPE.indexOf("await generateMissingBeatImages(scenes, sceneVisualResults, visualDedup, workDir, topicContext);")
    );
  });

  it("L — no ready, late or pending moment: no look, no wait, the normal fallback follows", async () => {
    const d = renderState();
    const look = editor(d, 0, 0, () => true);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 0, 0, look, playsFor({}))).toBeNull();
    expect(look).not.toHaveBeenCalled();
    const t0 = Date.now();
    expect(await vp.awaitFinalReviewWindow(d, [{ sceneIndex: 0, beatIndex: 0 }], 5_000)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("M — a LATE moment no sentence took is still in the last look (FIX B unchanged)", async () => {
    quiet();
    const d = renderState();
    const late = moment();
    d.lateYoutubeCandidates = [late];
    const look = editor(d, 1, 0, () => false);
    await vp.finalReadyYoutubeLook(asDedup(d), 1, 0, look, playsFor({}));
    expect(look).toHaveBeenCalledWith([late]);
  });

  it("a FIT that arrives after the film was assembled is named, never placed silently", async () => {
    const warns: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation((m: string) => void warns.push(String(m)));
    const d = renderState();
    closedScene(d, 0);
    await vp.placeApprovedAfterSceneClosed(d, 0, FINAL);
    handTo(d, 0, 1, [moment()]);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 0, 1, editor(d, 0, 1, () => true), playsFor({}))).toBeNull();
    expect(warns.some((w) => w.includes(vp.REVIEW_TIMEOUT_BEFORE_FINALIZE))).toBe(true);
  });

  it("the last looks run side by side and are bounded; one still running is named", async () => {
    quiet();
    const d = renderState();
    const t0 = Date.now();
    await vp.finalLooksWithin(d, [
      { sceneIndex: 0, beatIndex: 0, run: Promise.resolve() },
      { sceneIndex: 0, beatIndex: 1, run: new Promise(() => {}) },
    ], 60);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(vp.reviewTimedOutBeforeFinalize(d, 0, 1)).toBe(true);
    expect(vp.reviewTimedOutBeforeFinalize(d, 0, 0)).toBe(false);
  });
});

/* ═══════════════════════ 639 end to end: s1b4 as it happened ═══════════════════════ */

describe("639 s1b4 replayed: taken, scene closed, review stuck past the window", () => {
  it("the stuck review is named, the moment is recovered within the ceilings, approved and placed", async () => {
    quiet();
    const d = renderState();
    const placer = closedScene(d, 1);
    const six = [moment(), moment(), moment("c6999ce951b2e30d"), moment(), moment("c6999ce951b2e30d"), moment()];
    handTo(d, 1, 4, six);
    vp.noteReviewInFlight(d, vp.youtubeTurnKey(1, 4), new Promise(() => {}));
    expect(await vp.awaitFinalReviewWindow(d, [{ sceneIndex: 1, beatIndex: 4 }], 50)).toEqual([{ sceneIndex: 1, beatIndex: 4 }]);
    const look = editor(d, 1, 4, (p) => p === six[0]);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 1, 4, look, playsFor({}))).toBe(six[0]);
    /** 5 looks − 1 held back for the review still running = 4 fresh moments offered. */
    expect(look.mock.calls[0]![0]).toEqual(six.slice(0, 4));
    expect(await vp.placeApprovedAfterSceneClosed(d, 1, FINAL)).toEqual([{ beatIndex: 4, clip: six[0], hold: 8.14 }]);
    expect(placer).toHaveBeenCalledTimes(1);
  });
});
