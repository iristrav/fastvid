import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const nodeFetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: (...args: unknown[]) => nodeFetchMock(...args) }));

import { createVisualDedupState, getPipelinePerfProfile, resetYoutubeFragmentsFetched, runCentralYoutubeTurn } from "./videoPipeline";
import { formatMultiPersonOutcome, registerVideoYoutubePool, releaseVideoYoutubePool, scriptVisualNeeds, type VideoYoutubePool } from "./youtubeVideoPool";
import { releaseYoutubeShotStock, startYoutubeShotStock, stockVideoState, youtubeStockSettled, type StockDeps } from "./youtubeShotStock";
import { resetPermanentDownloadRefusals } from "./providerFailureClass";
import { runWithActiveVideoId } from "./videoGenerationCancel";

/**
 * VIDEO 643 — B (the B-1 stop rule) and C (what serves a sentence, measured).
 *
 * 643 scene 2 had no video in the pool that serves its sentences. The B-1 stop rule counted ANY
 * moment, so after the first non-serving video (4JnAH0O-vh0) it logged "serving rows gave moments —
 * non-serving rows not offered" three times and offered nothing else: below the old limit of two.
 * Driven through the real YouTube turn (`runCentralYoutubeTurn` → `fetchYouTubeCCClips`), with the
 * film's real stock and pool.
 */

const FILM = 96_643;
const ORIGINAL_ENV = { ...process.env };
const SENTENCES = [
  "But as the illusion unravels, what's next for a dynasty built on appearance?",
  "Inside a Beverly Hills mansion worth 150 million dollars.",
];
type Cand = { id: string; title: string; serves: number[] };
const cand = (c: Cand) => ({
  videoId: c.id, title: c.title, description: c.title, thumb: "", durationSec: 600,
  footageType: "real_footage" as const, serves: c.serves, from: 1 as const, usable: true, why: "ok",
});
const pool = (cands: Cand[]): VideoYoutubePool =>
  ({
    videoId: FILM,
    sentences: SENTENCES,
    query1: "Kardashians",
    query2: null,
    searches: 1,
    candidates: cands.map(cand),
    coverage1: 1, archiveUsable: 0, search2Needed: false, search2Reason: "", finalCoverage: 1, decided: true,
  }) as unknown as VideoYoutubePool;

/** Three mansion videos: they serve sentence 1, none serves sentence 0 (643's scene 2). */
const mansionA = { id: "4JnAH0O-vh0", title: "Inside Kim Kardashian's Beverly Hills Mansion", serves: [1] };
const mansionB = { id: "MansionBBBB", title: "Beverly Hills mansion tour", serves: [1] };
const mansionC = { id: "MansionCCCC", title: "Hidden Hills mansion drone", serves: [1] };
/** One video that serves sentence 0 — by the pool's judgement, not by its title (which ranks it last). */
const dynasty = { id: "DynastyDDDD", title: "Family archive reel", serves: [0] };

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
const stock = async (cands: Cand[]) => {
  startYoutubeShotStock(FILM, cands.map((c) => ({ videoId: c.id, title: c.title, durationSec: 600, serves: c.serves.length, beats: c.serves })), stockDeps());
  await youtubeStockSettled(FILM);
};
const turn = (beatIndex: number) =>
  runWithActiveVideoId(FILM, () =>
    runCentralYoutubeTurn({
      beat: { index: beatIndex, text: SENTENCES[beatIndex]!, keywords: [] },
      scene: { index: 2, text: SENTENCES.join(" ") },
      workDir,
      sceneIndex: 2,
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
const logs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.ENABLE_YOUTUBE_SOURCING = "true";
  process.env.YOUTUBE_API_KEY = "v643-test-key";
  process.env.YOUTUBE_CC_DL_SERVICE = "https://v643-cloud.example.com";
  process.env.ENABLE_SCRIPT_GUIDED_CLIPS = "false";
  resetPermanentDownloadRefusals();
  resetYoutubeFragmentsFetched();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "v643b-"));
  nodeFetchMock.mockReset();
  nodeFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
  logs.length = 0;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  releaseVideoYoutubePool(FILM);
  releaseYoutubeShotStock(FILM);
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("B — the B-1 stop rule counts only what a SERVING row gave", () => {
  it("643 scene 2: no serving row, two non-serving ready videos — the first gives moments, the second is STILL offered", async () => {
    registerVideoYoutubePool(FILM, Promise.resolve(pool([mansionA, mansionB])));
    await stock([mansionA, mansionB]);
    const result = await turn(0);
    expect(result.candidatePaths.length).toBeGreaterThan(0);
    expect([offered(mansionA.id), offered(mansionB.id)]).toEqual([true, true]);
    /** The misleading line of 643 is gone: no serving row gave anything here. */
    expect(logs.some((l) => l.includes("serving rows gave moments"))).toBe(false);
  }, 60_000);

  it("the old limit of two holds for the fallback: a third non-serving video is not offered", async () => {
    registerVideoYoutubePool(FILM, Promise.resolve(pool([mansionA, mansionB, mansionC])));
    await stock([mansionA, mansionB, mansionC]);
    await turn(0);
    expect([mansionA, mansionB, mansionC].filter((c) => offered(c.id)).length).toBe(2);
  }, 60_000);

  it("a serving row that gives moments stops the non-serving ones — and only then is the line logged", async () => {
    registerVideoYoutubePool(FILM, Promise.resolve(pool([mansionA, mansionB, dynasty])));
    await stock([mansionA, mansionB, dynasty]);
    await turn(0);
    expect(offered(dynasty.id)).toBe(true);
    expect([offered(mansionA.id), offered(mansionB.id)]).toEqual([false, false]);
    expect(logs.some((l) => l.includes("serving rows gave moments — non-serving rows not offered"))).toBe(true);
  }, 60_000);
});

describe("C — what serves a sentence, measured per sentence", () => {
  it("[BeatServing]: a sentence with no serving source says so, with what the fallback gave", async () => {
    registerVideoYoutubePool(FILM, Promise.resolve(pool([mansionA, mansionB])));
    await stock([mansionA, mansionB]);
    await turn(0);
    const line = logs.find((l) => l.startsWith("[BeatServing] Scene 2 beat 0:"));
    expect(line).toBeDefined();
    expect(line).toContain("servingSources=0 (ready=0 toDownload=0)");
    expect(line).toContain("servingVideosWithMoments=0 nonServingVideosWithMoments=2");
    expect(line).toContain("no serving source in the pool for this sentence");
  }, 60_000);

  it("[BeatServing]: a served sentence counts its serving sources, ready and to download, and what they gave", async () => {
    registerVideoYoutubePool(FILM, Promise.resolve(pool([mansionA, mansionB, dynasty])));
    await stock([mansionA, mansionB, dynasty]);
    await turn(1);
    const line = logs.find((l) => l.startsWith("[BeatServing] Scene 2 beat 1:"));
    expect(line).toContain("servingSources=2 (ready=2 toDownload=0)");
    expect(line).toContain("servingVideosWithMoments=2 nonServingVideosWithMoments=0");
    expect(offered(dynasty.id)).toBe(false);
  }, 60_000);

  it("entityBeats are 0-based indices into the pool's sentences (643: Kendall [7], Dynasty [11] of 12)", () => {
    const sentences = ["Kim Kardashian at home.", "Without Instagram followers would Kendall Jenner still matter?", "A dynasty built on appearance."];
    const needs = scriptVisualNeeds({ sentences, visualNeeds: [{ subject: "Dynasty Built On Appearance", beats: [2, 3] }] } as never, (s) =>
      /Kendall Jenner/.test(s) ? [{ name: "Kendall Jenner", kind: "name" as const }] : []
    );
    expect(needs.find((x) => x.name === "Kendall Jenner")!.beats).toEqual([1]);
    /** A planner index past the last sentence is dropped, never shifted: the last sentence of 3 is index 2. */
    expect(needs.find((x) => x.name === "Dynasty Built On Appearance")!.beats).toEqual([2]);
    const lines = formatMultiPersonOutcome(
      FILM,
      { entityTargets: [{ name: "Kendall Jenner", kind: "name", beats: [1], reason: "missing_named_subject", n: 2, query: "Kendall Jenner footage", score: 2 }], candidates: [], searches: 2 } as never,
      []
    );
    expect(lines[0]).toContain("entityBeats=[1]");
  });
});
