import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  YOUTUBE_REFUSALS_BEFORE_WRITE_OFF_THIS_RENDER,
  isDurableYoutubeServiceRefusal,
  noteRepeatedYoutubeRefusal,
  noteYoutubeDownloadRefusal,
  resetPermanentDownloadRefusals,
  youtubeDownloadRefusal,
} from "./providerFailureClass";
import {
  YOUTUBE_UNUSABLE_AFTER_REFUSALS,
  loadUnusableYoutubeVideos,
  recordYoutubeVideoOutcome,
  setUnusableVideoStoreForTests,
  videoRefusalOf,
  withoutUnusableYoutubeVideos,
  type UnusableVideoStore,
} from "./youtubeUnusableVideos";
import {
  MAX_STOCK_ATTEMPTS,
  MAX_STOCK_VIDEOS,
  STOCK_CONCURRENCY,
  releaseYoutubeShotStock,
  startYoutubeShotStock,
  stockVideoState,
  takeStockShots,
  youtubeStockSettled,
  type StockDeps,
} from "./youtubeShotStock";
import { poolRowsForBeat, type VideoYoutubePool } from "./youtubeVideoPool";
import { MAX_YOUTUBE_SEARCHES_PER_VIDEO } from "./youtubeSearchBudget";
import { maxBeatImageJudgementsPerRender } from "./beatImageRelevanceGate";
import { maxRelevanceLooksPerBeat } from "./beatVisualRelevance";

/**
 * VIDEO 643 — DOWNLOADABLE YOUTUBE, AND ONE POOL FOR EVERY SENTENCE.
 *
 * What 643's logs show and what these tests hold:
 *   - a video that cannot be fetched is known before a slot is spent on it, by the reasons that are
 *     about the video (`bot_check`, private, unavailable …), and only those;
 *   - a refusal that can lift is not a write-off: NDl1ztoOseI was refused twice during the render
 *     ("The page needs to be reloaded", then `stream_refused`) and delivered at 20:29:42;
 *   - a MISMATCH is about one fragment and one sentence; one video's shots serve several sentences
 *     (4JnAH0O-vh0: three moments, eight sentences);
 *   - search #2 for "Kendall Jenner" found six downloadable moments and the film's last stage handed
 *     them to s0b0 — her sentence is s1b2. The targeted answers now rank first for the sentence the
 *     search was made for.
 */

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-643dl-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  resetPermanentDownloadRefusals();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setUnusableVideoStoreForTests(null);
  vi.restoreAllMocks();
});

/** A store in memory, counting the way the database does (`refusalStatements`, `deliveryStatement`). */
function memoryStore(writtenOff: Array<{ videoId: string; lastReason: string }> = []) {
  const counts = new Map<string, number>();
  const store: UnusableVideoStore = {
    async noteRefusal(videoId, _channel, _reason, limit) {
      const n = (counts.get(videoId) ?? 0) + 1;
      counts.set(videoId, n);
      return { refusals: n, unusable: n >= limit };
    },
    async noteDelivered(videoId) {
      counts.set(videoId, 0);
    },
    async loadUnusable() {
      return writtenOff;
    },
    async loadChannels() {
      return [];
    },
  };
  return { store, counts };
}

let stockFilm = 64_300;
const stockDeps = (download: (id: string) => boolean, calls: string[]): StockDeps => ({
  workDir: dir,
  startFor: () => 100,
  download: async (id, _s, _d, outPath) => {
    calls.push(id);
    if (!download(id)) return false;
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
const cand = (videoId: string, beats: number[] = []) => ({ videoId, title: videoId, durationSec: 600, serves: beats.length, beats });

/* ═══════════════════════ G1 — a technically unusable result is refused before a slot is spent ═══════════════════════ */

describe("G1 — known-unusable results are taken out before a download is asked for", () => {
  it("a video written off across renders is taken out of the rows before they are ranked", async () => {
    setUnusableVideoStoreForTests(memoryStore([{ videoId: "deadVideo01", lastReason: "http_502:stream_refused" }]).store);
    await loadUnusableYoutubeVideos();
    const rows = [{ id: "okVideo0001" }, { id: "deadVideo01" }, { id: "okVideo0002" }];
    expect(withoutUnusableYoutubeVideos(rows, (r) => r.id).map((r) => r.id)).toEqual(["okVideo0001", "okVideo0002"]);
  });

  it("a video refused this render for a reason about the video (bot check) is not stocked again", () => {
    expect(noteYoutubeDownloadRefusal("6C0orv4gc8E", "DOWNLOAD_FAILED", "http_502:bot_check")).toBe(true);
    expect(youtubeDownloadRefusal("6C0orv4gc8E")).toContain("bot_check");
    /** The stock is built from the pool minus exactly these two memories (render and cross-render). */
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const at = PIPE.indexOf("function stockYoutubePool(");
    expect(PIPE.slice(at, at + 400)).toContain("pool.candidates.filter((c) => c.usable && c.from !== 0 && !youtubeDownloadRefusal(c.videoId)),");
    expect(PIPE.slice(at, at + 400)).toContain("withoutUnusableYoutubeVideos(");
  });

  it("a video with no readable video stream (643: 9-NoVSTI0ck, NO_VIDEO_STREAM) is written off for the render", () => {
    expect(noteYoutubeDownloadRefusal("9-NoVSTI0ck", "DOWNLOAD_INVALID_CONTENT", "NO_VIDEO_STREAM:ffprobe found no readable video stream")).toBe(true);
    expect(youtubeDownloadRefusal("9-NoVSTI0ck")).not.toBeNull();
  });
});

/* ═══════════════════════ G2 — a video that fails only at download is recorded ═══════════════════════ */

describe("G2 — a download that fails is recorded where the render and the next renders read it", () => {
  it("the stock marks it failed and no sentence is offered its shots", async () => {
    const film = stockFilm++;
    const calls: string[] = [];
    startYoutubeShotStock(film, [cand("failsVideo1"), cand("worksVideo1")], stockDeps((id) => id !== "failsVideo1", calls));
    await youtubeStockSettled(film);
    expect(stockVideoState(film, "failsVideo1")).toEqual({ status: "failed", offered: false });
    expect(await takeStockShots(film, "failsVideo1", 0)).toEqual({ shots: [], reason: "download_failed" });
    expect(stockVideoState(film, "worksVideo1")?.status).toBe("ready");
    releaseYoutubeShotStock(film);
  });

  it("a refusal about the video is counted across renders; a bot check (about the address) is not", async () => {
    const { store, counts } = memoryStore();
    setUnusableVideoStoreForTests(store);
    await recordYoutubeVideoOutcome("3u6bOBAOGfM", false, [{ route: "cloud", status: "DOWNLOAD_FAILED", detail: "http_502:stream_refused" }]);
    await recordYoutubeVideoOutcome("6C0orv4gc8E", false, [{ route: "cloud", status: "DOWNLOAD_FAILED", detail: "http_502:bot_check" }]);
    expect(counts.get("3u6bOBAOGfM")).toBe(1);
    expect(counts.has("6C0orv4gc8E")).toBe(false);
  });
});

/* ═══════════════════════ G3 — temporary is not permanent ═══════════════════════ */

describe("G3 — a refusal that can lift is never a write-off", () => {
  it("timeout, rate limit and 'the page needs to be reloaded' are not remembered; bot check, private, no format are", () => {
    expect(noteYoutubeDownloadRefusal("QFuOSm2sj08", "DOWNLOAD_TIMEOUT", "Timeout: YouTube CC cloud download exceeded 150s")).toBe(false);
    expect(noteYoutubeDownloadRefusal("NDl1ztoOseI", "DOWNLOAD_FAILED", "http_502:other:{\"detail\":\"ERROR: [youtube] NDl1ztoOseI: The page needs to b")).toBe(false);
    expect(isDurableYoutubeServiceRefusal("http_429:rate_limited")).toBe(false);
    expect(youtubeDownloadRefusal("QFuOSm2sj08")).toBeNull();
    expect(youtubeDownloadRefusal("NDl1ztoOseI")).toBeNull();
    for (const cls of ["bot_check", "private", "members_only", "unavailable", "geo_blocked", "no_format"]) {
      expect(isDurableYoutubeServiceRefusal(`http_502:${cls}`), cls).toBe(true);
    }
  });

  it("one stream refusal is the moment; the second in the same render is the video (643's NDl1ztoOseI got one, later delivered)", () => {
    expect(YOUTUBE_REFUSALS_BEFORE_WRITE_OFF_THIS_RENDER).toBe(2);
    expect(noteRepeatedYoutubeRefusal("NDl1ztoOseI", "http_502:stream_refused")).toBe(false);
    expect(youtubeDownloadRefusal("NDl1ztoOseI")).toBeNull();
    expect(noteRepeatedYoutubeRefusal("NDl1ztoOseI", "http_502:stream_refused")).toBe(true);
    expect(youtubeDownloadRefusal("NDl1ztoOseI")).not.toBeNull();
  });

  it("across renders: a delivery wipes the refusals — a video that worked again is not written off", async () => {
    const { store, counts } = memoryStore();
    setUnusableVideoStoreForTests(store);
    const refused = [{ route: "cloud", status: "DOWNLOAD_FAILED", detail: "http_502:stream_refused" }];
    await recordYoutubeVideoOutcome("NDl1ztoOseI", false, refused);
    await recordYoutubeVideoOutcome("NDl1ztoOseI", false, refused);
    await recordYoutubeVideoOutcome("NDl1ztoOseI", true, []);
    expect(counts.get("NDl1ztoOseI")).toBe(0);
    expect(videoRefusalOf(true, refused)).toBeNull();
    expect(YOUTUBE_UNUSABLE_AFTER_REFUSALS).toBe(3);
  });
});

/* ═══════════════════════ G4 — a MISMATCH holds for one fragment and one sentence ═══════════════════════ */

describe("G4 — MISMATCH for sentence A is not a refusal for sentence B", () => {
  type VP = typeof import("./videoPipeline");
  type BVRM = typeof import("./beatVisualRelevance");
  let vp: VP;
  let bvr: BVRM;
  beforeAll(async () => {
    vp = await import("./videoPipeline");
    bvr = await import("./beatVisualRelevance");
  }, 60_000);

  it("the refusals that hold for every sentence are about the file, never about what it shows for one sentence", () => {
    for (const technical of ["not_a_valid_video", "mostly_black", "below_size_floor", "baked_edit_text_before_vision", "invalid_duration_before_review"]) {
      expect(vp.refusalHoldsForEverySentence(technical), technical).toBe(true);
    }
    for (const semantic of ["beat_image_gate", "hard_mismatch", "entity_evidence", "does_not_fit"]) {
      expect(vp.refusalHoldsForEverySentence(semantic), semantic).toBe(false);
    }
  });

  it("a moment refused for s1b0 is still a fresh moment for s1b1 — looked at, and its FIT taken", async () => {
    const d = {
      lateYoutubeCandidates: [] as string[],
      beatRelevance: bvr.createBeatRelevanceLedger(),
      beatImageGate: { judgementAttempts: 0 },
      visionReviewPool: { beats: new Map() },
      usedContentKeys: new Set<string>(),
    };
    const m = path.join(dir, "scene_1_ytfu_0m0_t3778d30__pid_youtube_cc-d72b145386fde4d1.mp4");
    fs.writeFileSync(m, "moment");
    d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(1, 0, "content", vp.clipContentKey(m)), {
      decision: { verdict: "does_not_fit", evaluated: true, reason: "hard_mismatch" },
    } as never);
    expect(bvr.beatAlreadyRefusedPicture(d.beatRelevance, 1, 0, { contentKey: vp.clipContentKey(m) })).not.toBeNull();
    expect(bvr.beatAlreadyRefusedPicture(d.beatRelevance, 1, 1, { contentKey: vp.clipContentKey(m) })).toBeNull();
    vp.noteLookaheadCandidateReady(d, vp.youtubeTurnKey(1, 1), m);
    vp.takeReadyLookaheadCandidates(d, vp.youtubeTurnKey(1, 1));
    const look = vi.fn(async (paths: string[]) => {
      vp.noteApprovedPickForBeat(d, 1, 1, vp.clipContentKey(paths[0]!));
      return paths[0] ?? null;
    });
    expect(await vp.finalReadyYoutubeLook(d as never, 1, 1, look, async () => 4)).toBe(m);
    expect(look.mock.calls[0]![0]).toEqual([m]);
  });
});

/* ═══════════════════════ G5 — one video, several sentences; G6 — one download per video ═══════════════════════ */

describe("G5 — one video's shots serve several sentences", () => {
  it("the same stock video hands shots to sentence A and to sentence B (643: 4JnAH0O-vh0 → eight sentences)", async () => {
    const film = stockFilm++;
    startYoutubeShotStock(film, [cand("4JnAH0O-vh0", [1])], stockDeps(() => true, []));
    await youtubeStockSettled(film);
    const forA = await takeStockShots(film, "4JnAH0O-vh0", 0, () => false, 3);
    const forB = await takeStockShots(film, "4JnAH0O-vh0", 0, () => false, 3);
    expect(forA.shots.length).toBe(3);
    expect(forB.shots.length).toBe(3);
    releaseYoutubeShotStock(film);
  });
});

describe("G5 — a targeted search's answers rank first for the sentence it was made for (VIDEO 643 fix)", () => {
  const SENTENCES = [
    "The Kardashians built an empire on reality television.",
    "Kim Kardashian lives in a mansion in Hidden Hills.",
    "Without Instagram followers would Kendall Jenner still matter?",
  ];
  const c = (videoId: string, from: number, serves: number[], title = videoId) => ({
    videoId, title, description: title, thumb: "", durationSec: 600, footageType: "real_footage", serves, from, usable: true, why: "ok",
  });
  const pool = {
    videoId: 643,
    sentences: SENTENCES,
    query1: "Kardashians",
    query2: "Kendall Jenner footage",
    searches: 2,
    candidates: [
      c("4JnAH0O-vh0", 1, [1], "Inside Kim Kardashian's Beverly Hills Mansion"),
      c("HhM0BYCHL00", 1, [0], "Kylie Jenner: A Day in the Life"),
      c("JMGxhEWJahI", 2, [], "Kendall Jenner: In The Bag | Vogue"),
      c("_s1tMR4KT8U", 2, [], "Kendall Jenner Calls Tom Brady"),
    ],
    entityTargets: [{ name: "Kendall Jenner", kind: "name", beats: [2], reason: "missing_named_subject", n: 2, query: "Kendall Jenner footage", score: 2 }],
    coverage1: 2, archiveUsable: 0, search2Needed: false, search2Reason: "", finalCoverage: 2, decided: true,
  } as unknown as VideoYoutubePool;

  it("Kendall's sentence: her targeted videos are serving rows and come first", () => {
    const rows = poolRowsForBeat(pool, SENTENCES[2]!, []);
    expect(rows.filter((r) => r.servesBeat).map((r) => r.item.id.videoId).sort()).toEqual(["JMGxhEWJahI", "_s1tMR4KT8U"]);
    expect(rows.slice(0, 2).every((r) => r.servesBeat)).toBe(true);
  });

  it("any other sentence: the targeted videos are not serving there (ranking only — the look's own assignment is unchanged)", () => {
    const rows = poolRowsForBeat(pool, SENTENCES[1]!, []);
    expect(rows.filter((r) => r.servesBeat).map((r) => r.item.id.videoId)).toEqual(["4JnAH0O-vh0"]);
    expect(pool.candidates.find((x) => x.videoId === "JMGxhEWJahI")!.serves).toEqual([]);
  });

  it("643 replayed: the late Kendall stock goes to HER sentence still without a picture, not to the first one (s0b0)", async () => {
    const vp = await import("./videoPipeline");
    const withoutPicture = [
      { sceneIndex: 0, beatIndex: 0, text: SENTENCES[0]! },
      { sceneIndex: 1, beatIndex: 2, text: SENTENCES[2]! },
    ];
    const serves = (id: string, s: (typeof withoutPicture)[number]) =>
      poolRowsForBeat(pool, s.text, []).some((r) => r.item.id.videoId === id && r.servesBeat === true);
    const assigned = vp.assignLateStockVideos(["_s1tMR4KT8U", "JMGxhEWJahI"], withoutPicture, serves);
    expect([...assigned.entries()]).toEqual([[vp.youtubeTurnKey(1, 2), ["_s1tMR4KT8U", "JMGxhEWJahI"]]]);
  });
});

describe("G6 — the same video id is downloaded once", () => {
  it("found three times (twice in search #1, once in the archive's YouTube rows): one candidate in the pool, so one stock download", async () => {
    const { buildVideoYoutubePool } = await import("./youtubeVideoPool");
    const { memoryYoutubeSearchBudgetStore } = await import("./youtubeSearchBudget");
    const item = (videoId: string, title: string) => ({ videoId, title, description: "", channel: "c", thumb: "t" });
    const pool = await buildVideoYoutubePool(
      {
        store: memoryYoutubeSearchBudgetStore(),
        llm: async () => ({ choices: [{ message: { content: JSON.stringify({ mainSubject: "Kim Kardashian", recurringSubjects: [], query: "Kim Kardashian" }) } }] }),
        gate: (q: string) => ({ ok: true, sentAs: q }),
        /** The same video twice in one answer (two result pages) — and once more from the archive's YouTube rows. */
        search: async () => ({
          status: 200,
          items: [item("dupVideo001", "Kim Kardashian at home"), item("otherVideo1", "Kim Kardashian on stage"), item("dupVideo001", "Kim Kardashian at home")],
        }),
        details: async (ids: string[]) => new Map(ids.map((id) => [id, { durationSec: 300, embeddable: true, live: false }])),
        triage: async () => ({ footageType: "real_footage", servesBeats: [0], depicts: "Kim Kardashian" }),
        archive: async () => [item("dupVideo001", "Kim Kardashian at home")],
        namedSubjects: () => [],
        log: () => {},
      } as never,
      { videoId: 64_399, prompt: "Kim Kardashian", title: "Kim Kardashian", sceneTexts: ["Kim Kardashian walks through her house in Hidden Hills."] }
    );
    const ids = pool.candidates.map((c) => c.videoId);
    expect(ids.filter((id) => id === "dupVideo001").length).toBe(1);
    const film = stockFilm++;
    const calls: string[] = [];
    startYoutubeShotStock(film, pool.candidates.filter((c) => c.usable).map((c) => cand(c.videoId, c.serves)), stockDeps(() => true, calls));
    await youtubeStockSettled(film);
    expect(calls.filter((id) => id === "dupVideo001").length).toBe(1);
    /** A second start for the same film (the pool asked again) does not fetch what it already holds. */
    startYoutubeShotStock(film, [cand("dupVideo001")], stockDeps(() => true, calls));
    await youtubeStockSettled(film);
    expect(calls.filter((id) => id === "dupVideo001").length).toBe(1);
    releaseYoutubeShotStock(film);
  });
});

/* ═══════════════════════ G8 — the limits are the limits ═══════════════════════ */

describe("G8 — search, download, Judge and stock limits unchanged", () => {
  it("stock 10 ready / 14 attempts / 3 at a time; 4 searches per video; 5 looks per sentence, 120 per render", () => {
    expect(MAX_STOCK_VIDEOS).toBe(10);
    expect(MAX_STOCK_ATTEMPTS).toBe(14);
    expect(STOCK_CONCURRENCY).toBe(3);
    expect(MAX_YOUTUBE_SEARCHES_PER_VIDEO).toBe(4);
    expect(maxRelevanceLooksPerBeat()).toBe(5);
    expect(maxBeatImageJudgementsPerRender()).toBe(120);
    expect(YOUTUBE_REFUSALS_BEFORE_WRITE_OFF_THIS_RENDER).toBe(2);
    expect(YOUTUBE_UNUSABLE_AFTER_REFUSALS).toBe(3);
  });
});
