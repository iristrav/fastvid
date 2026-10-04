/**
 * VIDEO 628 — two general faults, each one line of routing.
 *
 *   FIX 1  a sentence that names nothing of its own ("By 1950, former allies stood on the brink of
 *          nuclear conflict.") ended its YouTube turn with YOUTUBE_NO_QUERY before the video's pool
 *          was looked at — 27 shots were cut and waiting, 7 sentences never saw one;
 *   FIX 2  a second round for the same sentence (the main-subject rescue) opened a fresh ladder in
 *          which the open sources, already asked in round one, stood on NOT_REACHED — and refused
 *          every stock search (80 TIER_OUT_OF_ORDER refusals, all ten sentences that had asked them).
 *
 * No test reaches the network: `node-fetch` and the global `fetch` answer from this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const nodeFetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: (...args: unknown[]) => nodeFetchMock(...args) }));

import {
  createVisualDedupState,
  gatherHistoricalBeatVideoPool,
  getPipelinePerfProfile,
  resetYoutubeFragmentsFetched,
  runCentralYoutubeTurn,
  youtubeFragmentKeyFor,
  youtubeQueriesOrVideoPool,
  youtubeQueryPlanForSentence,
  youtubeTurnKey,
} from "./videoPipeline";
import { registerVideoYoutubePool, releaseVideoYoutubePool, videoPoolMayOfferYoutube, type VideoYoutubePool } from "./youtubeVideoPool";
import { releaseYoutubeShotStock, startYoutubeShotStock, stockSummary, type StockDeps } from "./youtubeShotStock";
import { noteYoutubeFragmentRefusal, resetPermanentDownloadRefusals } from "./providerFailureClass";
import { runWithActiveVideoId } from "./videoGenerationCancel";
import { buildMediaSearchIntent } from "./mediaResearchEngine";
import { admitProviderForTier, forgetRenderSourcing, noteTierAttempted, runCentralVisualSourcing } from "./centralVisualSourcing";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const ORIGINAL_ENV = { ...process.env };

/** One sentence per kind of subject that names nothing of its own, with the scene around it. */
const NAMELESS: Array<{ topic: string; scene: string; sentence: string; builderQueries: string[] }> = [
  {
    topic: "WWII (render 628)",
    scene:
      "In 1945, three-quarters of the world's nations were at war. By 1950, former allies stood on the brink of nuclear conflict. " +
      "This global upheaval didn't just end with victory; it forged rivalries that haunt us still.",
    sentence: "By 1950, former allies stood on the brink of nuclear conflict.",
    builderQueries: ["Neville Chamberlain Geneva", "WWII archival footage", "How WWII Shaped the Modern World documentary footage"],
  },
  {
    topic: "Elon Musk / Tesla",
    scene: "Today Tesla sells cars on every continent. Its brand is built on one man's image. That image is now its biggest risk.",
    sentence: "That image is now its biggest risk.",
    builderQueries: ["Elon Musk Tesla", "Tesla factory footage"],
  },
  {
    topic: "sport",
    scene: "Television carried the 1970 final to millions of homes. Money followed the cameras. Clubs and players chase its glory.",
    sentence: "Money followed the cameras.",
    builderQueries: ["World Cup 1970 final", "Pele Mexico 1970"],
  },
  {
    topic: "science",
    scene: "Its first images revealed galaxies older than any seen before. Astronomers were stunned by the detail. Old theories began to crack.",
    sentence: "Old theories began to crack.",
    builderQueries: ["James Webb Space Telescope", "James Webb first images"],
  },
  {
    topic: "inflation / abstract",
    scene: "Prices at the supermarket keep rising. Families feel it every week. Savings lose their value.",
    sentence: "Savings lose their value.",
    builderQueries: ["Inflation Affects Everyday Life documentary footage", "inflation supermarket prices"],
  },
];

/* ═══════════════════════ FIX 1 — the decision ═══════════════════════ */

describe("FIX 1 — a sentence without words of its own uses the video's existing pool", () => {
  it.each(NAMELESS)("$topic: the per-sentence cut leaves nothing, so only the pool can answer", ({ scene, sentence, builderQueries }) => {
    /** The rule from video 612–614 is unchanged: nothing the sentence does not say is sent. */
    expect(youtubeQueryPlanForSentence(builderQueries, sentence, scene).queries).toEqual([]);
    const withPool = youtubeQueriesOrVideoPool([], sentence, true);
    expect(withPool.fromPool).toBe(true);
    /** The label is the sentence itself — the pool ranks its rows on that text; nothing is added. */
    expect(withPool.queries).toEqual([sentence]);
  });

  it.each(NAMELESS)("$topic: with no pool the answer stays exactly as it was (no query, no search)", ({ sentence }) => {
    expect(youtubeQueriesOrVideoPool([], sentence, false)).toEqual({ queries: [], fromPool: false });
  });

  it("a sentence that keeps queries of its own is not touched, pool or not", () => {
    expect(youtubeQueriesOrVideoPool(["Neville Chamberlain Geneva"], "In Geneva, Neville Chamberlain clung to peace.", true)).toEqual({
      queries: ["Neville Chamberlain Geneva"],
      fromPool: false,
    });
  });

  it("an empty sentence gets no label", () => {
    expect(youtubeQueriesOrVideoPool([], "   ", true)).toEqual({ queries: [], fromPool: false });
  });

  it("the pool counts while it is being built, and stops counting once it came back without YouTube", async () => {
    const id = 96_281;
    expect(videoPoolMayOfferYoutube(id)).toBe(false);
    let resolve!: (p: VideoYoutubePool) => void;
    registerVideoYoutubePool(id, new Promise<VideoYoutubePool>((r) => (resolve = r)));
    expect(videoPoolMayOfferYoutube(id)).toBe(true);
    resolve({ candidates: [] } as unknown as VideoYoutubePool);
    await new Promise((r) => setTimeout(r, 0));
    expect(videoPoolMayOfferYoutube(id)).toBe(false);
    releaseVideoYoutubePool(id);
    expect(videoPoolMayOfferYoutube(id)).toBe(false);
  });

  it("the one door applies it, between the per-sentence cut and the turn", () => {
    const body = PIPE.slice(PIPE.indexOf("export async function runCentralYoutubeTurn("), PIPE.indexOf("const turnKey = youtubeTurnKey(sceneIndex, beat.index);"));
    expect(body).toContain("youtubeQueriesOrVideoPool(plan.queries, input.beat.text, videoPoolMayOfferYoutube(getActiveVideoId()))");
    expect(body).toContain("const req: CentralYoutubeRequest = { ...input, queries: pooled.queries };");
    /** Only the queries change: the beat — and so the sentence the picture editor judges — is the input's own. */
    expect(body).not.toMatch(/beat:\s*\{/);
  });

  it("the lookahead is unchanged: it still starts only for sentences with words of their own", () => {
    expect(PIPE).toContain(
      "const queries = youtubeQueriesForSentence(buildBeatYoutubeQueries(beat, scene, videoTitle, personName), beat.text, scene.text);\n    if (queries.length === 0) continue;"
    );
  });

  it("the picture editor still judges on the beat's own sentence (6dbbd5c)", () => {
    expect(PIPE).toContain("const ownSentence = dedup.beatJudgeTextOverride?.get(`${sceneIndex}:${beatIndex}`);");
    expect(PIPE).toContain("...(ownSentence?.trim() ? { ctx: { ...params.ctx, beatText: ownSentence } } : {}),");
    /** And the pool route hands the turn's beat text — never the label — to the candidate files. */
    expect(PIPE).toContain("beatText: beat.text,\n        beatIndex: beat.index,\n        videoTitle: adoptOpts.videoTitle,");
  });
});

/* ═══════════════════════ FIX 1 — driven through the real turn, in pool mode ═══════════════════════ */

describe("FIX 1 — through the real YouTube turn: pool shots, no search, dedup kept", () => {
  const FILM = 96_282;
  const VID = "PoolVid0001";
  let workDir: string;

  const pool = (): VideoYoutubePool => ({
    videoId: FILM,
    sentences: NAMELESS.map((n) => n.sentence),
    query1: "1945 WWII",
    query2: null,
    searches: 1,
    candidates: [
      {
        videoId: VID, title: "Archive film", description: "archive film", thumb: "", durationSec: 600,
        footageType: "archival_footage" as const, serves: [0], from: 1 as const, usable: true, why: "ok",
      },
    ],
    coverage1: 1, archiveUsable: 0, search2Needed: false, search2Reason: "", finalCoverage: 1, decided: true,
  });

  /** A stock of three ready 4-second shots, as `startYoutubeShotStock` leaves them. */
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

  const turn = (beatIndex: number, sentence: string, scene: string, builderQueries: string[]) =>
    runWithActiveVideoId(FILM, () =>
      runCentralYoutubeTurn({
        beat: { index: beatIndex, text: sentence, keywords: [] },
        scene: { index: 0, text: scene },
        workDir,
        sceneIndex: 0,
        clipFetchDur: 4,
        dedup: createVisualDedupState(getPipelinePerfProfile("1")),
        visualNeed: "topic",
        queries: builderQueries,
        queryBuilder: "buildBeatYoutubeQueries",
        termSource: "test",
        adoptOpts: {},
        timeoutMs: 30_000,
        deliver: "candidates",
      } as never)
    );

  const searchCalls = () =>
    [...nodeFetchMock.mock.calls, ...((globalThis.fetch as unknown as { mock?: { calls: unknown[][] } }).mock?.calls ?? [])]
      .map(([u]) => String(u))
      .filter((u) => u.includes("youtube/v3/search"));

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.ENABLE_YOUTUBE_SOURCING = "true";
    process.env.YOUTUBE_API_KEY = "v628-test-key";
    process.env.YOUTUBE_CC_DL_SERVICE = "https://v628-cloud.example.com";
    process.env.ENABLE_SCRIPT_GUIDED_CLIPS = "false";
    resetPermanentDownloadRefusals();
    resetYoutubeFragmentsFetched();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "v628-"));
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

  it.each(NAMELESS)("$topic: with a pool, the sentence gets the pool's shots — without any search", async ({ sentence, scene, builderQueries }) => {
    registerVideoYoutubePool(FILM, Promise.resolve(pool()));
    startYoutubeShotStock(FILM, [{ videoId: VID, title: "Archive film", durationSec: 600, serves: 1 }], stockDeps());

    const result = await turn(0, sentence, scene, builderQueries);

    expect(result.outcome).not.toBe("YOUTUBE_NO_QUERY");
    expect(result.candidatePaths.length).toBeGreaterThan(0);
    expect(result.candidatePaths.every((p) => fs.existsSync(p))).toBe(true);
    expect(stockSummary(FILM).handedOut).toBeGreaterThan(0);
    expect(searchCalls()).toEqual([]);
  });

  it.each(NAMELESS)("$topic: without a pool, nothing changes — YOUTUBE_NO_QUERY, the turn stays open", async ({ sentence, scene, builderQueries }) => {
    const dedupProbe = createVisualDedupState(getPipelinePerfProfile("1"));
    const result = await runWithActiveVideoId(FILM, () =>
      runCentralYoutubeTurn({
        beat: { index: 0, text: sentence, keywords: [] },
        scene: { index: 0, text: scene },
        workDir,
        sceneIndex: 0,
        clipFetchDur: 4,
        dedup: dedupProbe,
        visualNeed: "topic",
        queries: builderQueries,
        queryBuilder: "buildBeatYoutubeQueries",
        termSource: "test",
        adoptOpts: {},
        timeoutMs: 30_000,
        deliver: "candidates",
      } as never)
    );
    expect(result.outcome).toBe("YOUTUBE_NO_QUERY");
    expect(result.candidatePaths).toEqual([]);
    /** Left open: a later branch with a usable query may still take this beat's turn. */
    expect(dedupProbe.youtubeTurnByBeat.has(youtubeTurnKey(0, 0))).toBe(false);
    expect(searchCalls()).toEqual([]);
  });

  it("dedup is kept: refused seconds are never offered again", async () => {
    registerVideoYoutubePool(FILM, Promise.resolve(pool()));
    startYoutubeShotStock(FILM, [{ videoId: VID, title: "Archive film", durationSec: 600, serves: 1 }], stockDeps());
    /** Every shot of the stock refused earlier this render (as render 628's text/black refusals were). */
    for (const start of [100, 104, 108]) noteYoutubeFragmentRefusal(youtubeFragmentKeyFor(VID, start, 4), "baked_edit_text_before_vision");

    const { sentence, scene, builderQueries } = NAMELESS[0]!;
    const result = await turn(0, sentence, scene, builderQueries);

    expect(result.candidatePaths).toEqual([]);
    expect(stockSummary(FILM).handedOut).toBe(0);
    expect(searchCalls()).toEqual([]);
  });

  it("dedup is kept: two sentences sharing the pool get the shots handed out least first", async () => {
    registerVideoYoutubePool(FILM, Promise.resolve(pool()));
    startYoutubeShotStock(FILM, [{ videoId: VID, title: "Archive film", durationSec: 600, serves: 1 }], stockDeps());

    const a = NAMELESS[0]!;
    const b = NAMELESS[2]!;
    await turn(0, a.sentence, a.scene, a.builderQueries);
    const afterFirst = stockSummary(FILM).handedOut;
    await turn(1, b.sentence, b.scene, b.builderQueries);
    /** The second sentence was offered shots too — and every shot of the stock has now been offered once. */
    expect(stockSummary(FILM).handedOut).toBeGreaterThanOrEqual(afterFirst);
    expect(stockSummary(FILM).handedOut).toBe(3);
    expect(searchCalls()).toEqual([]);
  });
});

/* ═══════════════════════ FIX 2 — the ladder in a second round ═══════════════════════ */

describe("FIX 2 — a second round for the same sentence says the open sources were already asked", () => {
  const RENDER = "v628-ladder";
  const at = { renderId: RENDER, sceneIndex: 0, beatIndex: 1 };
  const beat = { index: 1, text: "By 1950, former allies stood on the brink of nuclear conflict.", keywords: [] };
  const scene = { index: 0, text: beat.text };
  /** Built as `fetchBeatArchivalThenPexels` builds it. */
  const intent = buildMediaSearchIntent({
    beatText: beat.text,
    searchQueries: ["former allies nuclear conflict"],
    keywords: ["allies", "nuclear"],
    primaryPerson: "",
    persons: [],
    videoTitle: "How WWII Shaped the Modern World",
    powerWord: "allies",
    personTopicLock: false,
    spaceTopic: false,
  });

  let logs: string[];
  const openSourceCalls = () =>
    [...nodeFetchMock.mock.calls, ...((globalThis.fetch as unknown as { mock?: { calls: unknown[][] } }).mock?.calls ?? [])]
      .map(([u]) => String(u))
      .filter((u) => /archive\.org|wikimedia|wikipedia/.test(u));

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.SEARCH_GATE_STRICT = "false";
    forgetRenderSourcing(RENDER);
    nodeFetchMock.mockReset();
    nodeFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  const gather = (dedup: ReturnType<typeof createVisualDedupState>) =>
    gatherHistoricalBeatVideoPool(beat as never, scene as never, os.tmpdir(), 0, 4, dedup, intent, {}, "v628");

  /** Inside one beat ladder, as ArchiveFirst walks it: archive and YouTube first, the cascade, then stock. */
  const round = (dedup: ReturnType<typeof createVisualDedupState>) =>
    runCentralVisualSourcing(at, async () => {
      noteTierAttempted("OWN_ARCHIVE", "curated");
      noteTierAttempted("YOUTUBE", "youtube_first_turn");
      const pool = await gather(dedup);
      return { pool, stock: admitProviderForTier("pexels") };
    });

  it("round 1 is unchanged: the open sources are asked, and nothing says ALREADY_ASKED", async () => {
    const dedup = createVisualDedupState(getPipelinePerfProfile("1"));
    await round(dedup);
    expect(dedup.historicalCascadeAttemptedBeats.has("s0b1")).toBe(true);
    expect(openSourceCalls().length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes("ALREADY_ASKED_THIS_RENDER"))).toBe(false);
  });

  it("round 2 asks them not again, declines tier 3 as ALREADY_ASKED_THIS_RENDER, and stock is reached", async () => {
    const dedup = createVisualDedupState(getPipelinePerfProfile("1"));
    await round(dedup);
    const askedInRoundOne = openSourceCalls().length;

    const second = await round(dedup);

    expect(second.pool).toBeNull();
    expect(openSourceCalls().length).toBe(askedInRoundOne);
    expect(logs.some((l) => l.includes("TIER_DECLINED tier=3:OPEN_SOURCES reason=ALREADY_ASKED_THIS_RENDER"))).toBe(true);
    expect(second.stock).toEqual({ admitted: true });
  });

  it("without that decline the same second ladder refuses stock — the render 628 shape", async () => {
    const refused = await runCentralVisualSourcing(at, async () => {
      noteTierAttempted("OWN_ARCHIVE", "curated");
      noteTierAttempted("YOUTUBE", "youtube_first_turn");
      return admitProviderForTier("pexels");
    });
    expect(refused).toMatchObject({ admitted: false, reason: "TIER_OUT_OF_ORDER", skipped: ["OPEN_SOURCES"] });
  });

  it("the decline sits on the early return only, before any search of that round", () => {
    const fn = PIPE.slice(PIPE.indexOf("async function gatherHistoricalBeatVideoPoolInner("));
    const guard = fn.indexOf("dedup.historicalCascadeAttemptedBeats.has(cascadeKey)");
    const decline = fn.indexOf('declineTier("OPEN_SOURCES", "ALREADY_ASKED_THIS_RENDER");');
    const firstReturn = fn.indexOf("return null;", guard);
    const firstSearch = fn.indexOf("fetchTierPaths(tier, q)");
    expect(guard).toBeGreaterThan(0);
    expect(decline).toBeGreaterThan(guard);
    expect(decline).toBeLessThan(firstReturn);
    expect(firstReturn).toBeLessThan(firstSearch);
    expect(fn.split('declineTier("OPEN_SOURCES"').length - 1).toBe(1);
  });
});
