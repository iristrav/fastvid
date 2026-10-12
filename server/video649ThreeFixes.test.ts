/**
 * VIDEO 649 — THREE FIXES AFTER THE FIRST FILM THAT RAN TO THE GATE WITH F1–F4 IN PLACE.
 *
 * 649 (Tesla, 70 s, 12 sentences) was refused on 2 chapter cards and 3 partly covered sentences:
 *  V1 the per-sentence "video search" scope was the render budget's 53 s slice, not the 180 s turn;
 *  V2 moments handed to a sentence and never judged were left unjudged at its last look (BEAT_LOOK_CEILING);
 *  V3 a late-approved shot shorter than its sentence was never topped up.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const BVR = fs.readFileSync(path.join(__dirname, "beatVisualRelevance.ts"), "utf8");
const bodyOf = (src: string, signature: string): string => {
  const at = src.indexOf(signature);
  expect(at, signature).toBeGreaterThan(0);
  return src.slice(at, src.indexOf("\n}\n", at));
};

type VP = typeof import("./videoPipeline");
type BVRM = typeof import("./beatVisualRelevance");
type SP = typeof import("./sourcingPolicy");
let vp: VP;
let bvr: BVRM;
let sp: SP;
let dir: string;
beforeAll(async () => {
  vp = await import("./videoPipeline");
  bvr = await import("./beatVisualRelevance");
  sp = await import("./sourcingPolicy");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-649-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

/* ───────────────────────── V1 — the sentence's whole turn ───────────────────────── */

describe("V1 — the video search scope is the sentence's turn, not the render budget's search slice", () => {
  it("wiring: the ladder's scope is at least JUDGED_BEAT_TURN_MS (the parent clamp keeps it inside the beat's resolve share)", () => {
    const body = bodyOf(PIPE, "async function resolveBeatClipForBeat(");
    expect(body).toContain("Math.max(beatWallWithYoutubeTurn(beatVideoSearchWallMs()), JUDGED_BEAT_TURN_MS),\n        `video search s${sceneIndex} b${beat.index}`");
    expect(body).not.toContain("        beatWallWithYoutubeTurn(beatVideoSearchWallMs()),\n        `video search s${sceneIndex} b${beat.index}`");
  });

  it("649's arithmetic: inside a 53 s slice YouTube got 26 s; inside the turn's resolve share it gets a real turn and the fallback rungs keep ≥ 45 s", () => {
    const sliceMs = 53_000;
    const oldSlice = vp.youtubeTurnLeavingRoomForArchive(sp.YOUTUBE_FIRST_TURN_MS, sliceMs);
    /** less than a third of the turn it asked for (649's logs: "26s of the 120s it asked for", after the ready looks had taken their share) */
    expect(oldSlice).toBeLessThan(sp.YOUTUBE_FIRST_TURN_MS / 3);
    const resolveShareMs = Math.round(vp.JUDGED_BEAT_TURN_MS * vp.BEAT_RESOLVE_SHARE);
    expect(resolveShareMs).toBeGreaterThanOrEqual(120_000);
    const youtubeMs = vp.youtubeTurnLeavingRoomForArchive(sp.YOUTUBE_FIRST_TURN_MS, resolveShareMs);
    expect(youtubeMs).toBeGreaterThanOrEqual(60_000);
    expect(resolveShareMs - youtubeMs).toBeGreaterThanOrEqual(45_000);
  });
});

/* ───────────────────────── V2 — the last look at handed, never-judged moments ───────────────────────── */

const momentOnDisk = (name: string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "moment");
  return p;
};
let n = 0;
const moment = (video = "d72b145386fde4d1") => momentOnDisk(`scene_1_ytfu_0m${n}_t${3600 + n++}d39__pid_youtube_cc-${video}.mp4`);
const renderState = () => ({
  lateYoutubeCandidates: [] as string[],
  beatRelevance: bvr.createBeatRelevanceLedger(),
  beatImageGate: { judgementAttempts: 0 } as { judgementAttempts: number },
  visionReviewPool: { beats: new Map() },
  usedContentKeys: new Set<string>(),
});
type RenderState = ReturnType<typeof renderState>;
const asDedup = (d: RenderState) => d as unknown as Parameters<VP["finalReadyYoutubeLook"]>[0];
const editor = (d: RenderState, s: number, b: number, fits: (p: string) => boolean) =>
  vi.fn(async (paths: string[]) => {
    for (const p of paths) {
      const known = d.beatRelevance.byBeat.get(bvr.beatRelevanceBeatKey(s, b, "path", p));
      if (!known) {
        d.beatRelevance.spendByBeat.set(`s${s}b${b}`, (d.beatRelevance.spendByBeat.get(`s${s}b${b}`) ?? 0) + 1);
        d.beatImageGate.judgementAttempts++;
        d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(s, b, "path", p), {
          decision: { verdict: fits(p) ? "fits" : "does_not_fit", evaluated: true, allowed: fits(p) },
        } as never);
      }
      if (fits(p)) {
        vp.noteApprovedPickForBeat(d, s, b, vp.clipContentKey(p));
        return p;
      }
    }
    return null;
  });
const playsFor = (seconds: Record<string, number>) => vi.fn(async (clip: string) => seconds[clip] ?? 6);
function handTo(d: object, s: number, b: number, paths: string[]) {
  for (const p of paths) vp.noteLookaheadCandidateReady(d, vp.youtubeTurnKey(s, b), p);
  return vp.takeReadyLookaheadCandidates(d, vp.youtubeTurnKey(s, b));
}
const capture = () => {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
  vi.spyOn(console, "warn").mockImplementation((m: string) => void logs.push(String(m)));
  return logs;
};

describe("V2 — a sentence's last look may pass its ceiling for moments handed to it and never judged", () => {
  it("the ledger: the allowance is granted once, capped at one more ceiling, and counts in looksLeftOnBeat", () => {
    const ledger = bvr.createBeatRelevanceLedger();
    const max = bvr.maxRelevanceLooksPerBeat();
    ledger.spendByBeat.set("s1b0", max);
    expect(bvr.looksLeftOnBeat(ledger, 1, 0)).toBe(0);
    expect(bvr.grantLastLookAllowance(ledger, 1, 0, 8)).toBe(max);
    expect(bvr.lastLookAllowanceOnBeat(ledger, "s1b0")).toBe(max);
    expect(bvr.looksLeftOnBeat(ledger, 1, 0)).toBe(max);
    /** Already at the cap: nothing more. */
    expect(bvr.grantLastLookAllowance(ledger, 1, 0, 3)).toBe(0);
    expect(bvr.grantLastLookAllowance(ledger, 1, 0, 0)).toBe(0);
    /** A ledger literal without the map still reads as "no allowance" and can be granted one. */
    const bare = { spendByBeat: new Map([["s0b0", 2]]) };
    expect(bvr.looksLeftOnBeat(bare, 0, 0)).toBe(max - 2);
    expect(bvr.grantLastLookAllowance(bare, 0, 0, 2)).toBe(2);
    expect(bvr.looksLeftOnBeat(bare, 0, 0)).toBe(max);
  });

  it("the judge honours the allowance, and the ordinary ceiling still produces the BEAT_LOOK_CEILING skip", () => {
    expect(BVR).toContain("const beatCeiling = maxRelevanceLooksPerBeat() + lastLookAllowanceOnBeat(ledger, slot);");
    /** the pinned ceiling line is untouched; the allowance is read inside it */
    expect(BVR).toContain("if (!alreadyKnown && spentOnBeat >= maxRelevanceLooksPerBeat() && !params.finalSay) {");
    expect(BVR).toContain("    if (spentOnBeat >= beatCeiling) {");
    expect(BVR).toContain('noteJudgementSkipped(state, "BEAT_LOOK_CEILING")');
    expect(BVR).toContain("if (!alreadyKnown && spentOnBeat >= beatCeiling) {");
  });

  it("the ordinary (first) pass is unchanged: five looks spent, a handed moment never judged — no look, BEAT_LOOK_CEILING", async () => {
    const logs = capture();
    const d = renderState();
    handTo(d, 1, 0, [moment()]);
    d.beatRelevance.spendByBeat.set("s1b0", bvr.maxRelevanceLooksPerBeat());
    const look = editor(d, 1, 0, () => true);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 1, 0, look, playsFor({}))).toBeNull();
    expect(look).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("s1b0 not looked at — reason=BEAT_LOOK_CEILING"))).toBe(true);
    expect(vp.handedUnjudgedForBeat(d, 1, 0)).toBe(1);
  });

  it("649's s1b0 on the second pass: five looks spent, eight handed moments never judged — judged, within the render's ceiling", async () => {
    const logs = capture();
    const d = renderState();
    const handed = Array.from({ length: 8 }, () => moment());
    handTo(d, 1, 0, handed);
    d.beatRelevance.spendByBeat.set("s1b0", bvr.maxRelevanceLooksPerBeat());
    expect(vp.handedUnjudgedForBeat(d, 1, 0)).toBe(8);
    /** the allowance is one more ceiling (5): the fit must be among the five looked at; a sixth is not */
    const fit = handed[3]!;
    const look = editor(d, 1, 0, (p) => p === fit);
    const clip = await vp.finalReadyYoutubeLook(asDedup(d), 1, 0, look, playsFor({}), undefined, { lastLookAllowance: true });
    expect(clip).toBe(fit);
    expect(look).toHaveBeenCalled();
    /** Only what was never judged is offered on this pass. */
    for (const call of look.mock.calls) expect((call[0] as string[]).every((p) => handed.includes(p))).toBe(true);
    expect(logs.some((l) => l.includes("[FinalReadyYouTube] s1b0 last-look allowance +5 — 8 moment(s) handed to this sentence were never judged"))).toBe(true);
    expect(logs.some((l) => l.includes("reason=BEAT_LOOK_CEILING"))).toBe(false);
    /** The sentence's ordinary ceiling was not raised: the looks past it are exactly the allowance. */
    expect(bvr.lastLookAllowanceOnBeat(d.beatRelevance, "s1b0")).toBe(bvr.maxRelevanceLooksPerBeat());
    expect(d.beatRelevance.spendByBeat.get("s1b0")! - bvr.maxRelevanceLooksPerBeat()).toBeLessThanOrEqual(bvr.maxRelevanceLooksPerBeat());
  });

  it("no allowance for leftovers of other sentences: five looks spent and only `late` candidates — no look on the second pass either", async () => {
    const logs = capture();
    const d = renderState();
    d.lateYoutubeCandidates = [moment(), moment()];
    d.beatRelevance.spendByBeat.set("s2b2", bvr.maxRelevanceLooksPerBeat());
    const look = editor(d, 2, 2, () => true);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 2, 2, look, playsFor({}), undefined, { lastLookAllowance: true })).toBeNull();
    expect(look).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("s2b2 not looked at — reason=BEAT_LOOK_CEILING"))).toBe(true);
    expect(bvr.lastLookAllowanceOnBeat(d.beatRelevance, "s2b2")).toBe(0);
  });

  it("no allowance while the sentence still has looks of its own: two handed moments, three looks left — judged on the ordinary ceiling", async () => {
    const logs = capture();
    const d = renderState();
    handTo(d, 0, 1, [moment(), moment()]);
    d.beatRelevance.spendByBeat.set("s0b1", bvr.maxRelevanceLooksPerBeat() - 3);
    const look = editor(d, 0, 1, () => false);
    await vp.finalReadyYoutubeLook(asDedup(d), 0, 1, look, playsFor({}), undefined, { lastLookAllowance: true });
    expect(look).toHaveBeenCalled();
    expect(bvr.lastLookAllowanceOnBeat(d.beatRelevance, "s0b1")).toBe(0);
    expect(logs.some((l) => l.includes("last-look allowance"))).toBe(false);
  });

  it("the render's ceiling is untouched: at 120 judgements no handed moment is looked at, allowance or not", async () => {
    const logs = capture();
    const d = renderState();
    handTo(d, 1, 1, [moment(), moment()]);
    d.beatRelevance.spendByBeat.set("s1b1", bvr.maxRelevanceLooksPerBeat());
    d.beatImageGate.judgementAttempts = 120;
    const look = editor(d, 1, 1, () => true);
    expect(await vp.finalReadyYoutubeLook(asDedup(d), 1, 1, look, playsFor({}), undefined, { lastLookAllowance: true })).toBeNull();
    expect(look).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("s1b1 not looked at — reason=FILM_LOOK_CEILING"))).toBe(true);
  });

  it("the stage: the first pass shares the render's looks as before; the second pass judges what the ceiling left unjudged — 649's s1b0 gets its picture", async () => {
    const logs = capture();
    const d = { ...renderState(), sceneBeatsBySceneIndex: new Map() };
    const beats = [{ index: 0, text: "Tesla did not start in a factory", holdSec: 5.5 }, { index: 1, text: "In 2005, at the Detroit Auto Show", holdSec: 8.9 }];
    d.sceneBeatsBySceneIndex.set(1, beats);
    /** s1b0: three handed moments; s1b1: eight handed moments and its five looks already spent (649). */
    const forB0 = [moment(), moment(), moment()];
    const forB1 = Array.from({ length: 8 }, () => moment());
    handTo(d, 1, 0, forB0);
    handTo(d, 1, 1, forB1);
    d.beatRelevance.spendByBeat.set("s1b1", bvr.maxRelevanceLooksPerBeat());
    const fit = forB1[2]!;
    const offered: Array<[number, number]> = [];
    const look = vi.fn(async (beat: { index: number }, sceneIndex: number, paths: string[]) => {
      offered.push([beat.index, paths.length]);
      return editor(d, sceneIndex, beat.index, (p) => p === fit)(paths);
    });
    await vp.runFinalReadyYoutubeStage(
      d as never, [{ index: 1 }], [{ beats, clipBeatIndices: [] } as never], look as never, { windowMs: 20, looksMs: 2_000 }
    );
    /** First pass: b0 looked at its three (ordinary ceiling), b1 not looked at (ceiling spent). */
    expect(logs.some((l) => l.includes("s1b1 not looked at — reason=BEAT_LOOK_CEILING (8 moment(s) left unjudged"))).toBe(true);
    /** Second pass: named, b1 alone, allowance granted, the FIT found. */
    expect(logs.some((l) => l.startsWith("[FinalReadyYouTube] second pass — 1 sentence(s) still without a picture hold moments handed to them and never judged (s1b1)"))).toBe(true);
    expect(logs.some((l) => l.includes("[FinalReadyYouTube] s1b1 last-look allowance +5 — 8 moment(s) handed to this sentence were never judged"))).toBe(true);
    expect(logs.some((l) => l.includes(`[FinalReadyYouTube] s1b1 review completed — approved ${path.basename(fit)}`))).toBe(true);
    expect(offered.filter(([b]) => b === 1).length).toBeGreaterThan(0);
    expect(bvr.lastLookAllowanceOnBeat(d.beatRelevance, "s1b1")).toBe(bvr.maxRelevanceLooksPerBeat());
    expect(bvr.lastLookAllowanceOnBeat(d.beatRelevance, "s1b0")).toBe(0);
    /** The render's ceiling still counts every look. */
    expect(d.beatImageGate.judgementAttempts).toBe([...d.beatRelevance.spendByBeat.values()].reduce((a, b) => a + b, 0) - bvr.maxRelevanceLooksPerBeat());
  });

  it("no second pass without looks left for the render: at 120 the sentences are named, not looked at", async () => {
    const logs = capture();
    const d = { ...renderState(), sceneBeatsBySceneIndex: new Map() };
    const beats = [{ index: 0, text: "a sentence", holdSec: 5 }];
    d.sceneBeatsBySceneIndex.set(0, beats);
    handTo(d, 0, 0, [moment(), moment()]);
    d.beatImageGate.judgementAttempts = 120;
    const look = vi.fn(async () => null);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], [{ beats, clipBeatIndices: [] } as never], look as never, { windowMs: 20, looksMs: 500 });
    expect(look).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("second pass"))).toBe(false);
    expect(logs.some((l) => l.includes("s0b0 not looked at — reason=FILM_LOOK_CEILING"))).toBe(true);
  });
});

/* ───────────────────────── V3 — a short late picture is topped up ───────────────────────── */

describe("V3 — a late-approved picture shorter than its sentence is topped up right after it is placed", () => {
  it("wiring: inside placeLateApprovedPicks, after a successful push, the fill runs for the seconds the shot leaves open", () => {
    const place = PIPE.slice(PIPE.indexOf("const placeLateApprovedPicks = async"), PIPE.indexOf("  try {\n  for (let bi = 0; bi < beats.length; bi++) {"));
    expect(place).toContain("if (ok) {");
    expect(place).toContain("if (beatFillSecondsNeeded(beat.holdSec, covered) > 0) {");
    expect(place).toContain("[BeatFill] s${scene.index}b${late.beatIndex}: the late picture covers ${covered.toFixed(1)}s of ${beat.holdSec.toFixed(1)}s — topping up");
    expect(place).toContain("fillFor = { beat, clipsBefore: beatDurations.length, deadlineMs: Date.now() + Math.min(BEAT_FILL_TOP_UP_MS, remainingScopeMs()) };");
    expect(place).toContain("await fillBeatWithMoreClips();\n          } finally {\n            fillFor = keep;");
    /** The loop itself is unchanged: late picks, then the previous sentence's fill, then the ladder closes. */
    expect(PIPE).toContain("await placeLateApprovedPicks(false);\n    await fillBeatWithMoreClips();\n    closeBeatLadder?.();");
    expect(PIPE).toContain("await placeLateApprovedPicks(true);\n    await fillBeatWithMoreClips();");
  });

  it("the window: three extra fetches plus the fallback floor; 649's s1b3 (2.5 s under 6.65 s) needs 4.15 s, a covered sentence needs nothing", () => {
    expect(vp.BEAT_FILL_TOP_UP_MS).toBe(vp.BEAT_FILL_MAX_EXTRA_CLIPS * vp.BEAT_FILL_FETCH_MS + 5_000);
    expect(vp.BEAT_FILL_TOP_UP_MS).toBeGreaterThan(vp.BEAT_FILL_MIN_SCOPE_MS);
    expect(vp.beatFillSecondsNeeded(6.65, 2.5)).toBeCloseTo(4.15, 2);
    expect(vp.beatFillSecondsNeeded(5.84, 2.06)).toBeCloseTo(3.78, 2);
    expect(vp.beatFillSecondsNeeded(5.79, 5.79)).toBe(0);
  });

  it("F4 still holds: the fill steps aside for an approved picture on its way, and the top-up is what covers the rest once it lands", () => {
    const fill = PIPE.slice(PIPE.indexOf("const fillBeatWithMoreClips = async"), PIPE.indexOf("const placeLateApprovedPicks = async"));
    expect(fill).toContain("if (!found && approvedPicksForBeat(dedup, scene.index, f.beat.index) > 0) {");
    expect(fill).toContain("const covered = clipBeatIndices.reduce((sum, b, i) => (b === f.beat.index ? sum + (beatDurations[i] ?? 0) : sum), 0);");
  });
});

/* ───────────────────────── V4 — approved pictures are placed before the final fill stage asks ───────────────────────── */

describe("V4 — settled late approvals are placed before the final fill stage, so a short late picture is topped up", () => {
  it("wiring: every scene's non-final late placement runs right before runFinalBeatFillStage, and the final pass still follows", () => {
    const fill = PIPE.indexOf("await runFinalBeatFillStage(visualDedup, allSentences, judgeBudget, {");
    const place = PIPE.lastIndexOf("for (let si = 0; si < scenes.length; si++) await placeLate(si, false);", fill);
    const finalPass = PIPE.indexOf("for (let si = 0; si < scenes.length; si++) await placeLate(si, true);", fill);
    expect(fill).toBeGreaterThan(0);
    expect(place).toBeGreaterThan(0);
    expect(fill - place).toBeLessThan(600);
    expect(finalPass).toBeGreaterThan(fill);
    /** the fill stage itself still asks only sentences WITH a real picture and ≥ 3 s open */
    expect(PIPE).toContain(
      "(s) => io.hasRealPicture(s.sceneIndex, s.beatIndex) && io.secondsLeft(s.sceneIndex, s.beatIndex) >= BEAT_EXTRA_SHOT_MIN_SEC"
    );
  });
});
