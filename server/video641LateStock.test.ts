import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { belowArchiveMinimumDuration } from "./archiveIngestion";
import {
  lateReadyStockVideos,
  releaseYoutubeShotStock,
  startYoutubeShotStock,
  stockVideoState,
  takeStockShots,
  youtubeStockSettled,
} from "./youtubeShotStock";
import { noteYoutubeFragmentRefusal } from "./providerFailureClass";
import { formatMultiPersonOutcome, type PoolCandidate, type VideoYoutubePool } from "./youtubeVideoPool";

/**
 * VIDEO 641 — THE STOCK THAT CAME TOO LATE.
 *
 * I6dUAtWoTII was a replacement in the film's stock: downloaded, cut into two shots, ready at
 * 06:24:52 — 50 s after the pictures started, when every sentence had already taken its YouTube
 * turn. The last look before the graphics (06:28:42) only knew moment files on disk, so the two
 * shots were never offered to any sentence: no FIT, no adoption, no film, and `downloaded=0`.
 *
 * The fix: that last look also gets the stock that became ready after the pictures started and was
 * never handed to any sentence — each video to ONE sentence still without a picture, through the
 * same look, the same ceilings, the same 3 s rule and the same placement as any other moment.
 */

type VP = typeof import("./videoPipeline");
type BVRM = typeof import("./beatVisualRelevance");
let vp: VP;
let bvr: BVRM;
let dir: string;
beforeAll(async () => {
  vp = await import("./videoPipeline");
  bvr = await import("./beatVisualRelevance");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-641-late-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const video = (file: string, seconds: number): string => {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=gray:s=64x36:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  return file;
};
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Stocks `ids` for `filmId`; each video is cut into shots of `shotSec` seconds. */
async function stock(filmId: number, ids: string[], shotSec = 6, shots = 2): Promise<void> {
  startYoutubeShotStock(
    filmId,
    ids.map((videoId) => ({ videoId, title: `title ${videoId}`, durationSec: 60, serves: 1 })),
    {
      workDir: dir,
      download: async (_id, _s, _d, out) => fs.existsSync(video(out, shotSec * shots)),
      cut: async (file) =>
        Array.from({ length: shots }, (_, i) => ({ path: video(`${file}.shot${i}.mp4`, shotSec), startSec: i * shotSec, endSec: (i + 1) * shotSec })),
      startFor: () => 0,
      log: () => {},
    }
  );
  await youtubeStockSettled(filmId);
}

/** The pictures started between the early videos and the late ones. */
async function filmWithLateStock(filmId: number, early: string[], late: string[], lateShotSec = 6): Promise<number> {
  if (early.length) await stock(filmId, early);
  await tick();
  const picturesStarted = Date.now();
  await tick();
  if (late.length) await stock(filmId, late, lateShotSec);
  return picturesStarted;
}

const sentence = (index: number, text: string) => ({ index, text, holdSec: 3.5, keywords: [] as string[], searchQuery: "", powerWord: "" });
function dedupFor(sentences: Array<{ sceneIndex: number; beats: ReturnType<typeof sentence>[] }>) {
  return {
    lateYoutubeCandidates: [] as string[],
    beatRelevance: bvr.createBeatRelevanceLedger(),
    beatImageGate: { judgementAttempts: 0 },
    visionReviewPool: { beats: new Map() },
    usedContentKeys: new Set<string>(),
    sourcingCache: vp.createSourcingCache(641),
    sceneBeatsBySceneIndex: new Map(sentences.map((s) => [s.sceneIndex, s.beats])),
  };
}
type D = ReturnType<typeof dedupFor>;

/** The YouTube video a moment file was cut from, by its lineage (the file name carries a hash). */
const videoOf = (d: D, p: string) => d.sourcingCache.lineage.resolve(p)?.providerAssetId ?? null;

/** The picture editor of the test: approves a moment of `fits` (or nothing), records its verdict like the real one. */
function editor(d: D, sceneIndex: number, fits: string | null) {
  return vi.fn(async (beat: { index: number }, _scene: number, paths: string[]) => {
    for (const p of paths) {
      d.beatImageGate.judgementAttempts++;
      const ok = fits != null && videoOf(d, p) === fits;
      d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(sceneIndex, beat.index, "path", p), { decision: { verdict: ok ? "fits" : "does_not_fit", evaluated: true } } as never);
      if (ok) {
        vp.noteApprovedPickForBeat(d, sceneIndex, beat.index, vp.clipContentKey(p));
        return p;
      }
    }
    return null;
  });
}

function lateStockFor(filmId: number, d: D, since: number, serves: (id: string, beatIndex: number) => boolean = () => false) {
  const videoIds = lateReadyStockVideos(filmId, since);
  return {
    videoIds,
    serves: (id: string, _s: number, beat: { index: number }) => serves(id, beat.index),
    moments: (beat: { index: number; text: string }, sceneIndex: number, ids: string[]) =>
      vp.takeLateStockMoments(filmId, d, sceneIndex, beat, ids, dir),
  };
}
const results = (clipBeats: number[]) => [{ clips: [] as string[], beatDurations: [] as number[], clipBeatIndices: clipBeats }];

describe("LATE STOCK — which stock is late", () => {
  it("TEST 1 (P2) — ready before the pictures started: not late, but offered at the last look when valid and never offered; never when offered already or unusable", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const since = await filmWithLateStock(64101, ["early_A", "early_B", "early_C"], []);
    /** "late" keeps its meaning: none of the three became ready after the pictures started */
    expect(lateReadyStockVideos(64101, since)).toEqual([]);
    /** early_B: both shots handed to a sentence in its own turn — offered already */
    expect((await takeStockShots(64101, "early_B", 0, () => false, 2)).shots.length).toBe(2);
    /** early_C: both moments refused for what their pixels show (on-screen text) — unusable for every sentence */
    for (const start of [0, 6]) noteYoutubeFragmentRefusal(vp.youtubeFragmentKeyFor("early_C", start, 4), "baked_edit_text_before_vision");
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "A sentence without a picture.")] }]);
    const offer = vp.lateStockToOffer(64101, d as never, since);
    expect(offer.videoIds).toEqual(["early_A"]);
    expect(offer.line).toBe("[LateStock] offer=1 (readyBeforePictures=1 readyAfter=0 withShotsOfferedBefore=0) skipped={no_usable_shot:refused_fragment=1}");
    const look = editor(d, 0, null);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results([]), look, { windowMs: 50, looksMs: 5_000 }, {
      ...lateStockFor(64101, d, since),
      videoIds: offer.videoIds,
    });
    expect(look).toHaveBeenCalledTimes(1);
    const offered = look.mock.calls[0]![2] as string[];
    expect(offered.length).toBe(2);
    expect(offered.every((p) => videoOf(d, p) === "early_A")).toBe(true);
    expect(stockVideoState(64101, "early_A")).toEqual({ status: "ready", offered: true });
    expect(stockVideoState(64101, "early_C")).toEqual({ status: "ready", offered: false });
    /** once taken, never offered again */
    expect(vp.lateStockToOffer(64101, d as never, since).videoIds).toEqual([]);
    releaseYoutubeShotStock(64101);
  });

  it("TEST 2 — ready after the pictures started: late, and offered to a sentence still without a picture", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const since = await filmWithLateStock(64102, ["early_A"], ["I6dUAtWoTII"]);
    expect(lateReadyStockVideos(64102, since)).toEqual(["I6dUAtWoTII"]);
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "Kim Kardashian at home.")] }]);
    const look = editor(d, 0, null);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results([]), look, { windowMs: 50, looksMs: 5_000 }, lateStockFor(64102, d, since));
    expect(look).toHaveBeenCalledTimes(1);
    const offered = look.mock.calls[0]![2] as string[];
    expect(offered.length).toBe(2);
    expect(offered.every((p) => videoOf(d, p) === "I6dUAtWoTII" && path.basename(p).includes("_ytfu_late0m"))).toBe(true);
    expect(stockVideoState(64102, "I6dUAtWoTII")).toEqual({ status: "ready", offered: true });
    releaseYoutubeShotStock(64102);
  });
});

describe("LATE STOCK — the same gates as any moment", () => {
  it("TEST 3 — the picture editor says it does not fit: nothing is placed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const since = await filmWithLateStock(64103, [], ["I6dUAtWoTII"]);
    const d = dedupFor([{ sceneIndex: 1, beats: [sentence(0, "Accountants lay out the reality.")] }]);
    const placer = vi.fn(async () => ({ hold: 3.5 }));
    vp.openLatePlacement(d, 1, placer);
    vp.markSceneClosed(d, 1);
    const look = editor(d, 1, null);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 1 }], results([]), look, { windowMs: 50, looksMs: 5_000 }, lateStockFor(64103, d, since));
    expect(look).toHaveBeenCalledTimes(1);
    expect(await vp.placeApprovedAfterSceneClosed(d, 1, { sceneReturned: true, final: true })).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
    releaseYoutubeShotStock(64103);
  });

  it("TEST 4 — the picture editor approves it: placed through the existing final placement (the 641 case)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const since = await filmWithLateStock(64104, ["UJT6QkAriVQ"], ["I6dUAtWoTII"]);
    const d = dedupFor([{ sceneIndex: 1, beats: [sentence(0, "Kim Kardashian at home.")] }]);
    const placer = vi.fn(async (_clip: string, _beat: number) => ({ hold: 3.5 }));
    vp.openLatePlacement(d, 1, placer);
    vp.markSceneClosed(d, 1);
    const look = editor(d, 1, "I6dUAtWoTII");
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 1 }], results([]), look, { windowMs: 50, looksMs: 5_000 }, lateStockFor(64104, d, since));
    const placed = await vp.placeApprovedAfterSceneClosed(d, 1, { sceneReturned: true, final: true });
    expect(placed.length).toBe(1);
    expect(placed[0]!.beatIndex).toBe(0);
    expect(videoOf(d, placed[0]!.clip)).toBe("I6dUAtWoTII");
    expect(placer).toHaveBeenCalledTimes(1);
    releaseYoutubeShotStock(64104);
  });

  it("TEST 5 — a sentence that already has a picture is not offered the late video; an open one is", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const since = await filmWithLateStock(64105, [], ["I6dUAtWoTII"]);
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "Has its picture."), sentence(1, "Still open.")] }]);
    const look = editor(d, 0, null);
    /** sentence 0 is served by the video (the pool's look), but it already has a picture */
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results([0]), look, { windowMs: 50, looksMs: 5_000 }, lateStockFor(64105, d, since, (_id, b) => b === 0));
    expect(look).toHaveBeenCalledTimes(1);
    expect((look.mock.calls[0]![0] as { index: number }).index).toBe(1);
    releaseYoutubeShotStock(64105);
  });

  it("TEST 11 (P2) — the existing 3 s rule: stock under 3 s is never made into a late moment, judged, stretched or placed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(belowArchiveMinimumDuration(2.99)).toBe(true);
    expect(belowArchiveMinimumDuration(3)).toBe(false);
    const since = await filmWithLateStock(64111, [], ["short_vid"], 2);
    const d = dedupFor([{ sceneIndex: 1, beats: [sentence(0, "Open sentence.")] }]);
    const placer = vi.fn(async () => ({ hold: 3.5 }));
    vp.openLatePlacement(d, 1, placer);
    vp.markSceneClosed(d, 1);
    const look = editor(d, 1, "short_vid");
    expect(vp.lateStockToOffer(64111, d as never, since).line).toContain("skipped={no_usable_shot:too_short=1}");
    /** even handed the id directly, no moment under 3 s is cut: the picture editor spends no look on it */
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 1 }], results([]), look, { windowMs: 50, looksMs: 10_000 }, lateStockFor(64111, d, since, () => false));
    expect(await vp.takeLateStockMoments(64111, d, 1, { index: 0, text: "x" }, ["short_vid"], dir)).toEqual([]);
    expect(look).not.toHaveBeenCalled();
    expect(await vp.placeApprovedAfterSceneClosed(d, 1, { sceneReturned: true, final: true })).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
    releaseYoutubeShotStock(64111);
  });

  it("TEST 12 — the 180 s wait cap is unchanged; the fix waits for nothing", () => {
    expect(vp.YOUTUBE_STOCK_WAIT_MAX_MS).toBe(180_000);
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const body = PIPE.slice(PIPE.indexOf("export async function takeLateStockMoments("), PIPE.indexOf("export function assignLateStockVideos<"));
    /** takeStockShots with 0 ms: only what is ready now */
    expect(body).toMatch(/takeStockShots\(\s*filmId,\s*id,\s*0,/);
    expect(body).not.toMatch(/fetchYouTubeCCClips|searchYouTube|downloadYoutube|youtubeStockSettled|ingest/i);
  });
});

describe("LATE STOCK — one claim, one offer, no duplicates", () => {
  it("TEST 6 — two open sentences both served by the late video: it goes to ONE; a second take finds nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const since = await filmWithLateStock(64106, [], ["I6dUAtWoTII"]);
    const sentences = [
      { sceneIndex: 0, beatIndex: 0 },
      { sceneIndex: 2, beatIndex: 1 },
    ];
    const assigned = vp.assignLateStockVideos(["I6dUAtWoTII"], sentences, (_id, s) => s.sceneIndex === 2);
    expect([...assigned.entries()]).toEqual([[vp.youtubeTurnKey(2, 1), ["I6dUAtWoTII"]]]);
    /** two takes started together (two looks side by side): only the first gets the shots */
    const d = dedupFor([]);
    const [a, b] = await Promise.all([
      vp.takeLateStockMoments(64106, d, 0, { index: 0, text: "x" }, ["I6dUAtWoTII"], dir),
      vp.takeLateStockMoments(64106, d, 2, { index: 1, text: "y" }, ["I6dUAtWoTII"], dir),
    ]);
    expect(a.length).toBe(2);
    expect(b).toEqual([]);
    expect(lateReadyStockVideos(64106, since)).toEqual([]);
    releaseYoutubeShotStock(64106);
  });

  it("TEST 7 — offered once: after the last look the video is no longer late; a second stage offers nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const since = await filmWithLateStock(64107, [], ["I6dUAtWoTII"]);
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "Open."), sentence(1, "Also open.")] }]);
    const look = editor(d, 0, null);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results([]), look, { windowMs: 50, looksMs: 5_000 }, lateStockFor(64107, d, since));
    const offeredOnce = look.mock.calls.filter((c) => (c[2] as string[]).some((p) => videoOf(d, p) === "I6dUAtWoTII"));
    expect(offeredOnce.length).toBe(1);
    expect(lateReadyStockVideos(64107, since)).toEqual([]);
    const madeOnce = fs.readdirSync(dir).filter((f) => f.includes("_ytfu_late")).sort();
    const judgedBy = (beatIndex: number, p: string) => d.beatRelevance.byBeat.has(bvr.beatRelevanceBeatKey(0, beatIndex, "path", p));
    const judgedBefore = (offeredOnce[0]![2] as string[]).map((p) => [0, 1].filter((b) => judgedBy(b, p)));
    look.mockClear();
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results([]), look, { windowMs: 50, looksMs: 5_000 }, lateStockFor(64107, d, since));
    /** Not late again: no second claim, no new moment cut. */
    expect(fs.readdirSync(dir).filter((f) => f.includes("_ytfu_late")).sort()).toEqual(madeOnce);
    /**
     * STEP 0 — a moment one sentence refused may be judged ONCE by the other sentence (the render's
     * inventory), never twice by the sentence that refused it.
     */
    expect(judgedBefore.every((by) => by.length === 1)).toBe(true);
    for (const c of look.mock.calls) {
      const beatIndex = (c[0] as { index: number }).index;
      const lateHere = (c[2] as string[]).filter((p) => p.includes("_ytfu_late"));
      expect(lateHere.every((p) => !(offeredOnce[0]![2] as string[]).includes(p) || (offeredOnce[0]![0] as { index: number }).index !== beatIndex)).toBe(true);
    }
    releaseYoutubeShotStock(64107);
  });

  it("TEST 8 — no second set of files: one moment per shot, never re-made; the late path stores nothing in the archive", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await filmWithLateStock(64108, [], ["I6dUAtWoTII"]);
    const d = dedupFor([]);
    const first = await vp.takeLateStockMoments(64108, d, 1, { index: 0, text: "x" }, ["I6dUAtWoTII"], dir);
    const again = await vp.takeLateStockMoments(64108, d, 1, { index: 0, text: "x" }, ["I6dUAtWoTII"], dir);
    expect(first.length).toBe(2);
    expect(new Set(first).size).toBe(2);
    expect(again).toEqual([]);
    releaseYoutubeShotStock(64108);
  });

  it("TEST 9 — one lineage per moment, recorded as downloaded, and none twice", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await filmWithLateStock(64109, [], ["I6dUAtWoTII"]);
    const d = dedupFor([]);
    const made = await vp.takeLateStockMoments(64109, d, 1, { index: 0, text: "x" }, ["I6dUAtWoTII"], dir);
    const records = made.map((p) => d.sourcingCache.lineage.resolve(p));
    expect(records.every((r) => r != null)).toBe(true);
    expect(new Set(records.map((r) => r!.lineageId)).size).toBe(made.length);
    expect(records.every((r) => d.sourcingCache.lineage.hasStage(r!.lineageId, "DOWNLOAD_SUCCEEDED"))).toBe(true);
    expect(await vp.takeLateStockMoments(64109, d, 1, { index: 0, text: "x" }, ["I6dUAtWoTII"], dir)).toEqual([]);
    releaseYoutubeShotStock(64109);
  });

  it("the pipeline hands the late stock to the last look, after the pictures started, before the final placement", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const late = PIPE.indexOf("const lateStock = lateStockToOffer(videoId, visualDedup, visualDedup.pipelineStartedMs ?? Date.now());");
    /** FIX 2 — read by the stage after its review window, through `videoIds: lateStockNow`. */
    expect(PIPE).toContain("videoIds: lateStockNow,");
    const stage = PIPE.indexOf("await runFinalReadyYoutubeStage(visualDedup, scenes, sceneVisualResults, (beat, sceneIndex, ready) =>");
    expect(late).toBeGreaterThan(PIPE.indexOf("visualDedup.pipelineStartedMs = Date.now();"));
    expect(late).toBeLessThan(stage);
    expect(stage).toBeLessThan(PIPE.indexOf("for (let si = 0; si < scenes.length; si++) await placeLate(si, true);"));
  });
});

describe("LATE STOCK — the outcome lines say where a stock download stopped", () => {
  const cand = (videoId: string, from: number): PoolCandidate => ({
    videoId, title: `title ${videoId}`, description: "", thumb: "", durationSec: 300, footageType: "real_footage", serves: [8], from, usable: true, why: "ok",
  });
  const pool: Pick<VideoYoutubePool, "entityTargets" | "candidates" | "searches"> = {
    searches: 4,
    entityTargets: [{ name: "Calabasas corporate office", kind: "subject", beats: [8], reason: "missing_visual_subject", n: 4, query: "q", score: 2 }],
    candidates: [cand("I6dUAtWoTII", 4), cand("LQCQym6hVMo", 4), cand("never_stocked", 4)],
  };

  it("TEST 10 — downloaded but never offered: stock_downloaded=1, stock_offered=0, STOCK_READY_NOT_OFFERED; lifecycle counts unchanged", () => {
    const state = (id: string) =>
      id === "I6dUAtWoTII" ? { status: "ready" as const, offered: false } : id === "LQCQym6hVMo" ? { status: "failed" as const, offered: false } : null;
    const lines = formatMultiPersonOutcome(641, pool, [], [], state);
    expect(lines).toContain(
      '[MULTI_PERSON_OUTCOME] video=641 entity="Calabasas corporate office" search=#4 downloaded=0 adopted=0 final=0 entityBeats=[8] stock_downloaded=1 stock_offered=0'
    );
    expect(lines).toContain('[TARGETED_VISUAL] video=641 subject="Calabasas corporate office" search=#4 videoId=I6dUAtWoTII stage=STOCK_READY_NOT_OFFERED');
    expect(lines).toContain('[TARGETED_VISUAL] video=641 subject="Calabasas corporate office" search=#4 videoId=LQCQym6hVMo stage=STOCK_DOWNLOAD_FAILED');
    expect(lines.some((l) => l.includes("never_stocked"))).toBe(false);
    expect(lines.at(-1)).toBe(
      "[MULTI_PERSON_SUMMARY] video=641 searches=4 targeted_searches=1 targeted_downloaded=0 targeted_adopted=0 targeted_final=0 targeted_stock_downloaded=1 targeted_stock_offered=0"
    );
    /** without the stock, the lines are exactly the old ones */
    expect(formatMultiPersonOutcome(641, pool, [])).toEqual([
      '[MULTI_PERSON_OUTCOME] video=641 entity="Calabasas corporate office" search=#4 downloaded=0 adopted=0 final=0 entityBeats=[8]',
      "[MULTI_PERSON_SUMMARY] video=641 searches=4 targeted_searches=1 targeted_downloaded=0 targeted_adopted=0 targeted_final=0",
    ]);
  });
});
