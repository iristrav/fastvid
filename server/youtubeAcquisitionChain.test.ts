/**
 * P5 — THE YOUTUBE CHAIN, END TO END, WITHOUT SPENDING QUOTA.
 *
 * Video 629 showed three separate ways good YouTube footage was lost: the planner refused every
 * query, the pool dropped every source longer than 20 minutes, and the picture clock ran out before
 * the stock was cut. These tests run the real pool, the real stock and the real wait with stand-in
 * providers that count what they are asked, so every limit is checked where it is enforced.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { planVideoQuery, type GateVerdict, type PlannerInput } from "./youtubeVideoSearchPlanner";
import {
  buildVideoYoutubePool,
  poolRowsForBeat,
  registerVideoYoutubePool,
  releaseVideoYoutubePool,
  type PoolDeps,
  type SearchItem,
  type Triage,
  type VideoYoutubePool,
} from "./youtubeVideoPool";
import { memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import { MAX_STOCK_VIDEOS, releaseYoutubeShotStock, startYoutubeShotStock, stockSummary, takeStockShots } from "./youtubeShotStock";
import {
  YOUTUBE_MIN_TURN_MS,
  YOUTUBE_POOL_TURN_MS,
  YOUTUBE_STOCK_WAIT_MAX_MS,
  canAffordYoutubeTurn,
  waitForYoutubeStockBeforePictures,
  withSceneFetchTimeout,
} from "./videoPipeline";
import { youtubeDownloadTimeoutMs, youtubeMaxDownloadsPerRender } from "./sourcingPolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const allow = (): GateVerdict => ({ ok: true });

const ww2: PlannerInput = {
  prompt: "How World War II Changed the Modern World",
  title: "Why World War II Changed Everything",
  sceneTexts: [
    "World War II began when tanks crossed into Poland in 1939. Factories switched to building tanks, aircraft and ships.",
    "In June 1944 the Allies landed in Normandy. Dwight Eisenhower led the invasion.",
    "Berlin and London lay in ruins. After World War II, Europe began to rebuild.",
  ],
};

/* ═══════════ the stand-in YouTube: 50 results, some good, some bad ═══════════ */

type Kind = { serves: number[]; type?: Triage["footageType"]; sec?: number; live?: boolean; title?: string };
function results(prefix: string, kinds: Kind[]): { items: SearchItem[]; meta: Map<string, Kind> } {
  const meta = new Map<string, Kind>();
  const items = Array.from({ length: 50 }, (_, i) => {
    const videoId = `${prefix}${String(i).padStart(10, "0")}`.slice(0, 11);
    const k = kinds[i] ?? { serves: [], type: "other" as const };
    meta.set(videoId, k);
    return { videoId, title: k.title ?? `${prefix} archive reel ${i}`, description: "", channel: `channel ${i % 7}`, thumb: "t" };
  });
  return { items, meta };
}

function chainDeps(over: Partial<PoolDeps> = {}) {
  const searches: string[] = [];
  /** Search #1: ten good reels for the first two sentences, and the bad ones a real search returns. */
  const first = results("A", [
    ...Array.from({ length: 10 }, (_, i) => ({ serves: [i % 2], type: "archival_footage" as const })),
    { serves: [0], type: "talking_head" },
    { serves: [0], type: "archival_footage", title: "WW2 in 60 seconds #shorts", sec: 50 },
    { serves: [1], type: "archival_footage", sec: 45 * 60 },
    { serves: [1], type: "archival_footage", sec: 3 * 60 * 60 },
    { serves: [1], type: "archival_footage", live: true },
  ]);
  /** Search #2: footage for the sentences search #1 left without any. */
  const second = results("B", Array.from({ length: 8 }, (_, i) => ({ serves: [2 + (i % 4)], type: "real_footage" as const })));
  const meta = new Map([...first.meta, ...second.meta]);
  let llmCall = 0;
  const deps: PoolDeps = {
    store: memoryYoutubeSearchBudgetStore(),
    llm: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify(
              ++llmCall === 1
                ? { mainSubject: "World War II", recurringSubjects: [], query: "World War II tanks" }
                : { mainSubject: "World War II", recurringSubjects: [], query: "Allies Normandy invasion Berlin ruins" }
            ),
          },
        },
      ],
    }),
    gate: allow,
    search: async (query) => {
      searches.push(query);
      return { status: 200, items: searches.length === 1 ? first.items : second.items };
    },
    details: async (ids) =>
      new Map(ids.map((id) => [id, { durationSec: meta.get(id)?.sec ?? 300, embeddable: true, live: meta.get(id)?.live ?? false }])),
    triage: async (it): Promise<Triage> => {
      const k = meta.get(it.videoId);
      return { footageType: k?.type ?? "other", servesBeats: k?.serves ?? [], depicts: "" };
    },
    archive: async () => [],
    log: () => {},
    ...over,
  };
  return { deps, searches };
}

const FILM = 990_629;
afterEach(() => {
  releaseYoutubeShotStock(FILM);
  releaseVideoYoutubePool(FILM);
});

describe("the production chain: plan → search → look → pool → stock → beats", () => {
  it("one good search, a second only for the gap, never a third — and each query is different", async () => {
    const { deps, searches } = chainDeps();
    const pool = await buildVideoYoutubePool(deps, { videoId: FILM, ...ww2 });
    expect(searches).toEqual(["World War II tanks archival footage", "Allies Normandy invasion Berlin ruins archival footage"]);
    expect(pool.searches).toBe(2);
    expect(pool.search2Reason).toContain("coverage");
    const again = await buildVideoYoutubePool(deps, { videoId: FILM, ...ww2 });
    expect(searches).toHaveLength(2);
    expect(again.searches).toBe(2);
  });

  it("the look keeps footage and refuses the rest: talking head, Short, live and a three-hour stream are out; a 45-minute reel is in", async () => {
    const { deps } = chainDeps();
    const pool = await buildVideoYoutubePool(deps, { videoId: FILM, ...ww2 });
    const byId = new Map(pool.candidates.map((c) => [c.videoId, c]));
    const a = (i: number) => byId.get(`A${String(i).padStart(10, "0")}`.slice(0, 11))!;
    for (let i = 0; i < 10; i++) expect(a(i).usable).toBe(true);
    expect(a(10).usable).toBe(false); // talking head
    expect(a(11).usable).toBe(false); // a Short
    expect(a(12).usable).toBe(true); // 45 minutes: the cloud route fetches a section, not the source
    expect(a(13).usable).toBe(false); // three hours
    expect(a(14).usable).toBe(false); // live
    expect(pool.candidates.filter((c) => c.usable)).toHaveLength(19);
  });

  it("every beat reads the whole pool, its own footage first", async () => {
    const { deps } = chainDeps();
    const pool = await buildVideoYoutubePool(deps, { videoId: FILM, ...ww2 });
    const first = poolRowsForBeat(pool, pool.sentences[0]!, []);
    const later = poolRowsForBeat(pool, pool.sentences[4]!, []);
    expect(first).toHaveLength(19);
    expect(later).toHaveLength(19);
    const servesFirst = (id: string | undefined) => pool.candidates.find((c) => c.videoId === id)!.serves.includes(0);
    const servesLater = (id: string | undefined) => pool.candidates.find((c) => c.videoId === id)!.serves.includes(4);
    expect(servesFirst(first[0]!.item.id?.videoId)).toBe(true);
    expect(servesLater(later[0]!.item.id?.videoId)).toBe(true);
  });

  it("the stock: six videos at most, cut into shots; a source gives different beats different shots; a refused shot never returns", async () => {
    const { deps } = chainDeps();
    const pool = await buildVideoYoutubePool(deps, { videoId: FILM, ...ww2 });
    registerVideoYoutubePool(FILM, Promise.resolve(pool));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytchain-"));
    const downloads: string[] = [];
    startYoutubeShotStock(
      FILM,
      pool.candidates.filter((c) => c.usable).map((c) => ({ videoId: c.videoId, title: c.title, durationSec: c.durationSec, serves: c.serves.length })),
      {
        workDir: dir,
        startFor: () => 30,
        download: async (id, _s, _d, out) => {
          downloads.push(id);
          fs.writeFileSync(out, "x");
          return true;
        },
        cut: async (_f, d) => [0, 8, 16].map((t) => ({ path: path.join(d, `shot_${t}.mp4`), startSec: t, endSec: t + 6 })),
        log: () => {},
      }
    );
    const waited = await waitForYoutubeStockBeforePictures(FILM, { log: () => {} });
    expect(waited.outcome).toBe("stock_settled");
    expect(downloads).toHaveLength(MAX_STOCK_VIDEOS);
    expect(stockSummary(FILM)).toMatchObject({ videos: 6, ready: 6, shots: 18 });

    const source = downloads[0]!;
    const beatA = await takeStockShots(FILM, source, 0);
    const beatB = await takeStockShots(FILM, source, 0);
    expect(beatA.shots[0]!.sourceStartSec).not.toBe(beatB.shots[0]!.sourceStartSec);
    const refusedStart = beatA.shots[0]!.sourceStartSec;
    for (let i = 0; i < 5; i++) {
      const took = await takeStockShots(FILM, source, 0, (s) => s.sourceStartSec === refusedStart);
      expect(took.shots[0]?.sourceStartSec).not.toBe(refusedStart);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a budget the database refuses is refused: the planner may plan, YouTube is not searched", async () => {
    const { deps, searches } = chainDeps();
    deps.store.claim = async () => false;
    await buildVideoYoutubePool(deps, { videoId: FILM, ...ww2 });
    expect(searches).toEqual([]);
  });

  it("the planner never asks twice for the same video: a planned query is one query", async () => {
    const plan = await planVideoQuery(chainDeps().deps, ww2);
    expect(plan!.query).toBe("World War II tanks archival footage");
  });
});

/* ═══════════ time: the stock before the picture clock, and never unbounded ═══════════ */

const pending = <T,>() => new Promise<T>(() => {});
function poolWith(usable: boolean): VideoYoutubePool {
  return {
    videoId: FILM, sentences: ["s"], query1: "q", query2: null, searches: 1, coverage1: 1, archiveUsable: 0,
    search2Needed: false, search2Reason: "", finalCoverage: 1, decided: true,
    candidates: usable
      ? [{ videoId: "AAAAAAAAAAA", title: "t", description: "", thumb: "t", durationSec: 300, footageType: "archival_footage", serves: [0], from: 1, usable: true, reason: "ok" } as never]
      : [],
  };
}

describe("T1 — YouTube gets its time, and a hang cannot hold the render", () => {
  it("no pool: no wait at all", async () => {
    expect(await waitForYoutubeStockBeforePictures(FILM, { log: () => {} })).toEqual({ waitedMs: 0, outcome: "no_pool" });
  });

  it("a pool that brought no YouTube: pictures start at once", async () => {
    registerVideoYoutubePool(FILM, Promise.resolve(poolWith(false)));
    const r = await waitForYoutubeStockBeforePictures(FILM, { log: () => {} });
    expect(r.outcome).toBe("no_youtube");
    expect(r.waitedMs).toBeLessThan(1_000);
  });

  it("a pool that never answers: the wait ends at its limit, looking up every step", async () => {
    registerVideoYoutubePool(FILM, pending());
    let ticks = 0;
    const r = await waitForYoutubeStockBeforePictures(FILM, { maxWaitMs: 200, stepMs: 20, tick: () => ticks++, log: () => {} });
    expect(r.outcome).toBe("pool_not_ready");
    expect(r.waitedMs).toBeGreaterThanOrEqual(190);
    expect(r.waitedMs).toBeLessThan(1_500);
    expect(ticks).toBeGreaterThanOrEqual(5);
  });

  it("a stock download that hangs: the wait ends at its limit; the download keeps its own timeout", async () => {
    registerVideoYoutubePool(FILM, Promise.resolve(poolWith(true)));
    startYoutubeShotStock(FILM, [{ videoId: "AAAAAAAAAAA", title: "t", durationSec: 300, serves: 1 }], {
      workDir: os.tmpdir(), startFor: () => 0, download: () => pending(), cut: async () => [], log: () => {},
    });
    const r = await waitForYoutubeStockBeforePictures(FILM, { maxWaitMs: 150, stepMs: 25, log: () => {} });
    expect(r.outcome).toBe("stock_not_ready");
    expect(r.waitedMs).toBeLessThan(1_500);
  });

  it("a cancelled render stops the wait at the next step", async () => {
    registerVideoYoutubePool(FILM, pending());
    await expect(
      waitForYoutubeStockBeforePictures(FILM, { maxWaitMs: 10_000, stepMs: 20, tick: () => { throw new Error("cancelled"); }, log: () => {} })
    ).rejects.toThrow("cancelled");
  });

  it("the limit is three minutes, and the picture clock starts only after the wait", () => {
    expect(YOUTUBE_STOCK_WAIT_MAX_MS).toBe(180_000);
    const wait = PIPE.indexOf("await waitForYoutubeStockBeforePictures(videoId, {");
    const clock = PIPE.indexOf("visualDedup.pipelineStartedMs = Date.now();");
    const deadline = PIPE.indexOf("const visualDeadlineMs = visualDeadlineForVideoMs(");
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(clock);
    expect(clock).toBeLessThan(deadline);
    expect(PIPE.slice(wait, clock)).toContain("throwIfActiveRenderCancelled();");
  });
});

describe("the door: a beat that reads the pool pays the download floor, not a search", () => {
  const door = (windowMs: number) =>
    withSceneFetchTimeout(async () => canAffordYoutubeTurn(YOUTUBE_POOL_TURN_MS), windowMs, "test beat");

  it("15 s left and a ready stock shot: the beat may take it", async () => {
    expect(YOUTUBE_POOL_TURN_MS).toBe(12_000);
    expect(await door(15_000)).toBe(true);
  });

  it("10 s left: below the download floor, the door stays shut", async () => {
    expect(await door(10_000)).toBe(false);
  });

  it("the walls and reserves keep the full turn price; only the door's charge changed", () => {
    expect(YOUTUBE_MIN_TURN_MS).toBe(24_000);
    expect(PIPE).toContain("if (!canAffordYoutubeTurn(YOUTUBE_POOL_TURN_MS)) {");
  });
});

describe("the protections stay", () => {
  it("download ceilings, timeouts and counts are unchanged", () => {
    expect(youtubeDownloadTimeoutMs()).toBe(180_000);
    expect(youtubeMaxDownloadsPerRender()).toBe(60);
    expect(MAX_STOCK_VIDEOS).toBe(6);
    const service = fs.readFileSync(path.join(__dirname, "..", "services", "ytdlp-download", "main.py"), "utf8");
    expect(service).toContain('"socket_timeout": 30');
    expect(service).toContain('"-rw_timeout"');
    expect(service).toContain('"download_ranges"');
  });

  it("the watchdog, the 429 cooldown and per-beat search are as they were", () => {
    const watchdog = fs.readFileSync(path.join(__dirname, "renderWatchdog.ts"), "utf8");
    expect(watchdog).toContain("killAll(`no activity for");
    const production = fs.readFileSync(path.join(__dirname, "youtubeVideoPoolProduction.ts"), "utf8");
    expect(production).toContain("if (resp.status === 429) pipeline.markYoutubeRateLimited();");
    expect(production).toContain('url.searchParams.set("maxResults", "50");');
    expect(PIPE).toContain("const items = poolRows;");
  });
});
