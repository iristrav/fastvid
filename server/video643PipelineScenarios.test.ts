import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const nodeFetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: (...args: unknown[]) => nodeFetchMock(...args) }));

import { createJudgeBudget } from "./judgeBudget";
import { pairClipsToBeats } from "./cinematicPipelineInputs";
import {
  noteRepeatedYoutubeRefusal,
  noteYoutubeDownloadRefusal,
  noteYoutubeFragmentRefusal,
  resetPermanentDownloadRefusals,
  youtubeDownloadRefusal,
  youtubeFragmentRefusal,
} from "./providerFailureClass";
import { buildVideoYoutubePool, registerVideoYoutubePool, releaseVideoYoutubePool, type VideoYoutubePool } from "./youtubeVideoPool";
import { memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import { releaseYoutubeShotStock, startYoutubeShotStock, stockVideoState, takeStockShots, youtubeStockSettled, type StockDeps } from "./youtubeShotStock";
import { runWithActiveVideoId } from "./videoGenerationCancel";

/**
 * VIDEO 643 AUDIT — SCENARIOS A–G, FROM POOL TO THE CINEMATIC BEATS.
 *
 * Driven through the code the render runs: the pool (`buildVideoYoutubePool`), the film's stock
 * (`startYoutubeShotStock`), each sentence's YouTube turn (`runCentralYoutubeTurn` →
 * `fetchYouTubeCCClips`), the last looks and their placement (`runFinalReadyYoutubeStage`,
 * `placeApprovedAfterSceneClosed`), the approved-vs-placed check and the clips-to-beats pairing the
 * cinematic planner reads (`pairClipsToBeats`). Stand-ins: the YouTube API (no network), the download
 * service (files written locally) and the picture editor (a FIT rule per scenario).
 *
 * NOT proven here: a real download, real frames before the Judge, the vision model's verdicts, the
 * in-scene push (`pushSceneClip` inside `fetchSceneVisuals`), identity rehydration in
 * `buildCinematicSceneInputs`, the Remotion render and the MP4 itself.
 */

type VP = typeof import("./videoPipeline");
type BVRM = typeof import("./beatVisualRelevance");
let vp: VP;
let bvr: BVRM;
beforeAll(async () => {
  vp = await import("./videoPipeline");
  bvr = await import("./beatVisualRelevance");
}, 60_000);

const ORIGINAL_ENV = { ...process.env };
let workDir: string;
let film = 96_700;
beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.ENABLE_YOUTUBE_SOURCING = "true";
  process.env.YOUTUBE_API_KEY = "scenario-test-key";
  process.env.YOUTUBE_CC_DL_SERVICE = "https://scenario-cloud.example.com";
  process.env.ENABLE_SCRIPT_GUIDED_CLIPS = "false";
  resetPermanentDownloadRefusals();
  vp.resetYoutubeFragmentsFetched();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "v643scn-"));
  nodeFetchMock.mockReset();
  nodeFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  fs.rmSync(workDir, { recursive: true, force: true });
});

/* ── shared: a film's pool, stock and turns ── */
type Cand = { id: string; title: string; serves: number[] };
const poolOf = (filmId: number, sentences: string[], cands: Cand[]): VideoYoutubePool =>
  ({
    videoId: filmId,
    sentences,
    query1: "subject",
    query2: null,
    searches: 1,
    candidates: cands.map((c) => ({
      videoId: c.id, title: c.title, description: c.title, thumb: "", durationSec: 600,
      footageType: "real_footage" as const, serves: c.serves, from: 1 as const, usable: true, why: "ok",
    })),
    coverage1: 0, archiveUsable: 0, search2Needed: false, search2Reason: "", finalCoverage: 0, decided: true,
  }) as unknown as VideoYoutubePool;
const stockDeps = (calls: string[], ok: (id: string) => boolean = () => true): StockDeps => ({
  workDir,
  startFor: () => 100,
  download: async (id, _s, _d, outPath) => {
    calls.push(id);
    if (!ok(id)) return false;
    fs.writeFileSync(outPath, "section");
    return true;
  },
  cut: async (_f, pieceDir) =>
    [0, 1, 2, 3].map((i) => {
      const p = path.join(pieceDir, `shot_${i + 1}.mp4`);
      fs.writeFileSync(p, `shot ${i}`);
      return { path: p, startSec: i * 5, endSec: i * 5 + 4 };
    }),
  log: () => {},
});
const turn = (filmId: number, sentences: string[], beatIndex: number) =>
  runWithActiveVideoId(filmId, () =>
    vp.runCentralYoutubeTurn({
      beat: { index: beatIndex, text: sentences[beatIndex]!, keywords: [] },
      scene: { index: 0, text: sentences.join(" ") },
      workDir,
      sceneIndex: 0,
      clipFetchDur: 4,
      dedup: vp.createVisualDedupState(vp.getPipelinePerfProfile("1")),
      visualNeed: "topic",
      queries: [],
      queryBuilder: "buildBeatYoutubeQueries",
      termSource: "test",
      adoptOpts: {},
      timeoutMs: 30_000,
      deliver: "candidates",
    } as never)
  );
/** A render's state for the last looks, and a closed scene whose late placer records what it is given. */
function renderState(sentences: string[]) {
  return {
    lateYoutubeCandidates: [] as string[],
    beatRelevance: bvr.createBeatRelevanceLedger(),
    beatImageGate: { judgementAttempts: 0, judgementsFits: 0, judgementsMismatch: 0 },
    visionReviewPool: { beats: new Map() },
    usedContentKeys: new Set<string>(),
    sceneBeatsBySceneIndex: new Map([[0, sentences.map((text, index) => ({ index, text, holdSec: 4, keywords: [] as string[] }))]]),
  };
}
type State = ReturnType<typeof renderState>;
function closedSceneRecording(d: object) {
  const result = { clips: [] as string[], beatDurations: [] as number[], clipBeatIndices: [] as number[] };
  vp.openLatePlacement(d, 0, async () => ({ hold: 4 }));
  vp.markSceneClosed(d, 0);
  return result;
}
/** The picture editor as `adoptClip` reports it: one look per unjudged moment, a FIT registers its approval. */
const editor = (d: State, fits: (beatIndex: number, p: string) => boolean) =>
  vi.fn(async (beat: { index: number }, _scene: number, paths: string[]) => {
    const b = beat.index;
    for (const p of paths) {
      if (!d.beatRelevance.byBeat.has(bvr.beatRelevanceBeatKey(0, b, "path", p))) {
        d.beatRelevance.spendByBeat.set(`s0b${b}`, (d.beatRelevance.spendByBeat.get(`s0b${b}`) ?? 0) + 1);
        d.beatImageGate.judgementAttempts++;
        const fit = fits(b, p);
        if (fit) d.beatImageGate.judgementsFits++;
        else d.beatImageGate.judgementsMismatch++;
        d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(0, b, "path", p), { decision: { verdict: fit ? "fits" : "does_not_fit", evaluated: true } } as never);
        d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(0, b, "content", vp.clipContentKey(p)), { decision: { verdict: fit ? "fits" : "does_not_fit", evaluated: true } } as never);
      }
      if (fits(b, p)) {
        vp.noteApprovedPickForBeat(d, 0, b, vp.clipContentKey(p));
        return p;
      }
    }
    return null;
  });
const handTo = (d: object, b: number, paths: readonly string[]) => {
  for (const p of paths) vp.noteLookaheadCandidateReady(d, vp.youtubeTurnKey(0, b), p);
  return vp.takeReadyLookaheadCandidates(d, vp.youtubeTurnKey(0, b));
};
const momentTags = (paths: readonly string[]) => new Set(paths.map((p) => /_(t\d+d\d+)__pid_/.exec(path.basename(p))?.[1]).filter(Boolean));

/* ═══════════════════════ A — a healthy pipeline: 12 sentences, six videos, each serving two ═══════════════════════ */

describe("SCENARIO A — healthy: 12 sentences reach their own pictures, through placement to the cinematic beats", () => {
  const SENTENCES = Array.from({ length: 12 }, (_, i) => `Sentence ${i} about subject ${String.fromCharCode(65 + Math.floor(i / 2))} and its own place.`);
  const videos = Array.from({ length: 6 }, (_, k) => ({ id: `Video${k}AAAAA`.slice(0, 11), title: `Subject ${String.fromCharCode(65 + k)} footage`, serves: [2 * k, 2 * k + 1] }));

  it("each sentence is handed several moments of the video that serves it, one download per video; FITs placed and paired to their beats", async () => {
    const filmId = film++;
    const calls: string[] = [];
    registerVideoYoutubePool(filmId, Promise.resolve(poolOf(filmId, SENTENCES, videos)));
    startYoutubeShotStock(filmId, videos.map((v) => ({ videoId: v.id, title: v.title, durationSec: 600, serves: 2, beats: v.serves })), stockDeps(calls));
    await youtubeStockSettled(filmId);
    const handed: string[][] = [];
    for (let i = 0; i < SENTENCES.length; i++) {
      const r = await turn(filmId, SENTENCES, i);
      handed.push(r.candidatePaths);
      expect(r.candidatePaths.length, `sentence ${i} handed nothing`).toBeGreaterThan(0);
      /** Several moments of the same video, not one. */
      expect(momentTags(r.candidatePaths).size, `sentence ${i}: one moment only`).toBeGreaterThanOrEqual(2);
    }
    /** Six videos, twelve sentences: every video fetched once and offered. */
    expect(calls.sort()).toEqual(videos.map((v) => v.id).sort());
    for (const v of videos) expect(stockVideoState(filmId, v.id)?.offered).toBe(true);

    /** The last looks judge them; the editor approves a sentence's first moment. Placement, then the planner's pairing. */
    const d = renderState(SENTENCES);
    closedSceneRecording(d);
    handed.forEach((paths, i) => handTo(d, i, paths));
    const firstOf = new Map(handed.map((paths, i) => [i, paths[0]!]));
    const look = editor(d, (b, p) => p === firstOf.get(b));
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], [{ clips: [], beatDurations: [], clipBeatIndices: [] }], look, {
      windowMs: 20,
      budget: createJudgeBudget({ baseMs: 2_000, perLookMs: 500, ceilingMs: 20_000 }),
    });
    const placed = await vp.placeApprovedAfterSceneClosed(d, 0, { sceneReturned: true, final: true });
    expect(placed.length).toBe(12);
    expect(new Set(placed.map((p) => p.beatIndex)).size).toBe(12);
    const pairs = pairClipsToBeats({ clipPaths: placed.map((p) => p.clip), clipBeatIndices: placed.map((p) => p.beatIndex), beats: SENTENCES.map((_, index) => ({ index })) });
    pairs.forEach((clips, i) => expect(clips, `beat ${i}`).toEqual([firstOf.get(i)]));
    const check = vp.formatFitPlacementCheck(d, SENTENCES.map((_, b) => ({ sceneIndex: 0, beatIndex: b })), (_s, b) => placed.filter((p) => p.beatIndex === b).length);
    expect(check).toEqual(["[FitPlacement] TOTAL approvedRealShots=12 placedRealShots=12 lost=0"]);
    releaseYoutubeShotStock(filmId);
    releaseVideoYoutubePool(filmId);
  }, 120_000);
});

/* ═══════════════════════ B — many unusable results ═══════════════════════ */

describe("SCENARIO B — duplicates, Shorts, no stream details and talking heads do not crowd out the usable", () => {
  it("exact counts and the reason each result was refused; the usable three are what the stock may fetch", async () => {
    const item = (videoId: string, title: string) => ({ videoId, title, description: "", channel: "c", thumb: "t" });
    const items = [
      item("usable00001", "City skyline at night"),
      item("dupVideo001", "Harbour cranes loading containers"),
      item("dupVideo001", "Harbour cranes loading containers"),
      item("shortVideo1", "Skyline in 10 seconds #shorts"),
      item("noDetails01", "Old tram through the city"),
      item("notEmbed001", "Bridge opening ceremony"),
      item("liveStream1", "Live harbour webcam"),
      item("tooShort001", "Two second clip of a crane"),
      item("talkHead001", "Expert explains the port economy"),
      item("usable00002", "Aerial view of the river"),
    ];
    const details = new Map<string, { durationSec: number; embeddable: boolean; live: boolean }>([
      ["usable00001", { durationSec: 300, embeddable: true, live: false }],
      ["dupVideo001", { durationSec: 300, embeddable: true, live: false }],
      ["shortVideo1", { durationSec: 40, embeddable: true, live: false }],
      ["notEmbed001", { durationSec: 300, embeddable: false, live: false }],
      ["liveStream1", { durationSec: 300, embeddable: true, live: true }],
      ["tooShort001", { durationSec: 4, embeddable: true, live: false }],
      ["talkHead001", { durationSec: 300, embeddable: true, live: false }],
      ["usable00002", { durationSec: 300, embeddable: true, live: false }],
    ]);
    const pool = await buildVideoYoutubePool(
      {
        store: memoryYoutubeSearchBudgetStore(),
        llm: async () => ({ choices: [{ message: { content: JSON.stringify({ mainSubject: "Rotterdam harbour", recurringSubjects: [], query: "Rotterdam harbour" }) } }] }),
        gate: (q: string) => ({ ok: true, sentAs: q }),
        search: async () => ({ status: 200, items }),
        details: async (ids: string[]) => new Map(ids.filter((id) => details.has(id)).map((id) => [id, details.get(id)!])),
        triage: async (it: { videoId: string }) => ({ footageType: it.videoId === "talkHead001" ? "talking_head" : "real_footage", servesBeats: [0], depicts: "harbour" }),
        archive: async () => [],
        namedSubjects: () => [],
        log: () => {},
      } as never,
      { videoId: 96_799, prompt: "Rotterdam harbour", title: "Rotterdam harbour", sceneTexts: ["The Rotterdam harbour works through the night."] }
    );
    const why = Object.fromEntries(pool.candidates.map((c) => [c.videoId, c.usable ? "ok" : c.why]));
    expect(items.length).toBe(10);
    expect(pool.candidates.length).toBe(9);
    expect(pool.candidates.filter((c) => c.usable).map((c) => c.videoId).sort()).toEqual(["dupVideo001", "usable00001", "usable00002"]);
    expect(why.shortVideo1).toMatch(/^youtube short/);
    expect(why.noDetails01).toBe("no details — length unknown, may be a Short");
    expect(why.notEmbed001).toBe("not embeddable");
    expect(why.liveStream1).toBe("live");
    /** 4 s is a Short by its length before it is "too short": the length rule comes first. */
    expect(why.tooShort001).toMatch(/^youtube short \(4s/);
    expect(why.talkHead001).toMatch(/footage type talking_head/);
  });

  it("P1 — the search's funnel line counts the same video once and names every refusal class", async () => {
    const item = (videoId: string, title: string) => ({ videoId, title, description: "", channel: "c", thumb: "" });
    const items = [
      item("usable00001", "City skyline at night"),
      item("dupVideo001", "Harbour cranes loading containers"),
      item("dupVideo001", "Harbour cranes loading containers"),
      item("shortVideo1", "Skyline in 10 seconds #shorts"),
      item("noDetails01", "Old tram through the city"),
      item("talkHead001", "Expert explains the port economy"),
    ];
    const details = new Map<string, { durationSec: number; embeddable: boolean; live: boolean }>([
      ["usable00001", { durationSec: 300, embeddable: true, live: false }],
      ["dupVideo001", { durationSec: 300, embeddable: true, live: false }],
      ["shortVideo1", { durationSec: 40, embeddable: true, live: false }],
      ["talkHead001", { durationSec: 300, embeddable: true, live: false }],
    ]);
    const lines: string[] = [];
    await buildVideoYoutubePool(
      {
        store: memoryYoutubeSearchBudgetStore(),
        llm: async () => ({ choices: [{ message: { content: JSON.stringify({ mainSubject: "Rotterdam harbour", recurringSubjects: [], query: "Rotterdam harbour" }) } }] }),
        gate: (q: string) => ({ ok: true, sentAs: q }),
        search: async () => ({ status: 200, items }),
        details: async (ids: string[]) => new Map(ids.filter((id) => details.has(id)).map((id) => [id, details.get(id)!])),
        triage: async (it: { videoId: string }) => ({ footageType: it.videoId === "talkHead001" ? "talking_head" : "real_footage", servesBeats: [0], depicts: "harbour" }),
        archive: async () => [item("usable00001", "City skyline at night"), item("archive0001", "Harbour at dawn")],
        namedSubjects: () => [],
        log: (l: string) => lines.push(l),
      } as never,
      { videoId: 96_798, prompt: "Rotterdam harbour", title: "Rotterdam harbour", sceneTexts: ["The Rotterdam harbour works through the night."] }
    );
    const funnel = lines.filter((l) => l.startsWith("[YouTubeFunnel]"));
    expect(funnel[0]).toBe(
      "[YouTubeFunnel] video=96798 search=#1 raw=6 unique=5 alreadyInPool=0 judged=5 passed=2 rejected=3 " +
        "reasons={youtube_short=1 no_details=1 footage_type=1} UNKNOWN=0"
    );
    /** The archive's copy of a video search #1 already judged is counted as already in the pool, not again. */
    expect(funnel[1]).toBe(
      "[YouTubeFunnel] video=96798 search=archive raw=2 unique=2 alreadyInPool=1 judged=1 passed=0 rejected=1 reasons={no_details=1} UNKNOWN=0"
    );
  });
});

/* ═══════════════════════ C — download failures ═══════════════════════ */

describe("SCENARIO C — a failing download blocks nothing else; temporary is not permanent; a later delivery counts", () => {
  it("one refusal of three: the other two are ready; a stream refused once is not written off and delivers on the next fetch", async () => {
    const filmId = film++;
    const calls: string[] = [];
    let firstTry = true;
    startYoutubeShotStock(
      filmId,
      ["okVideo0001", "flakyVideo1", "okVideo0002"].map((id) => ({ videoId: id, title: id, durationSec: 600, serves: 1, beats: [0] })),
      stockDeps(calls, (id) => (id === "flakyVideo1" ? !firstTry : true))
    );
    await youtubeStockSettled(filmId);
    expect(stockVideoState(filmId, "flakyVideo1")?.status).toBe("failed");
    expect(stockVideoState(filmId, "okVideo0001")?.status).toBe("ready");
    expect(stockVideoState(filmId, "okVideo0002")?.status).toBe("ready");
    /** Temporary: one stream refusal, a timeout — neither writes the video off. */
    expect(noteRepeatedYoutubeRefusal("flakyVideo1", "http_502:stream_refused")).toBe(false);
    expect(noteYoutubeDownloadRefusal("flakyVideo1", "DOWNLOAD_TIMEOUT", "Timeout")).toBe(false);
    expect(youtubeDownloadRefusal("flakyVideo1")).toBeNull();
    /** Permanent: about the video. */
    expect(noteYoutubeDownloadRefusal("goneVideo01", "DOWNLOAD_FAILED", "http_502:unavailable")).toBe(true);
    /** The next fetch (another film, or the background fetch) delivers it. */
    firstTry = false;
    const next = film++;
    startYoutubeShotStock(next, [{ videoId: "flakyVideo1", title: "flaky", durationSec: 600, serves: 1, beats: [0] }], stockDeps(calls, () => true));
    await youtubeStockSettled(next);
    expect(stockVideoState(next, "flakyVideo1")?.status).toBe("ready");
    releaseYoutubeShotStock(filmId);
    releaseYoutubeShotStock(next);
  });
});

/* ═══════════════════════ D — reuse ═══════════════════════ */

describe("SCENARIO D — one video serves two sentences; MISMATCH for A, FIT for B; one download", () => {
  it("both sentences are handed its moments; a moment refused for A is judged anew for B and taken", async () => {
    const filmId = film++;
    const SENTENCES = ["The mansion's gate opens at dawn.", "Inside, the mansion's hall is lined with art."];
    const calls: string[] = [];
    registerVideoYoutubePool(filmId, Promise.resolve(poolOf(filmId, SENTENCES, [{ id: "mansion0001", title: "Mansion tour", serves: [0, 1] }])));
    startYoutubeShotStock(filmId, [{ videoId: "mansion0001", title: "Mansion tour", durationSec: 600, serves: 2, beats: [0, 1] }], stockDeps(calls));
    await youtubeStockSettled(filmId);
    const a = await turn(filmId, SENTENCES, 0);
    const b = await turn(filmId, SENTENCES, 1);
    expect(a.candidatePaths.length).toBeGreaterThan(0);
    expect(b.candidatePaths.length).toBeGreaterThan(0);
    expect(calls).toEqual(["mansion0001"]);

    const d = renderState(SENTENCES);
    closedSceneRecording(d);
    const shared = b.candidatePaths[0]!;
    handTo(d, 0, [shared]);
    handTo(d, 1, [shared]);
    const look = editor(d, (beat) => beat === 1);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], [{ clips: [], beatDurations: [], clipBeatIndices: [] }], look, {
      windowMs: 20,
      budget: createJudgeBudget({ baseMs: 2_000, perLookMs: 500, ceilingMs: 10_000 }),
    });
    /** One fragment, two judgements: fragment × sentence. */
    expect(bvr.beatAlreadyRefusedPicture(d.beatRelevance, 0, 0, { clipPath: shared })).not.toBeNull();
    expect(bvr.beatAlreadyRefusedPicture(d.beatRelevance, 0, 1, { clipPath: shared })).toBeNull();
    const placed = await vp.placeApprovedAfterSceneClosed(d, 0, { sceneReturned: true, final: true });
    expect(placed).toEqual([{ beatIndex: 1, clip: shared, hold: 4 }]);
    releaseYoutubeShotStock(filmId);
    releaseVideoYoutubePool(filmId);
  }, 60_000);
});

/* ═══════════════════════ E — a late FIT ═══════════════════════ */

describe("SCENARIO E — a FIT that arrives in the last looks is in the clips the planner reads, before the film is assembled", () => {
  it("a slow review inside the picture editor's budget: placed on its own sentence, paired to its beat, nothing lost", async () => {
    const SENTENCES = ["The family business grew online.", "The ledger told another story."];
    const d = renderState(SENTENCES);
    closedSceneRecording(d);
    const m = path.join(workDir, "scene_0_ytfu_0m0_t3778d30__pid_youtube_cc-d72b145386fde4d1.mp4");
    fs.writeFileSync(m, "moment");
    handTo(d, 1, [m]);
    const slow = editor(d, (b) => b === 1);
    const look = vi.fn(async (beat: { index: number }, s: number, paths: string[]) => {
      await new Promise((r) => setTimeout(r, 300));
      return slow(beat, s, paths);
    });
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], [{ clips: [], beatDurations: [], clipBeatIndices: [] }], look, {
      windowMs: 20,
      budget: createJudgeBudget({ baseMs: 100, perLookMs: 2_000, ceilingMs: 5_000 }),
    });
    const placed = await vp.placeApprovedAfterSceneClosed(d, 0, { sceneReturned: true, final: true });
    const pairs = pairClipsToBeats({ clipPaths: placed.map((p) => p.clip), clipBeatIndices: placed.map((p) => p.beatIndex), beats: [{ index: 0 }, { index: 1 }] });
    expect(pairs).toEqual([[], [m]]);
    expect(vp.formatFitPlacementCheck(d, [{ sceneIndex: 0, beatIndex: 0 }, { sceneIndex: 0, beatIndex: 1 }], (_s, b) => (b === 1 ? 1 : 0))[0]).toBe(
      "[FitPlacement] TOTAL approvedRealShots=1 placedRealShots=1 lost=0"
    );
  });
});

/* ═══════════════════════ F — many candidates, a longer film ═══════════════════════ */

describe("SCENARIO F (P3) — 30 sentences without a picture: three looks at once, 120 for the render, the budget from executed looks", () => {
  const thirty = () => {
    const SENTENCES = Array.from({ length: 30 }, (_, i) => `Sentence ${i}.`);
    const d = renderState(SENTENCES);
    closedSceneRecording(d);
    for (let b = 0; b < 30; b++) {
      handTo(d, b, Array.from({ length: 7 }, (_, k) => {
        const p = path.join(workDir, `scene_0_ytfu_${b}m${k}_t${1000 + 60 * k}d40__pid_youtube_cc-${(b * 7 + k).toString(16).padStart(16, "0")}.mp4`);
        fs.writeFileSync(p, "m");
        return p;
      }));
    }
    return { SENTENCES, d };
  };

  it("never more than 3 at once, never more than 120 started, in film order; the budget grew by exactly the looks executed; no dead wait", async () => {
    const { d } = thirty();
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const offered: number[] = [];
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;
    const base = editor(d, () => false);
    const look = vi.fn(async (beat: { index: number }, s: number, paths: string[]) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(beat.index);
      offered.push(paths.length);
      await new Promise((r) => setTimeout(r, 15));
      try {
        return await base(beat, s, paths);
      } finally {
        active--;
      }
    });
    const budget = createJudgeBudget({ baseMs: 50, perLookMs: 20, ceilingMs: 10_000 });
    const t0 = Date.now();
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], [{ clips: [], beatDurations: [], clipBeatIndices: [] }], look, { windowMs: 20, budget });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(maxActive).toBe(3);
    /** 24 sentences × 5 = the render's 120; the six after them are named, not looked at */
    expect(look).toHaveBeenCalledTimes(24);
    expect(order).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(Math.max(...offered)).toBeLessThanOrEqual(5);
    expect(d.beatImageGate.judgementAttempts).toBe(120);
    expect(budget.looks).toBe(120);
    expect(budget.grantedMs()).toBe(2_400);
    expect(lines).toContain(
      "[FinalLooks] sentences queued=30 started=30 skipped=0 notStarted=0 concurrency=3 moments planned=150 reserved=120 judged=120 notReserved=30 FIT=0 MISMATCH=120 renderLooks=120/120"
    );
    expect(lines.filter((l) => /s0b(2[4-9]) not looked at — reason=FILM_LOOK_CEILING/.test(l)).length).toBe(6);
  });

  it("a FIT on the first moment executes one look: the four never looked at are refunded; the end check explains every FIT", async () => {
    const { SENTENCES, d } = thirty();
    const first = new Map<number, string>();
    const look = editor(d, (b, p) => {
      if (!first.has(b)) first.set(b, p);
      return b < 2 && first.get(b) === p;
    });
    const budget = createJudgeBudget({ baseMs: 50, perLookMs: 20, ceilingMs: 10_000 });
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], [{ clips: [], beatDurations: [], clipBeatIndices: [] }], look, { windowMs: 20, budget });
    /** sentences 0 and 1: one look each (a FIT, four refunded); the 118 left go 5 a sentence, the last one 3; never past 120 */
    expect(d.beatImageGate.judgementsFits).toBe(2);
    expect(d.beatImageGate.judgementAttempts).toBe(2 + 5 * 23 + 3);
    expect(d.beatRelevance.spendByBeat.get("s0b0")).toBe(1);
    expect(d.beatRelevance.spendByBeat.get("s0b25")).toBe(3);
    expect(d.beatRelevance.spendByBeat.get("s0b26")).toBeUndefined();
    expect(budget.looks).toBe(d.beatImageGate.judgementAttempts);
    const placed = await vp.placeApprovedAfterSceneClosed(d, 0, { sceneReturned: true, final: true });
    expect(placed.map((p) => p.beatIndex).sort()).toEqual([0, 1]);
    const check = vp.formatFitPlacementCheck(d, SENTENCES.map((_, b) => ({ sceneIndex: 0, beatIndex: b })), (_s, b) => placed.filter((p) => p.beatIndex === b).length);
    expect(check).toEqual(["[FitPlacement] TOTAL approvedRealShots=2 placedRealShots=2 lost=0"]);
  });
});

/* ═══════════════════════ G — bad pictures ═══════════════════════ */

describe("SCENARIO G — black, text-burned, broken or too-short moments: only those are refused, the video's other moments stay", () => {
  it("a refused fragment is refused by its seconds, not the video; the stock hands out the video's other shots", async () => {
    noteYoutubeFragmentRefusal("youtube_cc:aaaaaaaaaaaaaaaa@t100d40", "mostly_black");
    expect(youtubeFragmentRefusal("youtube_cc:aaaaaaaaaaaaaaaa@t100d40")).toBe("mostly_black");
    expect(youtubeFragmentRefusal("youtube_cc:aaaaaaaaaaaaaaaa@t200d40")).toBeNull();
    for (const technical of ["mostly_black", "baked_edit_text_before_vision", "not_a_valid_video", "invalid_duration_before_review"]) {
      expect(vp.refusalHoldsForEverySentence(technical), technical).toBe(true);
    }
    const filmId = film++;
    startYoutubeShotStock(filmId, [{ videoId: "mixedVideo1", title: "mixed", durationSec: 600, serves: 1, beats: [0] }], stockDeps([]));
    await youtubeStockSettled(filmId);
    const took = await takeStockShots(filmId, "mixedVideo1", 0, (s) => s.sourceStartSec === 100, 4);
    expect(took.shots.length).toBe(3);
    expect(took.shots.some((s) => s.sourceStartSec === 100)).toBe(false);
    releaseYoutubeShotStock(filmId);
  });

  it("a moment under 3 s after preparing is refused and named; the sentence's next moment is tried", async () => {
    const d = renderState(["One sentence."]);
    closedSceneRecording(d);
    const short = path.join(workDir, "scene_0_ytfu_0m0_t100d24__pid_youtube_cc-bbbbbbbbbbbbbbbb.mp4");
    const good = path.join(workDir, "scene_0_ytfu_0m1_t300d40__pid_youtube_cc-bbbbbbbbbbbbbbbb.mp4");
    fs.writeFileSync(short, "s");
    fs.writeFileSync(good, "g");
    handTo(d, 0, [short, good]);
    const ed = editor(d, () => true);
    const clip = await vp.finalReadyYoutubeLook(d as never, 0, 0, (ready) => ed({ index: 0 }, 0, ready), async (c) => (c === short ? 2.4 : 4));
    expect(clip).toBe(good);
    expect(vp.formatFitPlacementCheck(d, [{ sceneIndex: 0, beatIndex: 0 }], () => 1)[1]).toContain("(3 s rule)");
  });
});
