import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { MIN_VIDEO_DURATION_SEC } from "./archiveIngestion";
import {
  beatOutcomeKey,
  beatRecord,
  beatsWithPlacedRealFootage,
  createBeatOutcomeAudit,
  noteBeatAdopted,
  resolveBeatCoverage,
} from "./beatOutcomeAudit";
import { buildCinematicSceneInputs, pairClipsToBeats, shareBeatTime, type ProductionBeat, type SceneFacts } from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import { storeForProduction, ARCHIVE_READBACK_RETRY_DELAYS_MS, type ProductionArchiveDeps } from "./productionMediaArchive";
import type { TimelineVideoClip } from "./projectTimeline";
import { youtubeFootageInTimeline } from "./youtubeFootageInFilm";
import { assetUsedInVideo } from "./visualDedupRegistry";
import {
  MAX_STOCK_ATTEMPTS,
  MAX_STOCK_VIDEOS,
  STOCK_FIRST_BATCH,
  lateReadyStockVideos,
  releaseYoutubeShotStock,
  startYoutubeShotStock,
  stockOrder,
  stockSummary,
  youtubeStockSettled,
  type StockCandidate,
} from "./youtubeShotStock";
import type { Scene } from "./pipeline/types";

/**
 * VIDEO 642 — THE VISUAL FUNNEL, 641 AND 642 AS THE REFERENCE.
 *
 * 642: 96 usable YouTube videos → 4 stocked → 16 shots → 2 FIT → 1 placed → 6.5 s of real footage
 * in a one-minute film. Each section below is one narrowing of that funnel, and the line it must
 * not cross: the Judge decides, the same moment is never used twice, the 3 s minimum and the
 * sentence's own seconds hold.
 */

/** The picture editor, answered per content key — the gates in front of it and behind it are the real ones. */
const verdicts = new Map<string, "fits" | "does_not_fit" | "unknown">();
const judged: string[] = [];
vi.mock("./beatImageRelevanceGate", async (orig) => {
  const real = await orig<typeof import("./beatImageRelevanceGate")>();
  return {
    ...real,
    judgeBeatImage: vi.fn(async (p: { contentKey: string; state: { judgementAttempts: number } }) => {
      p.state.judgementAttempts++;
      judged.push(p.contentKey);
      return { verdict: verdicts.get(p.contentKey) ?? "does_not_fit", depicts: "a car factory floor", reason: "test", evaluated: true };
    }),
  };
});

type VP = typeof import("./videoPipeline");
let vp: VP;
let dir: string;
beforeAll(async () => {
  vp = await import("./videoPipeline");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-642-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  verdicts.clear();
  judged.length = 0;
});
const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};

/* ═══════════ helpers: real files, real gates ═══════════ */

const SENTENCE = "Elon Musk walked through the Tesla factory.";
let fileNo = 0;
/** A real, decodable, busy video of `seconds` — big enough for the size floor. */
function rawVideo(seconds: number): string {
  const raw = path.join(dir, `raw_${fileNo++}.mp4`);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=s=640x360:d=${seconds}:r=25,noise=alls=60:allf=t`,
    "-c:v", "libx264", "-b:v", "3M", "-pix_fmt", "yuv420p", raw,
  ]);
  return raw;
}
/** A YouTube moment file exactly as `offerMoments` names it: provider tag and source seconds in the name. */
function moment(dedup: ReturnType<VP["createVisualDedupState"]>, videoId: string, startSec: number, seconds = 4, beatIndex = 0): string {
  const p = vp.tagPathWithProviderAsset(
    path.join(dir, `scene_0_ytfu_${fileNo}m0_t${Math.round(startSec * 10)}d${Math.round(seconds * 10)}.mp4`),
    "youtube_cc",
    videoId,
    dedup.sourcingCache,
    { sceneIndex: 0, beatIndex, title: "Tesla factory tour", mediaType: "video", searchRoute: "fetchYouTubeCCClips" }
  );
  fs.copyFileSync(rawVideo(seconds), p);
  vp.putCachedProviderAsset(dedup.sourcingCache, "youtube_cc", videoId, {
    providerText: { title: "Tesla factory tour with Elon Musk", description: "Inside the Tesla factory" },
  });
  return p;
}
const newDedup = () => vp.createVisualDedupState(vp.getPipelinePerfProfile("1"));
const fit = (...paths: string[]) => paths.forEach((p) => verdicts.set(vp.clipContentKey(p), "fits"));
/** The sentence's first picture, through the real `adoptClip`. */
const firstPicture = (dedup: ReturnType<typeof newDedup>, paths: string[], beatIndex = 0) =>
  vp.adoptClipForTest(paths, dedup, 0, beatIndex, SENTENCE, dir, "Tesla factory");
const sourceOf = (p: string) => /__pid_youtube_cc-([0-9a-f]+)/.exec(p)?.[1];

/* ═══════════ 1 / 2 / 17 — selection: a big pool, coverage first, no source takes everything ═══════════ */

describe("SELECTION — the stock is chosen for what it covers", () => {
  /**
   * 642's shape: many videos that the pool's look gave to the same few sentences, and a few
   * videos — further down the list — that are the only ones for their sentence.
   */
  const bigPool = (): StockCandidate[] => [
    ...Array.from({ length: 30 }, (_, i) => ({ videoId: `generic${i}`, title: `generic ${i}`, durationSec: 600, serves: 6, beats: [0, 1, 2, 3, 4, 5] })),
    ...[6, 7, 8, 9].map((b) => ({ videoId: `only${b}`, title: `only for ${b}`, durationSec: 600, serves: 1, beats: [b] })),
    ...Array.from({ length: 62 }, (_, i) => ({ videoId: `none${i}`, title: `none ${i}`, durationSec: 600, serves: 0, beats: [] as number[] })),
  ];
  const covered = (order: StockCandidate[]) => new Set(order.flatMap((c) => c.beats ?? []));

  it("1. a pool of 96: the first batch covers every sentence something serves — the old order covered six of ten", () => {
    const pool = bigPool();
    expect(pool).toHaveLength(96);
    const now = stockOrder(pool, STOCK_FIRST_BATCH);
    expect([...covered(now)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    /** before: serves count only — six generic videos, sentences 6–9 never stocked */
    const before = stockOrder(pool.map(({ beats: _b, ...c }) => c), STOCK_FIRST_BATCH);
    expect(before.every((c) => c.videoId.startsWith("generic"))).toBe(true);
  });

  it("1b. a video that is the only one for its sentence is not passed over for a generic video with more serves", () => {
    const order = stockOrder(bigPool(), MAX_STOCK_VIDEOS);
    for (const b of [6, 7, 8, 9]) expect(order.findIndex((c) => c.videoId === `only${b}`)).toBeLessThan(STOCK_FIRST_BATCH);
  });

  it("2. more than two candidates for a sentence: depth 2 gives each served sentence a second video before any extra", () => {
    const pool: StockCandidate[] = [
      ...["a", "b", "c"].map((id) => ({ videoId: `s0_${id}`, title: id, durationSec: 600, serves: 1, beats: [0] })),
      ...["a", "b", "c"].map((id) => ({ videoId: `s1_${id}`, title: id, durationSec: 600, serves: 1, beats: [1] })),
    ];
    const order = stockOrder(pool, 4).map((c) => c.videoId);
    expect(order.filter((id) => id.startsWith("s0_"))).toHaveLength(2);
    expect(order.filter((id) => id.startsWith("s1_"))).toHaveLength(2);
  });

  it("17. source share: no two sources take every place, and the download count stays bounded (never 'all 96')", async () => {
    const order = stockOrder(bigPool(), MAX_STOCK_VIDEOS);
    expect(new Set(order.map((c) => c.videoId)).size).toBe(order.length);
    expect(order.length).toBe(MAX_STOCK_VIDEOS);
    quiet();
    const started: string[] = [];
    const film = 964201;
    startYoutubeShotStock(film, bigPool(), {
      workDir: dir,
      download: async (id, _s, _d, out) => (started.push(id), fs.writeFileSync(out, "x"), true),
      cut: async (f) => [{ path: f, startSec: 0, endSec: 5 }],
      startFor: () => 0,
    });
    for (let i = 0; i < 200 && stockSummary(film).ready < MAX_STOCK_VIDEOS; i++) await new Promise((r) => setTimeout(r, 10));
    await youtubeStockSettled(film);
    expect(started.length).toBe(MAX_STOCK_VIDEOS);
    expect(started.length).toBeLessThanOrEqual(MAX_STOCK_ATTEMPTS);
    releaseYoutubeShotStock(film);
  });

  it("the limits: 10 ready, 14 attempts, the first batch of 6 is what the picture stage waits for", () => {
    expect([STOCK_FIRST_BATCH, MAX_STOCK_VIDEOS, MAX_STOCK_ATTEMPTS]).toEqual([6, 10, 14]);
  });
});

/* ═══════════ 3–8 — several FIT shots for one sentence, through the real adoptClip ═══════════ */

describe("MORE THAN ONE PICTURE PER SENTENCE — only FIT, never the same moment", () => {
  it("3/4. one sentence, two FIT moments of the SAME video: the first is its picture, the fill adopts the second", async () => {
    quiet();
    const dedup = newDedup();
    const a = moment(dedup, "AAAAAAAAAAA", 0);
    const b = moment(dedup, "AAAAAAAAAAA", 20);
    fit(a, b);
    const first = await firstPicture(dedup, [a, b]);
    expect(first).toBeTruthy();
    const second = await vp.adoptAnotherFitForBeat(dedup, 0, 0, dir);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(sourceOf(second!)).toBe(sourceOf(first!));
    /** both were judged FIT for THIS sentence; nothing was adopted without a verdict */
    expect(new Set(judged)).toEqual(new Set([vp.clipContentKey(a), vp.clipContentKey(b)]));
  }, 120_000);

  it("5. one sentence, two sources: the fill's second picture comes from the other video", async () => {
    quiet();
    const dedup = newDedup();
    const a = moment(dedup, "AAAAAAAAAAA", 0);
    const c = moment(dedup, "CCCCCCCCCCC", 0);
    fit(a, c);
    const first = await firstPicture(dedup, [a, c]);
    const second = await vp.adoptAnotherFitForBeat(dedup, 0, 0, dir);
    expect(first && second).toBeTruthy();
    expect(sourceOf(second!)).not.toBe(sourceOf(first!));
  }, 120_000);

  it("6. the exact same moment is refused, and so are overlapping seconds of the same video", async () => {
    quiet();
    const dedup = newDedup();
    const a = moment(dedup, "AAAAAAAAAAA", 0);
    const overlap = moment(dedup, "AAAAAAAAAAA", 2);
    fit(a, overlap);
    expect(await firstPicture(dedup, [a])).toBeTruthy();
    /** a later route hands the sentence the same file again, and a moment whose seconds overlap it */
    dedup.beatCandidateCalls!.get("0:0")!.push({ paths: [a, overlap], beatText: SENTENCE, sourceQuery: "Tesla factory", opts: {} });
    judged.length = 0;
    expect(await vp.adoptAnotherFitForBeat(dedup, 0, 0, dir)).toBeNull();
    /** neither was even put to the picture editor again */
    expect(judged).toEqual([]);
    expect(assetUsedInVideo(dedup, { path: a, contentKey: vp.clipContentKey(a) })).toBeTruthy();
    expect(assetUsedInVideo(dedup, { path: overlap, contentKey: vp.clipContentKey(overlap) })).toBe("segment_overlap");
  }, 120_000);

  it("7. a moment the picture editor refuses is never the second picture — no reprieve, no hold", async () => {
    quiet();
    const dedup = newDedup();
    const a = moment(dedup, "AAAAAAAAAAA", 0);
    const bad = moment(dedup, "BBBBBBBBBBB", 0);
    fit(a);
    verdicts.set(vp.clipContentKey(bad), "does_not_fit");
    expect(await firstPicture(dedup, [a])).toBeTruthy();
    /** a later route hands the sentence the candidate the picture editor will refuse */
    dedup.beatCandidateCalls!.get("0:0")!.push({ paths: [bad], beatText: SENTENCE, sourceQuery: "Tesla factory", opts: {} });
    expect(await vp.adoptAnotherFitForBeat(dedup, 0, 0, dir)).toBeNull();
    expect(judged).toContain(vp.clipContentKey(bad));
    expect(assetUsedInVideo(dedup, { path: bad, contentKey: vp.clipContentKey(bad) })).toBeFalsy();
  }, 120_000);

  it("7b. a moment the editor could not read (UNCLEAR) is never the second picture either — FIT or nothing", async () => {
    quiet();
    const dedup = newDedup();
    const a = moment(dedup, "AAAAAAAAAAA", 0);
    const unsure = moment(dedup, "UUUUUUUUUUU", 0);
    fit(a);
    verdicts.set(vp.clipContentKey(unsure), "unknown");
    expect(await firstPicture(dedup, [a])).toBeTruthy();
    dedup.beatCandidateCalls!.get("0:0")!.push({ paths: [unsure], beatText: SENTENCE, sourceQuery: "Tesla factory", opts: {} });
    expect(await vp.adoptAnotherFitForBeat(dedup, 0, 0, dir)).toBeNull();
    expect(judged).toContain(vp.clipContentKey(unsure));
    expect(assetUsedInVideo(dedup, { path: unsure, contentKey: vp.clipContentKey(unsure) })).toBeFalsy();
  }, 120_000);

  it("B-1 TEST 4 — the first relevant moment is MISMATCH: the next relevant moment gets its look and is the picture", async () => {
    quiet();
    const dedup = newDedup();
    const wrong = moment(dedup, "CCCCCCCCCCC", 0);
    const right = moment(dedup, "DDDDDDDDDDD", 0);
    verdicts.set(vp.clipContentKey(wrong), "does_not_fit");
    fit(right);
    const picked = await firstPicture(dedup, [wrong, right]);
    expect(picked).toBeTruthy();
    expect(sourceOf(picked!)).toBe(sourceOf(right));
    expect(judged).toEqual(expect.arrayContaining([vp.clipContentKey(wrong), vp.clipContentKey(right)]));
    expect(assetUsedInVideo(dedup, { path: wrong, contentKey: vp.clipContentKey(wrong) })).toBeFalsy();
  }, 120_000);

  it("8. the 3 s minimum stays: a 2.5 s moment is refused before review, and an extra shot needs 3 s of the sentence", async () => {
    quiet();
    const dedup = newDedup();
    const short = moment(dedup, "SSSSSSSSSSS", 0, 2.5);
    fit(short);
    (dedup.beatCandidateCalls ??= new Map()).set("0:0", [{ paths: [short], beatText: SENTENCE, sourceQuery: "x", opts: {} }]);
    expect(await vp.adoptAnotherFitForBeat(dedup, 0, 0, dir)).toBeNull();
    expect(judged).toEqual([]);
    expect(vp.BEAT_EXTRA_SHOT_MIN_SEC).toBe(MIN_VIDEO_DURATION_SEC);
    expect(vp.BEAT_EXTRA_SHOT_MIN_SEC).toBe(3);
    /** a 10 s sentence with 4 + 4 s on screen: 2 s left — held over, no third shot */
    expect(vp.beatSecondsLeft(10, 0, [0, 0], [4, 4])).toBe(2);
    expect(vp.beatSecondsLeft(10, 0, [0, 0], [4, 4]) < vp.BEAT_EXTRA_SHOT_MIN_SEC).toBe(true);
  }, 120_000);

  it("the fill asks the sentence's own FIT candidates first, then the own archive, inside the sentence's turn", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const body = PIPE.slice(PIPE.indexOf("const fillBeatWithMoreClips = async"), PIPE.indexOf("const placeLateApprovedPicks = async"));
    expect(body.indexOf("adoptAnotherFitForBeat(dedup, scene.index, f.beat.index, workDir)")).toBeGreaterThan(0);
    expect(body.indexOf("adoptAnotherFitForBeat(")).toBeLessThan(body.indexOf("ownArchiveBeatClip("));
    expect(body).toContain("if (rest >= BEAT_EXTRA_SHOT_MIN_SEC) {");
    expect(body).toContain("pushSceneClip(clipPath, rest, f.beat.index)");
    /** at most three more per sentence, as before */
    expect(vp.BEAT_FILL_MAX_EXTRA_CLIPS).toBe(3);
  });
});

/* ═══════════ 9 / 10 — the sentence's seconds and the captions ═══════════ */

const HOLD = 12;
function beatOf(index: number): ProductionBeat {
  return { index, text: `Elon Musk walked through the Tesla factory, part ${index}.`, searchQuery: "tesla factory", powerWord: "Tesla", keywords: ["factory"], holdSec: HOLD };
}
function clipFact(id: string, sec: number) {
  return {
    facts: { localPath: `/tmp/${id}.mp4`, durationSec: sec, widthPx: 1920, heightPx: 1080 },
    adoption: { provider: "youtube_cc", providerAssetId: id, sourceUrl: `https://youtube.invalid/${id}`, assetTitle: "Tesla factory tour", query: "tesla factory" },
  };
}
function sceneWith(more: boolean): SceneFacts {
  const beats = [beatOf(0), beatOf(1)];
  return {
    scene: { index: 0, text: "Elon Musk walked through the Tesla factory.", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: HOLD * 2 } as Scene,
    beats,
    clips: [clipFact("first0", 4), clipFact("first1", 12)],
    ...(more ? { moreClips: [[clipFact("second0", 4), clipFact("third0", 4)], []] } : {}),
  };
}
const timelineOf = (more: boolean) => {
  const built = buildCinematicSceneInputs({ scenes: [sceneWith(more)] });
  return runCinematicPipeline({ videoId: 642, scenes: built.scenes }).timeline;
};

describe("TIMELINE — several clips under one sentence", () => {
  it("9. three 4 s clips fill a 12 s sentence exactly; nothing runs past the sentence; the next sentence starts on time", () => {
    expect(shareBeatTime(HOLD, [4, 4, 4])).toEqual([4, 4, 4]);
    expect(shareBeatTime(HOLD, [4, 4, 4, 4]).reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(HOLD);
    const video = timelineOf(true).tracks.find((t) => t.kind === "VIDEO");
    const clips = video && video.kind === "VIDEO" ? video.clips : [];
    const first = clips.filter((c) => c.timelineStart < HOLD - 1e-6);
    expect(first.length).toBe(3);
    expect(Math.max(...first.map((c) => c.timelineEnd))).toBeCloseTo(HOLD, 3);
    expect(clips.find((c) => c.timelineStart >= HOLD - 1e-6)!.timelineStart).toBeCloseTo(HOLD, 3);
    /** pairing by the push's own sentence index: each sentence gets all of its clips, none of another's */
    expect(pairClipsToBeats({ clipPaths: ["a", "b", "c", "d"], clipBeatIndices: [0, 1, 0, 0], beats: [{ index: 0 }, { index: 1 }] })).toEqual([["a", "c", "d"], ["b"]]);
  });

  it("10. captions, text and audio are the same with one clip or three under a sentence", () => {
    const strip = (more: boolean) =>
      timelineOf(more).tracks.filter((t) => t.kind !== "VIDEO").map((t) => JSON.stringify(t, (k, v) => (k === "id" ? undefined : v)));
    expect(strip(true)).toEqual(strip(false));
  });
});

/* ═══════════ 11–14 — B1..B4 of the 641 round still hold ═══════════ */

describe("B1–B4 of the 641 round", () => {
  it("11. B1 — late-ready stock is still recognised as late", async () => {
    quiet();
    const film = 964211;
    const since = Date.now() - 1_000;
    startYoutubeShotStock(film, [{ videoId: "late1", title: "late", durationSec: 60, serves: 1, beats: [0] }], {
      workDir: dir,
      download: async (_id, _s, _d, out) => (fs.writeFileSync(out, "x"), true),
      cut: async (f) => [{ path: f, startSec: 0, endSec: 5 }],
      startFor: () => 0,
    });
    await youtubeStockSettled(film);
    expect(lateReadyStockVideos(film, since)).toEqual(["late1"]);
    releaseYoutubeShotStock(film);
  });

  it("12. B2 — an approval after the scene closed still reaches its open sentence; a covered sentence gets no second", async () => {
    quiet();
    const picked = "/w/scene_1_ytfu_0m0_t2059d40__pid_youtube_cc-00366246f9a1b17d_transformed.mp4";
    const dedup = {};
    let resolve!: (v: string | null) => void;
    vp.noteLadderForBeat(dedup, 1, 3, 0, new Promise<string | null>((r) => { resolve = r; }));
    await vp.takeLateApprovedPicks(dedup, 1, 0, { sceneEnd: true });
    vp.noteApprovedPickForBeat(dedup, 1, 3, vp.clipContentKey(picked));
    const placer = vi.fn(async (_c: string, _b: number) => ({ hold: 4.3 }));
    vp.openLatePlacement(dedup, 1, placer);
    vp.markSceneClosed(dedup, 1);
    resolve(picked);
    await new Promise((r) => setTimeout(r, 5));
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 1, { sceneReturned: true, final: true, hasPicture: () => false })).toEqual([
      { beatIndex: 3, clip: picked, hold: 4.3 },
    ]);
  });

  it("13. B3 — YouTube in the film counts only visible clips", () => {
    const yt = (id: string, start: number, end: number, opacity?: number) =>
      ({ id, timelineStart: start, timelineEnd: end, source: { provider: "youtube_cc", providerAssetId: "UJT6QkAriVQ" }, previewSource: { kind: "none" }, ...(opacity === undefined ? {} : { transform: { opacity } }) }) as unknown as TimelineVideoClip;
    expect(youtubeFootageInTimeline([yt("a", 0, 4), yt("g", 4, 10, 0)], new Map(), "rendered_timeline").youtubeSec).toBe(4);
  });

  it("14. B4 — coverage is REAL_ASSET only where a real clip was placed under the sentence", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatAdopted(audit, 1, 3, "youtube_cc", "scene_1_ytfu_0m0.mp4");
    const rec = beatRecord(audit, 1, 3);
    const real = "/w/scene_1_ytfu_0m0_t2059d40__pid_youtube_cc-00366246f9a1b17d_transformed.mp4";
    expect(resolveBeatCoverage(rec, beatsWithPlacedRealFootage([{ path: real, sceneIndex: 1, beatIndex: 3 }]).has(beatOutcomeKey(1, 3)))).toBe("REAL_ASSET");
    expect(resolveBeatCoverage(rec, false)).toBe("NO_VALID_ASSET");
  });
});

/* ═══════════ 15 / 16 — the two retries ═══════════ */

function fakeArchive(readBack: ProductionArchiveDeps["readBack"]) {
  const rows = new Map<number, { mediaStatus?: string }>();
  let next = 1;
  const deps: ProductionArchiveDeps = {
    ingest: async () => {
      const id = next++;
      rows.set(id, {});
      return { assetId: id, storageKey: `k/${id}` };
    },
    updateAsset: async (id, patch) => {
      rows.set(id, { ...rows.get(id), ...patch });
    },
    readBack,
    sleep: async () => {},
  };
  return { deps, rows };
}
const store = (deps: ProductionArchiveDeps, clip: string) =>
  storeForProduction({
    localPath: clip,
    provider: "youtube_cc",
    providerAssetId: `id${fileNo++}`,
    metadata: { title: "Tesla factory tour", sourceUrl: "https://youtube.invalid/x", provider: "youtube_cc" } as never,
    deps,
    ctx: { projectId: 1, provider: "youtube_cc", providerAssetId: "x" },
    verifyDir: path.join(dir, "verify"),
    log: () => {},
  });

describe("RETRIES — one failed read is not a lost picture", () => {
  it("15. archive: not readable once, readable on the retry → ARCHIVED, not MISSING; always failing → MISSING after the retries", async () => {
    const clip = rawVideo(4);
    let calls = 0;
    const flaky = fakeArchive(async (_id, dest) => {
      calls++;
      if (calls < 2) return false;
      fs.copyFileSync(clip, dest);
      return true;
    });
    const ok = await store(flaky.deps, clip);
    expect(ok.status).not.toBe("failed");
    expect(calls).toBe(2);
    expect([...flaky.rows.values()][0]!.mediaStatus).not.toBe("MISSING");

    let tries = 0;
    const dead = fakeArchive(async () => (tries++, false));
    const lost = await store(dead.deps, rawVideo(4));
    expect(lost.status).toBe("failed");
    if (lost.status === "failed") expect(lost.mediaStatus).toBe("MISSING");
    expect(tries).toBe(1 + ARCHIVE_READBACK_RETRY_DELAYS_MS.length);
    expect(ARCHIVE_READBACK_RETRY_DELAYS_MS.length).toBeLessThanOrEqual(3);
  }, 60_000);

  it("16. NO_FRAME: a fast seek that writes nothing is retried with the accurate seek before the moment is given up", async () => {
    const { extractFrameAtFraction } = await import("./localClipVision");
    const clip = rawVideo(4);
    const out = path.join(dir, "frame.jpg");
    expect(await extractFrameAtFraction(clip, out, 0.5, 8_000)).toBe(true);
    /**
     * 642's shape: the container says 4 s (a 4 s audio track), the picture stops at 0.4 s. The fast
     * seek to 90 % lands where no picture is and ffmpeg writes no image — the `no_frame` of 642.
     */
    const short = path.join(dir, "short_video.mp4");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", clip, "-t", "0.4", "-c:v", "copy", short]);
    const broken = path.join(dir, "broken.mp4");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", short, "-f", "lavfi", "-i", "sine=d=4", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", broken]);
    const out2 = path.join(dir, "frame2.jpg");
    const got = await extractFrameAtFraction(broken, out2, 0.9, 8_000);
    expect(got).toBe(true);
    const LCV = fs.readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
    expect(LCV).toContain('? ["-y", "-i", videoPath, "-ss", seekSeconds.toFixed(2), "-frames:v", "1", "-q:v", "3", outPath]');
    expect(LCV).toContain("...(seekSeconds > 0 ? [{ seek: 0, accurate: true }] : []),");
  }, 60_000);
});

/* ═══════════ 18 — a sentence with one picture works as before ═══════════ */

describe("18. a single-picture sentence is unchanged", () => {
  it("one FIT candidate: it is the sentence's picture; the fill finds nothing more and adds nothing", async () => {
    quiet();
    const dedup = newDedup();
    const a = moment(dedup, "AAAAAAAAAAA", 0);
    fit(a);
    const first = await firstPicture(dedup, [a]);
    expect(first).toBeTruthy();
    expect(await vp.adoptAnotherFitForBeat(dedup, 0, 0, dir)).toBeNull();
    /** the recorded choice is the first picture: the fill does not overwrite it */
    expect(dedup.visionReviewPool.beats.get("0:0")?.adopted).toBe(vp.clipContentKey(a));
  }, 120_000);

  it("the soft target is printed, never enforced", () => {
    const line = vp.formatVisualShotsLine(
      [{ clips: ["/w/a.mp4", "/w/b.mp4", "/w/card.png"], beatDurations: [4, 4, 4], clipBeatIndices: [0, 0, 1] }],
      (c) => c.endsWith(".mp4")
    );
    expect(line).toBe("[VisualShots] coveredSentences=1 visibleRealShots=2 visibleRealSec=8.00 softTarget=20-30/min (below; a signal, not a rule)");
  });
});
