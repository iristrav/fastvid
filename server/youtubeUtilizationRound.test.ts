/**
 * W2–W6 (VIDEO 636) — YouTube better used, nothing loosened.
 *
 *   W2  a READY stock video the pool judged to serve the sentence is offered whatever its thumbnail rank
 *   W3  the film's stock fills to N READY videos: a failed download hands its place to the next usable one
 *   W4  the drawn fallback card yields to a real shot the picture editor approved for the sentence
 *   W5  the opening word stays a title over real footage (unchanged; pinned here)
 *   W6  YouTube footage a recent same-subject video showed goes behind fresh sources; its exact seconds
 *       are not offered again; a refusal is never written down as use
 *
 * W1's own tests are video636FairSourceLastLook.test.ts.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  beatRowsInStockOrder,
  isStocked,
  MAX_STOCK_ATTEMPTS,
  MAX_STOCK_VIDEOS,
  releaseYoutubeShotStock,
  STOCK_CONCURRENCY,
  STOCK_SECTION_SEC,
  stockOrder,
  stockSummary,
  startYoutubeShotStock,
  takeStockShots,
  type StockCandidate,
} from "./youtubeShotStock";
import {
  recentYoutubeUsage,
  recordArchiveVideoUsage,
  recordYoutubeVideoUsage,
  setRecentYoutubeUsageForFilm,
  youtubeSecondsShownRecently,
  youtubeSourceUsedRecently,
} from "./usageDiversity";
import { poolRowsForBeat, type VideoYoutubePool } from "./youtubeVideoPool";
import { placePrimaryGraphics } from "./edlToTimeline";
import { buildCinematicSceneInputs, type ProductionBeat, type SceneFacts } from "./cinematicPipelineInputs";
import { CHAPTER_CARD_FALLBACK } from "./cinematicEditingEngine/motionGraphicsPlanner";
import { openingWordText } from "./cinematicPipeline";
import { emptyTimeline, type ProjectTimeline, type TimelineGraphic, type TimelineVideoClip } from "./projectTimeline";
import { MAX_JUDGEMENTS_PER_BEAT, maxBeatImageJudgementsPerRender } from "./beatImageRelevanceGate";
import { maxRelevanceLooksPerBeat, youtubeForLastLook } from "./beatVisualRelevance";
import { MAX_YOUTUBE_SEARCHES_PER_VIDEO } from "./youtubeSearchBudget";
import { youtubeSearchPassesPerQuery } from "./config";
import { youtubeMaxDownloadsPerRender } from "./sourcingPolicy";
import { beatNamedEntitiesByKind, extractActionCue, extractPersonNamesFromText, extractVisualPlacePhrase, providerAssetKey, youtubeUsesInFinalVideo } from "./videoPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const STOCK_SRC = fs.readFileSync(path.join(__dirname, "youtubeShotStock.ts"), "utf8");

type Row = { id: string; ready?: boolean; serves?: boolean; shown?: boolean };
const order = (rows: Row[]) =>
  beatRowsInStockOrder(rows, {
    ready: (r) => Boolean(r.ready),
    serves: (r) => Boolean(r.serves),
    shownRecently: (r) => Boolean(r.shown),
  });
/** What the fetch loop tries: the serving ready stock, then the usual top five of the rest. */
const tried = (rows: Row[]) => {
  const o = order(rows);
  return [...o.first, ...o.rest.slice(0, 5)].map((r) => r.id);
};

/* ═══════════════════════════════════ W2 ═══════════════════════════════════ */

describe("W2 — READY + relevant is not lost to a second ranking", () => {
  /** 636: mr9kK0 ready with five shots, below the thumbnail ranker's top five for every sentence. */
  const s636: Row[] = [
    { id: "04AE" }, { id: "tj7" }, { id: "xbhq" }, { id: "b0q" }, { id: "kUm", ready: true },
    { id: "J3k" }, { id: "qbx" }, { id: "Jik" }, { id: "mr9", ready: true, serves: true },
  ];

  it("1. a READY video that serves the sentence is tried even at thumbnail rank 9", () => {
    expect(tried(s636)).toContain("mr9");
    expect(order(s636).first.map((r) => r.id)).toEqual(["mr9"]);
  });

  it("2. it comes before every row that still has to be downloaded; other ready stock next; downloads that serve the sentence before the rest", () => {
    const rows: Row[] = [{ id: "dl_other" }, { id: "dl_serves", serves: true }, { id: "ready_other", ready: true }, { id: "ready_serves", ready: true, serves: true }];
    expect([...order(rows).first, ...order(rows).rest].map((r) => r.id)).toEqual(["ready_serves", "ready_other", "dl_serves", "dl_other"]);
  });

  it("3/4. ordering only — no row is dropped, nothing is approved: the Judge still decides every moment", () => {
    const o = order(s636);
    expect([...o.first, ...o.rest]).toHaveLength(s636.length);
    /** The exempt rows go the stock road (takeStockShots → offerMoments → the beat's Judge), never straight to results. */
    const loop = PIPE.slice(PIPE.indexOf("const tried = [...servingFirst"), PIPE.indexOf("const poolDurationSec = row.durationSec"));
    expect(loop).toContain("if (!servingReadyRows.has(row)) {");
    expect(loop).toContain("takeStockShots(");
    expect(loop).toContain('offerMoments(videoId, title, row, took.shots, "the film\'s stock — no download")');
    /** Only the limit checks are skipped for those rows; every refusal check after them still runs. */
    const exempt = loop.slice(loop.indexOf("if (!servingReadyRows.has(row)) {"), loop.indexOf("const item = row.item;"));
    expect(exempt).toMatch(/fetched >= count[\s\S]*attemptsSpent\(\)[\s\S]*downloadsSoFar\(\) >= maxDownloadAttempts/);
    expect(loop.slice(loop.indexOf("const item = row.item;"))).toContain("providerAssetAlreadyUsed(usedProviderKeys, sourcingCache, \"youtube_cc\", videoId)");
  });

  it("the exempt group only ever holds READY stock — it cannot add a single download", () => {
    const o = order([{ id: "a", serves: true }, { id: "b", serves: true }, { id: "c", ready: true, serves: true }]);
    expect(o.first.map((r) => r.id)).toEqual(["c"]);
  });

  it("5. anti-repeat: a source a recent same-subject video showed is never exempt and goes last", () => {
    const o = order([{ id: "shown", ready: true, serves: true, shown: true }, { id: "fresh" }]);
    expect(o.first).toEqual([]);
    expect(o.rest.map((r) => r.id)).toEqual(["fresh", "shown"]);
  });

  it("the pool's sentence judgement survives as a flag on the row", () => {
    const pool = {
      videoId: 1, sentences: ["Tesla factory tour", "Musk on stage"], query1: null, query2: null, searches: 1,
      coverage1: 1, archiveUsable: 0, search2Needed: false, search2Reason: "", finalCoverage: 1, decided: true,
      candidates: [
        { videoId: "A", title: "a", description: "", thumb: "", durationSec: 100, footageType: "real_footage", serves: [1], from: 1, usable: true, why: "ok" },
        { videoId: "B", title: "b", description: "", thumb: "", durationSec: 100, footageType: "real_footage", serves: [0], from: 1, usable: true, why: "ok" },
      ],
    } as unknown as VideoYoutubePool;
    const rows = poolRowsForBeat(pool, "Tesla factory tour", []);
    expect(rows.find((r) => r.item.id.videoId === "B")?.servesBeat).toBe(true);
    expect(rows.find((r) => r.item.id.videoId === "A")?.servesBeat).toBeUndefined();
  });
});

/* ═══════════════════════════════════ W3 ═══════════════════════════════════ */

function stockHarness(failing: Set<string>, opts: { skip?: (id: string) => boolean; delayMs?: number } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "w3-stock-"));
  const started: string[] = [];
  let live = 0;
  let maxLive = 0;
  const deps = {
    workDir,
    startFor: () => 0,
    log: () => undefined,
    ...(opts.skip ? { skip: opts.skip } : {}),
    download: async (videoId: string, _start: number, _dur: number, outPath: string) => {
      started.push(videoId);
      live++;
      maxLive = Math.max(maxLive, live);
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));
      live--;
      if (failing.has(videoId)) return false;
      fs.writeFileSync(outPath, "x");
      return true;
    },
    cut: async (filePath: string) => [{ path: filePath, startSec: 0, endSec: 4 }, { path: filePath, startSec: 4, endSec: 8 }],
  };
  return { deps, started, maxLive: () => maxLive };
}
const cands = (n: number): StockCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ videoId: `v${i + 1}`, title: `video ${i + 1}`, durationSec: 300, serves: 0 }));
async function settle(filmId: number, started: string[]): Promise<void> {
  let last = -1;
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const s = stockSummary(filmId);
    if (started.length === last && s.videos === s.ready + s.failed) return;
    last = started.length;
  }
}

describe("W3 — the stock fills to N READY videos", () => {
  it("6. failures are replaced by the next usable candidate, until N are ready", async () => {
    const film = 960001;
    const h = stockHarness(new Set(["v2", "v4"]));
    startYoutubeShotStock(film, cands(10), h.deps);
    await settle(film, h.started);
    const s = stockSummary(film);
    expect(s.ready).toBe(MAX_STOCK_VIDEOS);
    expect(s.failed).toBe(2);
    expect(h.started).toEqual(expect.arrayContaining(["v7", "v8"]));
    expect(h.started).not.toContain("v9");
    releaseYoutubeShotStock(film);
  });

  it("7. many failures stay within MAX_STOCK_ATTEMPTS (9), and the stock never grows past N ready", async () => {
    const film = 960002;
    const h = stockHarness(new Set(["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10"]));
    startYoutubeShotStock(film, cands(15), h.deps);
    await settle(film, h.started);
    expect(MAX_STOCK_ATTEMPTS).toBe(9);
    expect(h.started.length).toBe(MAX_STOCK_ATTEMPTS);
    expect(stockSummary(film).ready).toBe(0);
    releaseYoutubeShotStock(film);
  });

  it("no failures: exactly the planned N, no replacement started", async () => {
    const film = 960003;
    const h = stockHarness(new Set());
    startYoutubeShotStock(film, cands(10), h.deps);
    await settle(film, h.started);
    expect(h.started.length).toBe(MAX_STOCK_VIDEOS);
    expect(isStocked(film, "v7")).toBe(false);
    releaseYoutubeShotStock(film);
  });

  it("a replacement the failure memory wrote off is passed over", async () => {
    const film = 960004;
    const h = stockHarness(new Set(["v1"]), { skip: (id) => id === "v7" });
    startYoutubeShotStock(film, cands(10), h.deps);
    await settle(film, h.started);
    expect(h.started).not.toContain("v7");
    expect(h.started).toContain("v8");
    releaseYoutubeShotStock(film);
  });

  it("8. no search: the stock only works through the results it was given", () => {
    expect(STOCK_SRC).not.toMatch(/claimYoutubeSearch|searchYoutube|search\.list|youtubeSearchBudget|buildVideoYoutubePool/);
    const imports = STOCK_SRC.match(/^import .* from "(.+)";$/gm) ?? [];
    expect(imports.map((l) => l.replace(/.*from "(.+)";$/, "$1")).sort()).toEqual(["./youtubeMoments", "fs", "path"]);
  });

  it("9. concurrency, section length and the stock download timeout are unchanged", async () => {
    expect(STOCK_CONCURRENCY).toBe(3);
    expect(STOCK_SECTION_SEC).toBe(40);
    expect(PIPE).toContain("const YOUTUBE_STOCK_DOWNLOAD_MS = 150_000;");
    const film = 960005;
    const h = stockHarness(new Set(["v1", "v2", "v3"]), { delayMs: 15 });
    startYoutubeShotStock(film, cands(12), h.deps);
    await settle(film, h.started);
    expect(h.maxLive()).toBeLessThanOrEqual(STOCK_CONCURRENCY);
    releaseYoutubeShotStock(film);
  });
});

/* ═══════════════════════════════ W4 / W5 ═══════════════════════════════ */

const shot = (id: string, start: number, end: number): TimelineVideoClip =>
  ({ id, source: { provider: "youtube", archiveAssetId: 1 }, timelineStart: start, timelineEnd: end, sourceIn: 0, sourceOut: end - start }) as TimelineVideoClip;
const fallbackSlot = (onlyWithoutApprovedFiller: boolean) => ({
  beatId: "s0b1", startSec: 4, endSec: 8,
  graphic: { graphicType: "chapter_card", data: { text: "Secret weapon" }, reason: `${CHAPTER_CARD_FALLBACK}: no source` },
  ...(onlyWithoutApprovedFiller ? { onlyWithoutApprovedFiller: true } : {}),
});

function planTwoSentences(clips: SceneFacts["clips"]) {
  const texts = ["Tesla began as a small company with a bold plan for electric cars.", "What crucial external forces would soon tilt the scales?"];
  const beats: ProductionBeat[] = texts.map((text, index) => ({
    index, text, searchQuery: "", powerWord: "", keywords: [], holdSec: 4, visualDescription: "",
    voiceStartSec: index * 4, voiceEndSec: index * 4 + 4,
  }));
  return buildCinematicSceneInputs({
    scenes: [{ scene: { index: 0, text: texts.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8 }, beats, clips }],
    extractors: {
      people: (t: string) => extractPersonNamesFromText(t),
      place: (t: string) => extractVisualPlacePhrase(t),
      action: (t: string) => extractActionCue(t),
      namedEntities: (t: string) => beatNamedEntitiesByKind(t),
    },
    filmSubject: "Tesla",
  });
}
const realClip = (i: number) => ({
  facts: { localPath: `/tmp/w4-${i}.mp4`, durationSec: 10, widthPx: 1920, heightPx: 1080 },
  adoption: { provider: "internet_archive", providerAssetId: `ia-${i}`, sourceUrl: `https://archive.invalid/${i}.mp4`, assetTitle: "shot", query: "shot" },
});

describe("W4 — a drawn card only where no approved real picture can stand", () => {
  it("10. the sentence's fallback card is now planned to yield to an approved real shot", () => {
    const built = planTwoSentences([realClip(0), null] as SceneFacts["clips"]);
    const slots = built.primaryGraphics ?? [];
    expect(slots).toHaveLength(1);
    expect(slots[0]!.graphic.reason.startsWith(CHAPTER_CARD_FALLBACK)).toBe(true);
    expect(slots[0]!.onlyWithoutApprovedFiller).toBe(true);
    /** …and with an approved filler the card is not placed: the real shot holds the sentence. */
    const placed = placePrimaryGraphics([shot("approved", 0, 4)], [] as TimelineGraphic[], [fallbackSlot(true)], () => true);
    expect(placed).toHaveLength(0);
  });

  it("11. without an approved filler the card stays as the fallback", () => {
    expect(placePrimaryGraphics([shot("neighbour", 0, 4)], [] as TimelineGraphic[], [fallbackSlot(true)], () => false)).toHaveLength(1);
    expect(placePrimaryGraphics([shot("neighbour", 0, 4)], [] as TimelineGraphic[], [fallbackSlot(true)])).toHaveLength(1);
  });

  it("12. a sentence that has an adopted real clip never gets a card planned at all", () => {
    const built = planTwoSentences([realClip(0), realClip(1)] as SceneFacts["clips"]);
    expect(built.primaryGraphics ?? []).toHaveLength(0);
  });

  it("13. the opening word is a title over real footage, without a box — never over a card", () => {
    const tl = emptyTimeline(1, { durationSec: 10 }) as ProjectTimeline;
    const video = tl.tracks.find((t) => t.kind === "VIDEO")!;
    if (video.kind === "VIDEO") video.clips.push(shot("first", 0, 6));
    const word = openingWordText(tl, "Musk");
    expect(word?.text).toBe("MUSK");
    expect(word?.style.backgroundOpacity ?? 0).toBe(0);
    const graphics = tl.tracks.find((t) => t.kind === "GRAPHICS");
    if (graphics?.kind === "GRAPHICS") {
      graphics.graphics.push({ id: "card", type: "title_card", start: 0, end: 4, data: { primaryVisual: true } } as never);
      expect(openingWordText(tl, "Musk")).toBeNull();
    }
  });
});

/* ═══════════════════════════════════ W6 ═══════════════════════════════════ */

describe("W6 — YouTube footage across same-subject videos", () => {
  const A = providerAssetKey("youtube_cc", "w6VideoAaa1");
  const B = providerAssetKey("youtube_cc", "w6VideoBbb2");

  it("14/15. a source the last same-subject video showed is ordered behind fresh sources", () => {
    recordYoutubeVideoUsage(970001, [{ footage: A, inSec: 30, outSec: 34 }], "Zeppelin airship disaster");
    const recent = recentYoutubeUsage("Zeppelin airship disaster story", 970002);
    expect(recent.has(A)).toBe(true);
    setRecentYoutubeUsageForFilm(970002, recent);
    expect(youtubeSourceUsedRecently(970002, `${A}@t300d40`)).toBe(true);
    expect(youtubeSourceUsedRecently(970002, B)).toBe(false);
    const stocked = stockOrder([
      { videoId: "A", title: "", durationSec: 100, serves: 3, shownRecently: true },
      { videoId: "B", title: "", durationSec: 100, serves: 1 },
    ]);
    expect(stocked.map((c) => c.videoId)).toEqual(["B", "A"]);
    setRecentYoutubeUsageForFilm(970002, null);
  });

  it("other subjects do not count, and the video's own record never counts against it", () => {
    recordYoutubeVideoUsage(970003, [{ footage: B }], "Coral reef bleaching");
    expect(recentYoutubeUsage("Zeppelin airship disaster", 970004).has(B)).toBe(false);
    expect(recentYoutubeUsage("Coral reef bleaching", 970003).has(B)).toBe(false);
  });

  it("16. only footage that reached the delivered film is recorded — a refused video is never written down", () => {
    const uses = youtubeUsesInFinalVideo(
      [
        { lineageId: "r1", providerAssetId: "usedVid0001", finalVideo: true },
        { lineageId: "r2", providerAssetId: "refusedVid1", finalVideo: false },
      ],
      [{ lineageId: "r1", parentLineageId: "r0" }, { lineageId: "r0", sourceInSec: 12, sourceOutSec: 16 }]
    );
    expect(uses).toEqual([{ footage: providerAssetKey("youtube_cc", "usedVid0001"), inSec: 12, outSec: 16 }]);
  });

  it("17. a recently used source is not blocked: it is still offered, last, and the Judge decides", () => {
    const o = beatRowsInStockOrder([{ id: "only" }], { ready: () => true, serves: () => true, shownRecently: () => true });
    expect([...o.first, ...o.rest].map((r) => r.id)).toEqual(["only"]);
  });

  it("18. the exact seconds already shown are kept off the next film; other seconds of the source stay available", () => {
    setRecentYoutubeUsageForFilm(970010, new Map([[A, [{ inSec: 30, outSec: 34 }]]]));
    expect(youtubeSecondsShownRecently(970010, A, 31, 3)).toBe(true);
    expect(youtubeSecondsShownRecently(970010, `${A}@t310d30`, 28, 3)).toBe(true);
    expect(youtubeSecondsShownRecently(970010, A, 40, 4)).toBe(false);
    expect(youtubeSecondsShownRecently(970010, B, 31, 3)).toBe(false);
    setRecentYoutubeUsageForFilm(970010, null);
  });

  it("the stock hands out only shots the caller does not refuse — the pipeline adds the seconds shown recently to that refusal", async () => {
    const film = 960020;
    const h = stockHarness(new Set());
    startYoutubeShotStock(film, cands(1), h.deps);
    await settle(film, h.started);
    const took = await takeStockShots(film, "v1", 0, (s) => s.sourceStartSec < 4, 3);
    expect(took.shots.map((s) => s.sourceStartSec)).toEqual([4]);
    releaseYoutubeShotStock(film);
    for (const filter of ["youtubeSecondsShownRecently(poolVideoId, providerAssetKey(\"youtube_cc\", videoId), s.sourceStartSec, momentDur(s))"]) {
      expect(PIPE.split(filter).length - 1, "both moment filters (stock and section)").toBe(2);
    }
  });

  it("the archive's own record of the same video keeps its YouTube part", () => {
    recordYoutubeVideoUsage(970020, [{ footage: A }], "Hindenburg zeppelin flight");
    recordArchiveVideoUsage(970020, [123], "Hindenburg zeppelin flight");
    expect(recentYoutubeUsage("Hindenburg zeppelin", 970021).has(A)).toBe(true);
  });
});

/* ═══════════════════════════════ SAFETY ═══════════════════════════════ */

describe("safety — nothing was loosened", () => {
  it("19. UNREVIEWED is never adopted (W1b stays in the loop)", () => {
    const loop = PIPE.slice(PIPE.indexOf("pendingEvidence.delete(p);"));
    const exit = loop.indexOf('if (beatEvidence === "UNREVIEWED") {');
    expect(exit).toBeGreaterThan(0);
    expect(exit).toBeLessThan(loop.indexOf("markAssetUsedInVideo(dedup"));
  });

  it("20. Judge limits unchanged", () => {
    expect(MAX_JUDGEMENTS_PER_BEAT).toBe(4);
    expect(maxRelevanceLooksPerBeat()).toBe(5);
    expect(maxBeatImageJudgementsPerRender()).toBe(120);
  });

  it("21. search limits unchanged, and no new search call anywhere in this round's code", () => {
    expect(MAX_YOUTUBE_SEARCHES_PER_VIDEO).toBe(2);
    expect(youtubeSearchPassesPerQuery()).toBe(1);
    expect(youtubeMaxDownloadsPerRender()).toBe(60);
    const w2 = PIPE.slice(PIPE.indexOf("const order = beatRowsInStockOrder("), PIPE.indexOf("const poolDurationSec = row.durationSec"));
    expect(w2).not.toMatch(/searchYoutubeVideoCandidates|claimYoutubeSearch|search\.list/);
  });

  it("22. the fragment and refusal memories still guard every road", () => {
    const stockFilter = PIPE.slice(PIPE.indexOf("const took = await takeStockShots("), PIPE.indexOf("youtubeMomentsPerVideo()\n              );"));
    expect(stockFilter).toContain("youtubeFragmentRefusal(");
    expect(stockFilter).toContain("youtubeSecondsAlreadyUsed(usedProviderKeys, videoId");
    const w1 = PIPE.slice(PIPE.indexOf("eligible: (q) => {"), PIPE.indexOf("return fs.existsSync(q);"));
    for (const check of ["refusedForAnotherSentence(q)", "dedup.refusedAssetsThisRender?.has(key)", "youtubeFragmentRefusal(fragment)", "assetUsedInVideo(dedup", "footageShareSoFar(dedup, key)"]) {
      expect(w1, check).toContain(check);
    }
    // VIDEO 638 (G4) — YouTube first in the pool, then the same footage-share rule.
    expect(PIPE).toContain("const lessFilled = preferLessFilledFootage(youtubeCandidatesFirst(tasteResult.rankedPaths), (p) => clipContentKey(p), dedup);");
  });
});

/* ═══════════════════════════════ 636 ═══════════════════════════════ */

describe("video 636 regressions", () => {
  it("s0b3 / mr9kK0: ready stock that serves the sentence reaches the Judge; ready stock never waits behind a download", () => {
    const rows: Row[] = [{ id: "04AE" }, { id: "tj7" }, { id: "xbhq" }, { id: "b0q" }, { id: "kUm", ready: true }, { id: "mr9", ready: true, serves: true }];
    const t = tried(rows);
    expect(t[0]).toBe("mr9");
    expect(t.indexOf("kUm")).toBeLessThan(t.indexOf("04AE"));
  });

  it("636 stock: three failures out of six are replaced from the same search's usable videos", async () => {
    const film = 960636;
    const h = stockHarness(new Set(["xbhq", "b0q", "tj7"]));
    const ids = ["xbhq", "mr9", "tj7", "b0q", "kUm", "liF", "c7", "c8", "c9", "c10", "c11", "c12", "c13", "c14"];
    startYoutubeShotStock(film, ids.map((videoId) => ({ videoId, title: videoId, durationSec: 300, serves: 0 })), h.deps);
    await settle(film, h.started);
    expect(stockSummary(film).ready).toBe(MAX_STOCK_VIDEOS);
    expect(h.started).toEqual(expect.arrayContaining(["c7", "c8", "c9"]));
    expect(h.started.length).toBeLessThanOrEqual(MAX_STOCK_ATTEMPTS);
    releaseYoutubeShotStock(film);
  });
});

/* ═══════════════ Option A — W6 never pushes a source out of the Judge's order ═══════════════ */

describe("option A — variety in sourcing, never at the cost of the picture", () => {
  it("the adopt loop has no W6 reorder: the content ranking alone decides what the Judge sees", () => {
    const loop = PIPE.slice(PIPE.indexOf("const finalPaths = [...lessFilled.paths];"), PIPE.indexOf("noteRanked(dedup.beatShortlist, sceneIndex, beatIndex"));
    expect(loop).not.toContain("youtubeSourceUsedRecently");
    expect(loop).not.toContain("[YouTubeVariety]");
  });

  const base = {
    looksLeft: 1, finalRound: false, currentIsYoutube: false, currentJudgedOnThisBeat: false,
    currentAlreadyGaveWay: false, youtubeJudgedOnThisBeat: false,
    isYoutube: (q: string) => q.startsWith("yt_"), eligible: () => true,
    preferred: (q: string) => !q.includes("recent"),
  };

  it("W1 gives the last look to a fresh YouTube source before a recently used one", () => {
    expect(youtubeForLastLook({ ...base, later: ["ia_1", "yt_recent", "yt_fresh"] })).toBe("yt_fresh");
  });

  it("W1 may still give it to a recently used source when no fresh YouTube candidate is eligible", () => {
    expect(youtubeForLastLook({ ...base, later: ["ia_1", "yt_recent"] })).toBe("yt_recent");
    expect(youtubeForLastLook({ ...base, later: ["yt_recent", "yt_fresh"], eligible: (q) => q !== "yt_fresh" })).toBe("yt_recent");
  });

  it("the preference never overrides a safety exclusion", () => {
    expect(youtubeForLastLook({ ...base, later: ["yt_recent"], eligible: () => false })).toBeNull();
  });

  it("W6 still orders sourcing and stock, and still keeps the exact seconds shown off the film", () => {
    expect(PIPE).toContain("shownRecently: (r) => idOf(r) != null && youtubeSourceUsedRecently(poolVideoId,");
    expect(PIPE).toContain("shownRecently: youtubeSourceUsedRecently(filmId, providerAssetKey(\"youtube_cc\", c.videoId)),");
    expect(PIPE).toContain("preferred: (q) => !youtubeSourceUsedRecently(getActiveVideoId(), clipContentKey(q)),");
    expect(PIPE.split("youtubeSecondsShownRecently(poolVideoId,").length - 1).toBeGreaterThanOrEqual(4);
  });
});
