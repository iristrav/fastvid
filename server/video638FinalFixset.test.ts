import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { emptyTimeline, DEFAULT_TEXT_STYLE, type ProjectTimeline, type TimelineGraphic, type TimelineText } from "./projectTimeline";
import {
  directOnScreenText,
  formatTextDirection,
  GRAPHIC_BUDGET_EXCEEDED,
  GRAPHIC_MOMENTS_PER_MINUTE,
} from "./onScreenTextDirector";

/**
 * VIDEO 638 — the three findings of the source + graphics audit (ea0979a, NO-GO):
 *   FIX A  a hard budget of text/graphic MOMENTS per started minute (it only warned at 12);
 *   FIX B  one last look at YouTube already on disk before a sentence gets a graphic (R2/R3);
 *   FIX C  one last look at ready YouTube right before an archive FIT is accepted (R1).
 * Nothing searches, downloads or waits; the editor, the ceilings, the 3 s rule and W1–W6 are the ones
 * that already exist.
 */

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const DIRECTOR = fs.readFileSync(path.join(__dirname, "onScreenTextDirector.ts"), "utf8");

/* ═══════════════════════ timeline fixtures (the shape translateEdl writes) ═══════════════════════ */

const text = (id: string, role: string, t: string, start: number, end: number, position = "bottom"): TimelineText => ({
  id, role, text: t, start, end,
  style: { ...DEFAULT_TEXT_STYLE, position: position as TimelineText["style"]["position"] },
  animation: "fade",
});
const gfx = (id: string, graphicType: string, label: string, start: number, end: number, data: Record<string, unknown> = {}): TimelineGraphic => ({
  id, graphicType, label, start, end, data: { label, ...data },
});
function timeline(texts: TimelineText[], graphics: TimelineGraphic[], durationSec = 120): ProjectTimeline {
  const t = emptyTimeline(638);
  t.durationSec = durationSec;
  for (const track of t.tracks) {
    if (track.kind === "TEXT") track.texts.push(...texts);
    if (track.kind === "GRAPHICS") track.graphics.push(...graphics);
  }
  return t;
}
const graphicsOf = (t: ProjectTimeline) => (t.tracks.find((x) => x.kind === "GRAPHICS") as { graphics: TimelineGraphic[] }).graphics;
const shownIds = (t: ProjectTimeline) => graphicsOf(t).filter((g) => !g.disabled).map((g) => g.id);
const offReason = (t: ProjectTimeline, id: string) => graphicsOf(t).find((g) => g.id === id)?.disabledReason;

afterEach(() => vi.restoreAllMocks());
const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});

/* ═══════════════════════ TESTSET 1 — FIX A: graphic budget ═══════════════════════ */

describe("FIX A — at most 3 text/graphic moments per started minute, enforced", () => {
  it("the budget is 3, and it is a rule of the director, not a warning", () => {
    expect(GRAPHIC_MOMENTS_PER_MINUTE).toBe(3);
    expect(DIRECTOR).toContain("const budgetDropped = applyGraphicBudget(accepted, graphics, out);");
  });

  it("A — 3 moments in the first minute: all three shown", () => {
    quiet();
    const t = timeline([], [
      gfx("g_counter", "counter", "$1.2 billion", 5, 8, { toValue: 1.2 }),
      gfx("g_kim", "lower_third", "Kim Kardashian", 20, 24, { name: "Kim Kardashian" }),
      gfx("g_2007", "date_card", "2007", 40, 43, { text: "2007" }),
    ]);
    directOnScreenText(t);
    expect(shownIds(t)).toEqual(["g_counter", "g_kim", "g_2007"]);
  });

  it("B — a 4th moment of the same rank in the first minute is not placed (the latest goes)", () => {
    quiet();
    const t = timeline([], [
      gfx("g_kris", "lower_third", "Kris Jenner", 5, 8),
      gfx("g_kim", "lower_third", "Kim Kardashian", 15, 18),
      gfx("g_khloe", "lower_third", "Khloé Kardashian", 30, 33),
      gfx("g_kylie", "lower_third", "Kylie Jenner", 45, 48),
    ]);
    directOnScreenText(t);
    expect(shownIds(t)).toEqual(["g_kris", "g_kim", "g_khloe"]);
    expect(offReason(t, "g_kylie")).toBe(GRAPHIC_BUDGET_EXCEEDED);
  });

  it("B' — over budget, the lowest priority goes first: data > first name > year > place > quote", () => {
    quiet();
    const t = timeline([], [
      gfx("g_quote", "quote", "I never wanted fame", 2, 6),
      gfx("g_counter", "counter", "$1.2 billion", 15, 18, { toValue: 1.2 }),
      gfx("g_kim", "lower_third", "Kim Kardashian", 30, 33),
      gfx("g_2007", "date_card", "2007", 45, 48, { text: "2007" }),
    ]);
    directOnScreenText(t);
    expect(shownIds(t)).toEqual(["g_counter", "g_kim", "g_2007"]);
    expect(offReason(t, "g_quote")).toBe(GRAPHIC_BUDGET_EXCEEDED);
  });

  it("C — the budget starts again in the second minute", () => {
    quiet();
    const names = ["Kris Jenner", "Kim Kardashian", "Khloé Kardashian", "Kourtney Kardashian", "Kylie Jenner", "Kendall Jenner", "Rob Kardashian"];
    const at = [5, 20, 40, 65, 80, 100, 110];
    const t = timeline([], names.map((n, i) => gfx(`g${i}`, "lower_third", n, at[i]!, at[i]! + 3)));
    directOnScreenText(t);
    expect(shownIds(t)).toEqual(["g0", "g1", "g2", "g3", "g4", "g5"]);
    expect(offReason(t, "g6")).toBe(GRAPHIC_BUDGET_EXCEEDED);
  });

  it("D — a name and its year that appear together are ONE moment", () => {
    quiet();
    const t = timeline([], [
      gfx("g_kris", "lower_third", "Kris Jenner", 10, 14),
      gfx("g_2007", "date_card", "2007", 10.2, 14, { text: "2007" }),
      gfx("g_kim", "lower_third", "Kim Kardashian", 25, 28),
      gfx("g_counter", "counter", "$1.2 billion", 45, 48, { toValue: 1.2 }),
    ]);
    directOnScreenText(t);
    expect(shownIds(t)).toEqual(["g_kris", "g_2007", "g_kim", "g_counter"]);
  });

  it("E — real footage is never touched: the video track is identical before and after", () => {
    quiet();
    const t = timeline([], [
      gfx("g0", "lower_third", "Kris Jenner", 1, 4),
      gfx("g1", "lower_third", "Kim Kardashian", 10, 13),
      gfx("g2", "lower_third", "Khloé Kardashian", 20, 23),
      gfx("g3", "lower_third", "Kylie Jenner", 30, 33),
      gfx("g4", "counter", "$1.2 billion", 40, 43, { toValue: 1.2 }),
    ]);
    const video = t.tracks.find((x) => x.kind === "VIDEO") as { clips: unknown[] };
    video.clips.push(
      { id: "vc_1", timelineStart: 0, timelineEnd: 30, source: { provider: "youtube_cc" } },
      { id: "vc_2", timelineStart: 30, timelineEnd: 60, source: { provider: "elon musk" } }
    );
    const before = JSON.stringify(video.clips);
    directOnScreenText(t);
    expect(JSON.stringify(video.clips)).toBe(before);
    expect(graphicsOf(t).filter((g) => g.disabledReason === GRAPHIC_BUDGET_EXCEEDED)).toHaveLength(2);
  });

  it("F — what the budget switches off says why: the reason, a log line, and the summary count", () => {
    const log = quiet();
    const t = timeline([], [
      gfx("g0", "lower_third", "Kris Jenner", 1, 4),
      gfx("g1", "lower_third", "Kim Kardashian", 10, 13),
      gfx("g2", "lower_third", "Khloé Kardashian", 20, 23),
      gfx("g3", "lower_third", "Kylie Jenner", 30, 33),
    ]);
    const d = directOnScreenText(t);
    expect(d.disabled).toContainEqual({ id: "g3", reason: GRAPHIC_BUDGET_EXCEEDED, label: "Kylie Jenner" });
    expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith("[GRAPHIC_BUDGET_EXCEEDED] minute=1"))).toBe(true);
    expect(formatTextDirection(638, d)).toContain(`${GRAPHIC_BUDGET_EXCEEDED}=1`);
    expect(graphicsOf(t).find((g) => g.id === "g3")).toBeDefined(); // switched off, never deleted
  });

  it("G — a sentence's full-frame card (its only picture) always stays; overlays give way to it", () => {
    quiet();
    const t = timeline([], [
      gfx("card_0", "chapter_card", "Tesla", 0, 9, { title: "Tesla", primaryVisual: true }),
      gfx("card_1", "counter", "$800 billion", 12, 20, { toValue: 800, primaryVisual: true }),
      gfx("card_2", "chapter_card", "Reno", 25, 33, { title: "Reno", primaryVisual: true }),
      gfx("card_3", "chapter_card", "Model 3", 40, 47, { title: "Model 3", primaryVisual: true }),
      gfx("g_kim", "lower_third", "Elon Musk", 50, 53),
    ]);
    directOnScreenText(t);
    expect(shownIds(t)).toEqual(["card_0", "card_1", "card_2", "card_3"]);
    expect(offReason(t, "g_kim")).toBe(GRAPHIC_BUDGET_EXCEEDED);
  });

  it("the opening word is never removed by the budget (it uses it up first)", () => {
    quiet();
    const t = timeline(
      [text("txt_opening_word", "title", "ELON MUSK", 0.4, 2.6, "center")],
      [
        gfx("g0", "lower_third", "Kris Jenner", 10, 13),
        gfx("g1", "lower_third", "Kim Kardashian", 20, 23),
        gfx("g2", "lower_third", "Khloé Kardashian", 30, 33),
      ]
    );
    directOnScreenText(t);
    const opening = (t.tracks.find((x) => x.kind === "TEXT") as { texts: TimelineText[] }).texts[0]!;
    expect(opening.disabled).toBeFalsy();
    expect(shownIds(t)).toEqual(["g0", "g1"]);
    expect(offReason(t, "g2")).toBe(GRAPHIC_BUDGET_EXCEEDED);
  });

  it("MAX_GRAPHICS_PER_MINUTE stays a warning in the quality report; the budget is what enforces", async () => {
    const { MAX_GRAPHICS_PER_MINUTE } = await import("./directorQualityRules");
    expect(MAX_GRAPHICS_PER_MINUTE).toBe(12);
  });
});

/* ═══════════════════════ shared: the pipeline's own late machinery ═══════════════════════ */

type VP = typeof import("./videoPipeline");
let vp: VP;
let dir: string;
beforeAll(async () => {
  vp = await import("./videoPipeline");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-final-fixset-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const momentOnDisk = (name: string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "moment");
  return p;
};
/** The picture editor, as `adoptClip` reports it: a FIT registers the approval for the sentence. */
const editorThatApproves = (dedup: object, sceneIndex: number, beatIndex: number) =>
  vi.fn(async (paths: string[]) => {
    const clip = paths[0]!;
    vp.noteApprovedPickForBeat(dedup, sceneIndex, beatIndex, vp.clipContentKey(clip));
    return clip;
  });
const editorThatRefuses = () => vi.fn(async (_paths: string[]) => null as string | null);
const FINAL = { sceneReturned: true, final: true } as const;

/* ═══════════════════════ TESTSET 2 — FIX C: archive FIT vs ready YouTube (R1) ═══════════════════════ */

describe("FIX C — right before an archive FIT is accepted, YouTube that became ready gets its look", () => {
  const ARCHIVE = "/w/scene_0_b1_curated_a58080.mp4";
  /** The pipeline's own `readyYoutubeFirst`, with the picture editor injected. */
  const readyYoutube = (dedup: object, look: (p: string[]) => Promise<string | null>) => async () => {
    const ready = vp.takeReadyLookaheadCandidates(dedup, vp.youtubeTurnKey(0, 1));
    return ready.length ? look(ready) : null;
  };

  it("the race: not ready at check 2, ready just before accept, approved → YouTube is chosen, the archive is not", async () => {
    const dedup = {};
    const look = editorThatApproves(dedup, 0, 1);
    /** Check 2 (before the archive hit's own look): nothing ready yet. */
    expect(await readyYoutube(dedup, look)()).toBeNull();
    /** During the archive's look the lookahead finishes one moment for this sentence. */
    const moment = momentOnDisk("scene_0_ytfu_0m0_t5533d40__pid_youtube_cc-acc0dfc922f30224.mp4");
    vp.noteLookaheadCandidateReady(dedup, vp.youtubeTurnKey(0, 1), moment);
    const chosen = await vp.archiveFitUnlessReadyYoutube(ARCHIVE, readyYoutube(dedup, look));
    expect(chosen).toBe(moment);
    expect(look).toHaveBeenCalledWith([moment]);
  });

  it("ready but refused by the editor → the archive's FIT is accepted", async () => {
    const dedup = {};
    const moment = momentOnDisk("scene_0_ytfu_0m1_t5697d40__pid_youtube_cc-acc0dfc922f30224.mp4");
    vp.noteLookaheadCandidateReady(dedup, vp.youtubeTurnKey(0, 1), moment);
    const look = editorThatRefuses();
    expect(await vp.archiveFitUnlessReadyYoutube(ARCHIVE, readyYoutube(dedup, look))).toBe(ARCHIVE);
    expect(look).toHaveBeenCalledTimes(1);
  });

  it("YouTube still not ready → the archive's FIT is accepted, nothing is looked at, nothing waits", async () => {
    const dedup = {};
    const look = editorThatRefuses();
    const t0 = Date.now();
    expect(await vp.archiveFitUnlessReadyYoutube(ARCHIVE, readyYoutube(dedup, look))).toBe(ARCHIVE);
    expect(look).not.toHaveBeenCalled();
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("wired between the archive hit's look and its acceptance, through readyYoutubeFirst — no search anywhere on the way", () => {
    const at = PIPE.indexOf("export async function fetchBeatArchivalThenPexels(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    const look = body.indexOf("archiveHitRefused = await archiveHitRefusedByPictureEditor(");
    const accept = body.indexOf('const accepted = await archiveFitUnlessReadyYoutube(ownArchiveClip, () => readyYoutubeFirst("before_archive_accept"));');
    const fit = body.indexOf("noteArchiveFirstFit(");
    const hit = body.indexOf("ARCHIVE_HIT — no supplier asked");
    expect(look).toBeGreaterThan(0);
    expect(accept).toBeGreaterThan(look);
    expect(fit).toBeGreaterThan(accept);
    expect(hit).toBeGreaterThan(accept);
    expect(body).toContain("if (accepted !== ownArchiveClip) return accepted;");
    const helperAt = PIPE.indexOf("export async function archiveFitUnlessReadyYoutube(");
    const helper = PIPE.slice(helperAt, PIPE.indexOf("\n}\n", helperAt));
    expect(helper).not.toMatch(/fetchYouTubeCCClips|tryBeatRealYouTubeFootage|claimYoutubeTurn|searchYouTube|setTimeout|sleep/);
    const ready = body.slice(body.indexOf("const readyYoutubeFirst = async"), body.indexOf("};", body.indexOf("const readyYoutubeFirst = async")));
    expect(ready).not.toMatch(/fetchYouTubeCCClips|tryBeatRealYouTubeFootage|claimYoutubeTurn|searchYouTube/);
  });
});

/* ═══════════════════════ TESTSET 3 — FIX B: final ready-YouTube look (R2/R3) ═══════════════════════ */

describe("FIX B — before a sentence gets a graphic, YouTube already on disk for it is looked at", () => {
  it("ready after the sentence's turn, approved → placed by the final F2 pass, so no graphic is needed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup: { lateYoutubeCandidates?: string[] } = {};
    const placer = vi.fn(async (_clip: string, _beat: number) => ({ hold: 9.46 }));
    vp.openLatePlacement(dedup, 2, placer);
    vp.markSceneClosed(dedup, 2);
    /** 638 s2b0: moments ready at 08:16:22, its turn ended at 08:15:57. */
    const moment = momentOnDisk("scene_2_ytfu_0m0_t4618d40__pid_youtube_cc-b21a311666d51430.mp4");
    vp.noteLookaheadCandidateReady(dedup, vp.youtubeTurnKey(2, 0), moment);

    const look = editorThatApproves(dedup, 2, 0);
    expect(await vp.finalReadyYoutubeLook(dedup, 2, 0, look)).toBe(moment);
    expect(look).toHaveBeenCalledWith([moment]);
    const placed = await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL);
    expect(placed).toEqual([{ beatIndex: 0, clip: moment, hold: 9.46 }]);
    expect(placer).toHaveBeenCalledWith(moment, 0);
  });

  it("ready but refused → nothing placed: the normal graphic/still fallback follows", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dedup: { lateYoutubeCandidates?: string[] } = {};
    const placer = vi.fn(async () => ({ hold: 3 }));
    vp.openLatePlacement(dedup, 2, placer);
    vp.markSceneClosed(dedup, 2);
    vp.noteLookaheadCandidateReady(dedup, vp.youtubeTurnKey(2, 2), momentOnDisk("scene_2_ytfu_1m1_t5697d40__pid_youtube_cc-acc0dfc922f30224.mp4"));
    const look = editorThatRefuses();
    expect(await vp.finalReadyYoutubeLook(dedup, 2, 2, look)).toBeNull();
    expect(look).toHaveBeenCalledTimes(1);
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 2, FINAL)).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
  });

  it("nothing ready → no look at all, the normal fallback follows", async () => {
    const dedup: { lateYoutubeCandidates?: string[] } = {};
    const look = editorThatRefuses();
    expect(await vp.finalReadyYoutubeLook(dedup, 1, 3, look)).toBeNull();
    expect(look).not.toHaveBeenCalled();
  });

  it("R2: a moment offered LATE that no sentence took is in the last look too; a file gone from disk is not", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const late = momentOnDisk("scene_0_ytfu_0m2_t6100d40__pid_youtube_cc-2e842625dab99c98.mp4");
    const dedup: { lateYoutubeCandidates?: string[] } = { lateYoutubeCandidates: [late, path.join(dir, "gone__pid_youtube_cc-0000000000000000.mp4")] };
    const look = editorThatRefuses();
    await vp.finalReadyYoutubeLook(dedup, 1, 0, look);
    expect(look).toHaveBeenCalledWith([late]);
  });

  it("no search, no download, no wait: only files on disk reach the editor", () => {
    const at = PIPE.indexOf("export async function finalReadyYoutubeLook(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).toContain("takeReadyLookaheadCandidates(dedup, youtubeTurnKey(sceneIndex, beatIndex))");
    expect(body).toContain("(dedup.lateYoutubeCandidates ?? []).filter((p) => fs.existsSync(p))");
    expect(body).not.toMatch(/fetchYouTubeCCClips|tryBeatRealYouTubeFootage|claimYoutubeTurn|searchYouTube|downloadYoutube|setTimeout|sleep|await .*lookahead\.take/);
  });

  it("wired: after sourcing, before the final F2 pass and before generated images; only sentences without a picture", () => {
    const loop = PIPE.indexOf("await finalReadyYoutubeLook(visualDedup, sceneIndex, beat.index, (ready) =>");
    const finalPass = PIPE.indexOf("for (let si = 0; si < scenes.length; si++) await placeLate(si, true);");
    const generated = PIPE.indexOf("await generateMissingBeatImages(scenes, sceneVisualResults, visualDedup, workDir, topicContext);");
    expect(loop).toBeGreaterThan(0);
    expect(loop).toBeLessThan(finalPass);
    expect(finalPass).toBeLessThan(generated);
    const block = PIPE.slice(loop - 700, loop);
    expect(block).toContain("if ((vr?.clipBeatIndices ?? []).includes(beat.index)) continue;");
    expect(block).toContain("if (lateApprovalPendingFor(visualDedup, sceneIndex, beat.index)) continue;");
    /** The one adoption: adoptClip with its gates, the 3 s rule and the per-sentence ceiling. */
    expect(PIPE.slice(loop, loop + 300)).toContain("adoptHistoricalBeatVideoPool(ready, beat, workDir, sceneIndex, visualDedup,");
  });

  it("the look ceiling is exactly what it was (5 per sentence) and nothing here raises it", () => {
    const BVR = fs.readFileSync(path.join(__dirname, "beatVisualRelevance.ts"), "utf8");
    expect(BVR).toContain("return Number.isFinite(n) && n >= 1 && n <= 20 ? n : MAX_JUDGEMENTS_PER_BEAT + 1;");
    expect(BVR).toContain("if (!alreadyKnown && spentOnBeat >= maxRelevanceLooksPerBeat() && !params.finalSay) {");
    const at = PIPE.indexOf("export async function finalReadyYoutubeLook(");
    expect(PIPE.slice(at, PIPE.indexOf("\n}\n", at))).not.toMatch(/finalSay|MAX_BEAT_RELEVANCE_LOOKS|maxRelevanceLooks/);
  });
});

/* ═══════════════════════ TESTSET 4 — no regression on the source flow ═══════════════════════ */

describe("unchanged: source order, search limit, 3 s rule, gates", () => {
  it("YouTube first in one pool (G4); stock still last; the archive still asked", () => {
    expect(PIPE).toContain("const lessFilled = preferLessFilledFootage(youtubeCandidatesFirst(tasteResult.rankedPaths), (p) => clipContentKey(p), dedup);");
    const at = PIPE.indexOf("export async function fetchBeatArchivalThenPexels(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body.indexOf("ownArchiveBeatClip(beat, scene, workDir, sceneIndex, dedup, videoTitle)")).toBeGreaterThan(0);
    expect(body.indexOf("const stock = await fetchBeatStockFallback(")).toBeGreaterThan(body.indexOf("adoptHistoricalBeatVideoPool(candidates,"));
  });

  it("2 YouTube searches per video; the 3 s minimum and its early filter (G2) unchanged", async () => {
    const { MAX_YOUTUBE_SEARCHES_PER_VIDEO } = await import("./youtubeSearchBudget");
    expect(MAX_YOUTUBE_SEARCHES_PER_VIDEO).toBe(2);
    const { MIN_VIDEO_DURATION_SEC, belowArchiveMinimumDuration } = await import("./archiveIngestion");
    expect(MIN_VIDEO_DURATION_SEC).toBe(3);
    expect([2.99, 3.0, 3.01].map(belowArchiveMinimumDuration)).toEqual([true, false, false]);
    expect(PIPE).toContain("if (isYoutubeMomentPath(p) && belowArchiveMinimumDuration(await probeVideoDurationSec(p))) {");
  });

  it("the stock filter reads only the clip's own text (G1)", () => {
    const VJ = fs.readFileSync(path.join(__dirname, "visualJudge.ts"), "utf8");
    expect(VJ).toContain('if (isRejectedStockClip(p, clipQuery)) return reject("metadata", "rejected_stock");');
  });
});
