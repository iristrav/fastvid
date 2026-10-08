import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const nodeFetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: (...args: unknown[]) => nodeFetchMock(...args) }));

import { createVisualDedupState, getPipelinePerfProfile, resetYoutubeFragmentsFetched, runCentralYoutubeTurn } from "./videoPipeline";
import { registerVideoYoutubePool, releaseVideoYoutubePool, type VideoYoutubePool } from "./youtubeVideoPool";
import { beatRowsInStockOrder, releaseYoutubeShotStock, startYoutubeShotStock, stockVideoState, youtubeStockSettled, type StockDeps } from "./youtubeShotStock";
import { resetPermanentDownloadRefusals } from "./providerFailureClass";
import { runWithActiveVideoId } from "./videoGenerationCancel";

/**
 * VIDEO 642 (B-1) — A SENTENCE IS OFFERED WHAT SERVES IT BEFORE WHAT IS MERELY READY.
 *
 * 642 offered two Houston drone videos (ready in the stock) to nearly every sentence, Beyoncé on
 * stage included: they took the sentence's two places and its picture editor's looks, and the
 * downloads that served the sentence were never reached. Driven here through the real YouTube turn
 * (`runCentralYoutubeTurn` → `fetchYouTubeCCClips`), with the film's real stock and pool.
 */

const FILM = 96_421;
const ORIGINAL_ENV = { ...process.env };
const SENTENCES = [
  "Beyoncé performs on stage in front of a huge crowd.",
  "The Houston skyline glows at night over the freeway.",
];
/** Two Houston drone videos: they serve sentence 1, not sentence 0. */
const HOUSTON_A = "HoustonAAAA";
const HOUSTON_B = "HoustonBBBB";
/** Two Beyoncé videos: they serve sentence 0. */
const CONCERT_C = "ConcertCCCC";
const STAGE_D = "StageDDDDDD";

type Cand = { id: string; title: string; serves: number[] };
const cand = (c: Cand) => ({
  videoId: c.id, title: c.title, description: c.title, thumb: "", durationSec: 600,
  footageType: "real_footage" as const, serves: c.serves, from: 1 as const, usable: true, why: "ok",
});
const pool = (cands: Cand[]): VideoYoutubePool =>
  ({
    videoId: FILM,
    sentences: SENTENCES,
    query1: "Beyoncé",
    query2: null,
    searches: 1,
    candidates: cands.map(cand),
    coverage1: 2, archiveUsable: 0, search2Needed: false, search2Reason: "", finalCoverage: 2, decided: true,
  }) as unknown as VideoYoutubePool;

const houstonA = { id: HOUSTON_A, title: "Houston drone footage 4K", serves: [1] };
const houstonB = { id: HOUSTON_B, title: "Houston downtown drone", serves: [1] };
const concertC = { id: CONCERT_C, title: "Beyonce concert live", serves: [0] };
const stageD = { id: STAGE_D, title: "Beyonce stage footage", serves: [0] };

let workDir: string;
const stockDeps = (): StockDeps => ({
  workDir,
  startFor: () => 100,
  download: async (_id, _s, _d, outPath) => {
    fs.writeFileSync(outPath, "section");
    return true;
  },
  cut: async (_f, pieceDir) =>
    [0, 1, 2].map((i) => {
      const p = path.join(pieceDir, `shot_${i + 1}.mp4`);
      fs.writeFileSync(p, `shot ${i}`);
      return { path: p, startSec: i * 4, endSec: i * 4 + 4 };
    }),
  log: () => {},
});
/** The film's stock: these videos are downloaded and cut, ready before the sentence's turn. */
const stock = async (cands: Cand[]) => {
  startYoutubeShotStock(FILM, cands.map((c) => ({ videoId: c.id, title: c.title, durationSec: 600, serves: c.serves.length, beats: c.serves })), stockDeps());
  await youtubeStockSettled(FILM);
};
const turn = (beatIndex: number) =>
  runWithActiveVideoId(FILM, () =>
    runCentralYoutubeTurn({
      beat: { index: beatIndex, text: SENTENCES[beatIndex]!, keywords: [] },
      scene: { index: 0, text: SENTENCES.join(" ") },
      workDir,
      sceneIndex: 0,
      clipFetchDur: 4,
      dedup: createVisualDedupState(getPipelinePerfProfile("1")),
      visualNeed: "topic",
      queries: [],
      queryBuilder: "buildBeatYoutubeQueries",
      termSource: "test",
      adoptOpts: {},
      timeoutMs: 30_000,
      deliver: "candidates",
    } as never)
  );
const offered = (id: string) => stockVideoState(FILM, id)?.offered ?? false;
/** Every outgoing request this test saw, as text — a download names its video. */
const requestsNaming = (id: string) =>
  [...nodeFetchMock.mock.calls, ...((globalThis.fetch as unknown as { mock?: { calls: unknown[][] } }).mock?.calls ?? [])].filter((c) =>
    JSON.stringify(c).includes(id)
  ).length;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.ENABLE_YOUTUBE_SOURCING = "true";
  process.env.YOUTUBE_API_KEY = "v642-test-key";
  process.env.YOUTUBE_CC_DL_SERVICE = "https://v642-cloud.example.com";
  process.env.ENABLE_SCRIPT_GUIDED_CLIPS = "false";
  resetPermanentDownloadRefusals();
  resetYoutubeFragmentsFetched();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "v642b1-"));
  nodeFetchMock.mockReset();
  nodeFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  releaseVideoYoutubePool(FILM);
  releaseYoutubeShotStock(FILM);
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("B-1 — the order a sentence's rows are tried in", () => {
  type Row = { id: string; ready?: boolean; serves?: boolean; shown?: boolean };
  const order = (rows: Row[]) => {
    const o = beatRowsInStockOrder(rows, { ready: (r) => Boolean(r.ready), serves: (r) => Boolean(r.serves), shownRecently: (r) => Boolean(r.shown) });
    return [...o.first, ...o.rest].map((r) => r.id);
  };

  it("relevant ready stock, then relevant downloads, then what does not serve; W6 unchanged: shown recently last (relevant first among them)", () => {
    expect(
      order([
        { id: "A", ready: true },
        { id: "B", ready: true },
        { id: "dl", serves: true },
        { id: "C", ready: true, serves: true },
        { id: "seen", serves: true, shown: true },
        { id: "other" },
        { id: "otherSeen", shown: true },
      ])
    ).toEqual(["C", "dl", "A", "B", "other", "seen", "otherSeen"]);
  });

  it("no relevant row: ready stock still goes before downloads (VIDEO 636 unchanged)", () => {
    expect(order([{ id: "dl1" }, { id: "A", ready: true }, { id: "dl2" }])).toEqual(["A", "dl1", "dl2"]);
  });
});

describe("B-1 — through the real YouTube turn", () => {
  it("TEST 1 — 642's shape: two irrelevant ready videos, one relevant ready and one relevant to download — the relevant come first, the irrelevant are not offered", async () => {
    registerVideoYoutubePool(FILM, Promise.resolve(pool([houstonA, houstonB, concertC, stageD])));
    /** D serves the sentence but is not stocked; before B-1, A took the second place and D was never asked */
    await stock([houstonA, houstonB, concertC]);
    const result = await turn(0);
    expect(result.candidatePaths.length).toBeGreaterThan(0);
    expect(offered(CONCERT_C)).toBe(true);
    expect(requestsNaming(STAGE_D), "the relevant download was asked for").toBeGreaterThan(0);
    expect([offered(HOUSTON_A), offered(HOUSTON_B)]).toEqual([false, false]);
  }, 60_000);

  it("TEST 1b — two irrelevant and two relevant ready videos: the relevant are offered, the irrelevant are not", async () => {
    registerVideoYoutubePool(FILM, Promise.resolve(pool([houstonA, houstonB, concertC, stageD])));
    await stock([houstonA, houstonB, concertC, stageD]);
    const result = await turn(0);
    expect(result.candidatePaths.length).toBeGreaterThan(0);
    expect([offered(CONCERT_C), offered(STAGE_D)]).toEqual([true, true]);
    expect([offered(HOUSTON_A), offered(HOUSTON_B)]).toEqual([false, false]);
  }, 60_000);

  it("TEST 2 — a relevant download is tried before irrelevant ready stock; it is not crowded out", async () => {
    /** C serves the sentence but is not in the stock: it must be downloaded. A and B are ready, irrelevant. */
    registerVideoYoutubePool(FILM, Promise.resolve(pool([houstonA, houstonB, concertC])));
    await stock([houstonA, houstonB]);
    await turn(0);
    expect(requestsNaming(CONCERT_C), "the relevant download was asked for").toBeGreaterThan(0);
    /** the download service answers 404 here: the relevant row gave nothing, so ready stock may follow */
    expect(offered(HOUSTON_A) || offered(HOUSTON_B)).toBe(true);
  }, 60_000);

  it("TEST 3 — a sentence nothing in the pool serves still gets the ready stock (no empty sentence because serves is empty)", async () => {
    registerVideoYoutubePool(FILM, Promise.resolve(pool([houstonA, houstonB])));
    await stock([houstonA, houstonB]);
    const result = await turn(0);
    expect(result.candidatePaths.length).toBeGreaterThan(0);
    expect(offered(HOUSTON_A) || offered(HOUSTON_B)).toBe(true);
  }, 60_000);

  it("the sentence the Houston videos DO serve gets them first", async () => {
    registerVideoYoutubePool(FILM, Promise.resolve(pool([concertC, stageD, houstonA, houstonB])));
    await stock([concertC, stageD, houstonA, houstonB]);
    await turn(1);
    expect([offered(HOUSTON_A), offered(HOUSTON_B)]).toEqual([true, true]);
    expect([offered(CONCERT_C), offered(STAGE_D)]).toEqual([false, false]);
  }, 60_000);
});
