import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fsP from "fs";
import osP from "os";
import pathP from "path";
import { formatYoutubeFunnelLine, youtubeSearchFunnel, youtubeTriageReasonClass } from "./youtubeVideoPool";
import {
  closeYoutubeDownloadFunnel,
  formatYoutubeDownloadFunnel,
  noteYoutubeDownloadExit,
  resetYoutubeDownloadFunnelForTests,
  startYoutubeDownloadFunnel,
  youtubeDownloadFailureClass,
} from "./youtubeDownloadFunnel";

/**
 * VIDEO 643 — P1–P4 AFTER THE PIPELINE AUDIT.
 *
 * P1: the funnel is counted from what the pipeline already decided (no new call). P2–P4 below.
 */

/* ═══════════════════════ P1 — per search ═══════════════════════ */

describe("P1 — the search funnel", () => {
  it("classes every reason judge writes, keeps an unknown one as other, and a missing one as UNKNOWN", () => {
    expect(youtubeTriageReasonClass("title genre compilation")).toBe("title_genre");
    expect(youtubeTriageReasonClass("youtube short (#shorts)")).toBe("youtube_short");
    expect(youtubeTriageReasonClass("no details — length unknown, may be a Short")).toBe("no_details");
    expect(youtubeTriageReasonClass("live")).toBe("live");
    expect(youtubeTriageReasonClass("too short 12s")).toBe("too_short");
    expect(youtubeTriageReasonClass("too long 300min (download ceiling)")).toBe("too_long");
    expect(youtubeTriageReasonClass("not embeddable")).toBe("not_embeddable");
    expect(youtubeTriageReasonClass("not judged")).toBe("not_judged");
    expect(youtubeTriageReasonClass("footage type talking_head")).toBe("footage_type");
    expect(youtubeTriageReasonClass("something new")).toBe("other");
    expect(youtubeTriageReasonClass("")).toBe("UNKNOWN");
    expect(youtubeTriageReasonClass(undefined)).toBe("UNKNOWN");
  });

  it("counts raw, unique, already-in-pool and per-video verdicts without double counting", () => {
    const f = youtubeSearchFunnel(
      ["a", "a", "b", "c", "d", "e"],
      [
        /** "a" twice: one refusal, one pass — counted once, as passed (mergeCandidates keeps the usable one). */
        { videoId: "a", usable: false, why: "not judged" },
        { videoId: "a", usable: true, why: "ok" },
        { videoId: "b", usable: false, why: "" },
        { videoId: "c", usable: false, why: "live" },
      ]
    );
    expect(f).toEqual({
      raw: 6,
      unique: 5,
      alreadyInPool: 2,
      judged: 3,
      passed: 1,
      rejected: 2,
      byReason: { UNKNOWN: 1, live: 1 },
    });
    expect(formatYoutubeFunnelLine(7, "#3", f)).toBe(
      "[YouTubeFunnel] video=7 search=#3 raw=6 unique=5 alreadyInPool=2 judged=3 passed=1 rejected=2 reasons={live=1} UNKNOWN=1"
    );
  });

  it("an empty search is a line of zeros, not a missing line", () => {
    expect(formatYoutubeFunnelLine(1, "#2", youtubeSearchFunnel([], []))).toBe(
      "[YouTubeFunnel] video=1 search=#2 raw=0 unique=0 alreadyInPool=0 judged=0 passed=0 rejected=0 reasons={} UNKNOWN=0"
    );
  });
});

/* ═══════════════════════ P1 — per render downloads ═══════════════════════ */

describe("P1 — the render's download funnel", () => {
  beforeEach(() => resetYoutubeDownloadFunnelForTests());
  afterEach(() => resetYoutubeDownloadFunnelForTests());

  const fail = (videoId: string, detail: string, status = "DOWNLOAD_FAILED") => ({
    videoId,
    status,
    reason: `cloud=${detail}`,
    attempts: [{ status, detail }],
  });
  const ok = (videoId: string) => ({ videoId, status: "DOWNLOAD_SUCCESS", reason: "cloud_service", attempts: [{ status: "DOWNLOAD_SUCCESS", detail: "100_bytes" }] });

  it("uses the class the refusal already carries, else its status", () => {
    expect(youtubeDownloadFailureClass(fail("x", "http_403:stream_refused"))).toBe("stream_refused");
    expect(youtubeDownloadFailureClass(fail("x", "http_429:bot_check"))).toBe("bot_check");
    expect(youtubeDownloadFailureClass(fail("x", "http_502:other:bad gateway"))).toBe("other");
    expect(youtubeDownloadFailureClass(fail("x", "NO_VIDEO_STREAM:audio only", "DOWNLOAD_INVALID_CONTENT"))).toBe("NO_VIDEO_STREAM");
    expect(youtubeDownloadFailureClass(fail("x", "scene_budget_3s_left", "DOWNLOAD_TIMEOUT"))).toBe("DOWNLOAD_TIMEOUT");
    expect(youtubeDownloadFailureClass({ status: "", attempts: [] })).toBe("UNKNOWN");
  });

  it("counts attempts, deliveries, failures per class, reuse and skips apart — 643's stock in miniature", () => {
    startYoutubeDownloadFunnel(643);
    noteYoutubeDownloadExit(fail("NDl1ztoOseI", "http_403:stream_refused"));
    noteYoutubeDownloadExit(fail("NDl1ztoOseI", "http_403:stream_refused"));
    noteYoutubeDownloadExit({ videoId: "NDl1ztoOseI", status: "DOWNLOAD_FAILED", reason: "refused_this_render:DOWNLOAD_FAILED:x×2", attempts: [] });
    noteYoutubeDownloadExit(fail("botVideo001", "http_429:bot_check"));
    noteYoutubeDownloadExit(fail("audioOnly01", "NO_VIDEO_STREAM:audio", "DOWNLOAD_INVALID_CONTENT"));
    noteYoutubeDownloadExit(fail("slowVideo01", "fetch timeout", "DOWNLOAD_TIMEOUT"));
    noteYoutubeDownloadExit(ok("goodVideo01"));
    noteYoutubeDownloadExit({ videoId: "goodVideo01", status: "DOWNLOAD_SUCCESS", reason: "same_seconds_already_fetched", attempts: [] });
    noteYoutubeDownloadExit({ videoId: "oldWriteOff", status: "DOWNLOAD_FAILED", reason: "known_unusable:3 refusals", attempts: [] });
    /** Refused once (temporary), delivered on the next fetch the same render. */
    noteYoutubeDownloadExit(fail("flakyVideo1", "fetch timeout", "DOWNLOAD_TIMEOUT"));
    noteYoutubeDownloadExit(ok("flakyVideo1"));
    expect(formatYoutubeDownloadFunnel()).toBe(
      "[YouTubeFunnel] render=643 downloads exits=11 transfers=8 delivered=2 failed=6 " +
        "{DOWNLOAD_TIMEOUT=2 stream_refused=2 bot_check=1 NO_VIDEO_STREAM=1} notStarted={} reused=1 " +
        "skipped={known_unusable=1 refused_this_render=1} videos=7 videosDelivered=2 videosRefused=4 deliveredAfterRefusal=1 [flakyVideo1]"
    );
  });

  it("FIX 4 — a route noted but never called (scene budget below the floor, egress latch) is not a transfer and not a refusal", () => {
    startYoutubeDownloadFunnel(7);
    noteYoutubeDownloadExit(fail("budgetCut01", "scene_budget_3s_left", "DOWNLOAD_TIMEOUT"));
    noteYoutubeDownloadExit(fail("egressVid01", "cloud_egress_blocked:http_403", "DOWNLOAD_FAILED"));
    noteYoutubeDownloadExit(fail("realFail001", "http_403:stream_refused"));
    expect(formatYoutubeDownloadFunnel()).toBe(
      "[YouTubeFunnel] render=7 downloads exits=3 transfers=1 delivered=0 failed=1 {stream_refused=1} " +
        "notStarted={cloud_egress_blocked=1 scene_budget=1} reused=0 skipped={} videos=3 videosDelivered=0 videosRefused=1 deliveredAfterRefusal=0"
    );
    /** a later delivery of a video whose only exit was never started is not "delivered after a refusal" */
    noteYoutubeDownloadExit(ok("budgetCut01"));
    expect(formatYoutubeDownloadFunnel()).toMatch(/deliveredAfterRefusal=0$/);
  });

  it("a video delivered twice is one video and one late delivery, not two", () => {
    startYoutubeDownloadFunnel(1);
    noteYoutubeDownloadExit(fail("v1", "http_403:stream_refused"));
    noteYoutubeDownloadExit(ok("v1"));
    noteYoutubeDownloadExit(ok("v1"));
    expect(formatYoutubeDownloadFunnel()).toMatch(/delivered=2 .* videos=1 videosDelivered=1 videosRefused=0 deliveredAfterRefusal=1 \[v1\]$/);
  });

  it("after the render: the prefetch's delivery of a video the render refused is one line; others are silent", () => {
    startYoutubeDownloadFunnel(643);
    noteYoutubeDownloadExit(fail("NDl1ztoOseI", "http_403:stream_refused"));
    noteYoutubeDownloadExit(ok("goodVideo01"));
    closeYoutubeDownloadFunnel();
    expect(formatYoutubeDownloadFunnel()).toBeNull();
    expect(noteYoutubeDownloadExit(ok("NDl1ztoOseI"))).toBe(
      "[YouTubeFunnel] afterRender=643 video=NDl1ztoOseI deliveredByPrefetch refusedInRender=stream_refused"
    );
    expect(noteYoutubeDownloadExit(ok("goodVideo01"))).toBeNull();
    expect(noteYoutubeDownloadExit(ok("neverTried1"))).toBeNull();
    expect(noteYoutubeDownloadExit(fail("NDl1ztoOseI", "http_403:stream_refused"))).toBeNull();
    /** And it never counts into a render that is not open. */
    expect(formatYoutubeDownloadFunnel()).toBeNull();
  });

  it("a new render starts empty and closes the one before it", () => {
    startYoutubeDownloadFunnel(1);
    noteYoutubeDownloadExit(fail("v1", "http_403:stream_refused"));
    startYoutubeDownloadFunnel(2);
    expect(formatYoutubeDownloadFunnel()).toBe(
      "[YouTubeFunnel] render=2 downloads exits=0 transfers=0 delivered=0 failed=0 {} notStarted={} reused=0 skipped={} videos=0 videosDelivered=0 videosRefused=0 deliveredAfterRefusal=0"
    );
    closeYoutubeDownloadFunnel();
    expect(noteYoutubeDownloadExit(ok("v1"))).toBeNull();
  });
});

describe("P1 — wiring", () => {
  it("every download exit feeds the funnel; the render starts it and closes it after its summary; the prefetch batch closes a stale one", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
    const PIPE = read("videoPipeline.ts");
    const at = PIPE.indexOf("const line = formatYoutubeDownloadLine({");
    expect(PIPE.slice(at, at + 600)).toContain("noteDownloadFunnel(videoId, status, reason, attempts);");
    const reset = PIPE.indexOf("  resetPermanentDownloadRefusals();\n");
    expect(PIPE.slice(reset, reset + 700)).toContain("startYoutubeDownloadFunnel(videoId);");
    const sum = PIPE.indexOf("const funnel = formatYoutubeDownloadFunnel();");
    expect(sum).toBeGreaterThan(PIPE.indexOf("[YouTubeSearchOutcome] video="));
    expect(PIPE.slice(sum, sum + 200)).toContain("closeYoutubeDownloadFunnel();");
    expect(read("youtubePrefetch.ts")).toContain('(await import("./youtubeDownloadFunnel")).closeYoutubeDownloadFunnel();');
    const POOL = read("youtubeVideoPool.ts");
    expect(POOL.match(/log\(formatYoutubeFunnelLine\(/g)?.length).toBe(3);
  });
});

/* ═══════════════════════ P2 — late stock: spread, reuse, skip the unusable ═══════════════════════ */

describe("P2 — which open sentence a late stock video goes to", () => {
  const S = (beatIndex: number) => ({ sceneIndex: 0, beatIndex });
  const key = (b: number) => `s0b${b}`;
  let vpm: typeof import("./videoPipeline");
  beforeAll(async () => {
    vpm = await import("./videoPipeline");
  }, 60_000);
  const keys = (m: Map<string, string[]>) => Object.fromEntries([...m.entries()].map(([k, v]) => [k.replace(/^.*?(\d+)\D+(\d+)$/, "s$1b$2"), v]));

  it("no default to the first sentence: videos nobody is tied to go round-robin over the open sentences", () => {
    const m = vpm.assignLateStockVideos(["v1", "v2", "v3", "v4", "v5", "v6"], [S(0), S(1), S(2)], () => false, 2);
    expect(keys(m)).toEqual({ [key(0)]: ["v1", "v4"], [key(1)]: ["v2", "v5"], [key(2)]: ["v3", "v6"] });
  });

  it("a video the pool's look ties to a sentence goes there first; when that one is full, to the open sentence holding the fewest", () => {
    const m = vpm.assignLateStockVideos(["a", "b", "c", "d"], [S(0), S(1), S(2)], (id, s) => s.beatIndex === 2, 2);
    expect(keys(m)).toEqual({ [key(2)]: ["a", "b"], [key(0)]: ["c"], [key(1)]: ["d"] });
  });

  it("never past what one sentence's looks can judge: the rest is not assigned, not piled on", () => {
    const m = vpm.assignLateStockVideos(["1", "2", "3", "4", "5", "6", "7"], [S(0), S(1), S(2)], () => false, 2);
    expect([...m.values()].flat().length).toBe(6);
    expect(Math.max(...[...m.values()].map((v) => v.length))).toBe(2);
    expect(vpm.assignLateStockVideos(["x"], [], () => true, 2).size).toBe(0);
  });

  it("without a cap (as before) it still spreads instead of defaulting to sentences[0]", () => {
    const m = vpm.assignLateStockVideos(["v1", "v2", "v3"], [S(0), S(1)], () => false);
    expect(keys(m)).toEqual({ [key(0)]: ["v1", "v3"], [key(1)]: ["v2"] });
  });

  /* ── FIX 1 — a targeted video goes to the sentences it was searched for, or to none ── */

  it("FIX 1 — 643's Kendall case: a targeted video goes to the sentence it was searched for, not to s0b0", () => {
    const kendall = (b: number) => b === 6;
    const m = vpm.assignLateStockVideos(["_s1tMR4KT8U", "JMGxhEWJahI"], [S(0), S(1), S(6)], (_id, s) => kendall(s.beatIndex), 2, () => true);
    expect(keys(m)).toEqual({ [key(6)]: ["_s1tMR4KT8U", "JMGxhEWJahI"] });
  });

  it("FIX 1 — a targeted video whose sentence is not open (or whose destination was lost) goes to NO other sentence, and says so", () => {
    const left: Array<[string, string]> = [];
    /** its sentence already has a picture / the pool could not be read: nothing serves */
    const m = vpm.assignLateStockVideos(["targeted001"], [S(0), S(1)], () => false, 2, () => true, (id, why) => left.push([id, why]));
    expect(m.size).toBe(0);
    expect(left).toEqual([["targeted001", "targeted_no_open_sentence"]]);
  });

  it("FIX 1 — a targeted video whose own sentence is full is not moved to another sentence", () => {
    const left: Array<[string, string]> = [];
    const m = vpm.assignLateStockVideos(["t1", "t2", "t3"], [S(0), S(4)], (_id, s) => s.beatIndex === 4, 2, () => true, (id, why) => left.push([id, why]));
    expect(keys(m)).toEqual({ [key(4)]: ["t1", "t2"] });
    expect(left).toEqual([["t3", "no_room"]]);
  });

  it("FIX 1 — general videos keep the general fallback next to targeted ones; a video named twice is assigned once", () => {
    const targeted = (id: string) => id.startsWith("t");
    const m = vpm.assignLateStockVideos(["t1", "g1", "g1", "g2", "t2"], [S(0), S(1), S(5)], (id, s) => targeted(id) && s.beatIndex === 5, 2, targeted);
    expect(keys(m)).toEqual({ [key(5)]: ["t1", "t2"], [key(0)]: ["g1"], [key(1)]: ["g2"] });
    expect([...m.values()].flat().filter((id) => id === "g1").length).toBe(1);
  });
});

describe("P2 — the last look's stock, end to end (real cut files, the stand-in picture editor)", () => {
  let vpm: typeof import("./videoPipeline");
  let bvr: typeof import("./beatVisualRelevance");
  let stockMod: typeof import("./youtubeShotStock");
  let fail: typeof import("./providerFailureClass");
  let dir: string;
  beforeAll(async () => {
    vpm = await import("./videoPipeline");
    bvr = await import("./beatVisualRelevance");
    stockMod = await import("./youtubeShotStock");
    fail = await import("./providerFailureClass");
    dir = fsP.mkdtempSync(pathP.join(osP.tmpdir(), "fastvid-p2-"));
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());

  const video = (file: string, seconds: number) => {
    if (!fsP.existsSync(file)) execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=gray:s=64x36:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    return file;
  };
  const downloads: string[] = [];
  async function stock(filmId: number, ids: string[], shots = 3, shotSec = 6) {
    stockMod.startYoutubeShotStock(
      filmId,
      ids.map((videoId) => ({ videoId, title: `title ${videoId}`, durationSec: 60, serves: 1 })),
      {
        workDir: dir,
        download: async (id, _s, _d, out) => {
          downloads.push(`${filmId}:${id}`);
          return fsP.existsSync(video(out, shotSec * shots));
        },
        cut: async (file) =>
          Array.from({ length: shots }, (_, i) => ({ path: video(`${file}.shot${i}.mp4`, shotSec), startSec: i * shotSec, endSec: (i + 1) * shotSec })),
        startFor: () => 0,
        log: () => {},
      }
    );
    await stockMod.youtubeStockSettled(filmId);
  }
  function state(sentences: number) {
    return {
      lateYoutubeCandidates: [] as string[],
      beatRelevance: bvr.createBeatRelevanceLedger(),
      beatImageGate: { judgementAttempts: 0, judgementsFits: 0, judgementsMismatch: 0 },
      visionReviewPool: { beats: new Map() },
      usedContentKeys: new Set<string>(),
      sourcingCache: vpm.createSourcingCache(643),
      sceneBeatsBySceneIndex: new Map([[0, Array.from({ length: sentences }, (_, index) => ({ index, text: `Open sentence ${index}.`, holdSec: 4, keywords: [] as string[] }))]]),
    };
  }
  type St = ReturnType<typeof state>;
  const videoOf = (d: St, p: string) => d.sourcingCache.lineage.resolve(p)?.providerAssetId ?? null;
  /** One look per unjudged moment, spent on the sentence like the real gate; FIT when `fits` says so. */
  const editor = (d: St, fits: (b: number, id: string | null) => boolean) =>
    vi.fn(async (beat: { index: number }, _s: number, paths: string[]) => {
      for (const p of paths) {
        const k = bvr.beatRelevanceBeatKey(0, beat.index, "path", p);
        if (d.beatRelevance.byBeat.has(k)) continue;
        d.beatRelevance.spendByBeat.set(`s0b${beat.index}`, (d.beatRelevance.spendByBeat.get(`s0b${beat.index}`) ?? 0) + 1);
        d.beatImageGate.judgementAttempts++;
        const ok = fits(beat.index, videoOf(d, p));
        d.beatRelevance.byBeat.set(k, { decision: { verdict: ok ? "fits" : "does_not_fit", evaluated: true } } as never);
        if (ok) {
          d.beatImageGate.judgementsFits++;
          vpm.noteApprovedPickForBeat(d, 0, beat.index, vpm.clipContentKey(p));
          return p;
        }
        d.beatImageGate.judgementsMismatch++;
      }
      return null;
    });
  const stage = (filmId: number, d: St, look: ReturnType<typeof editor>, ids: string[], serves: (id: string, b: number) => boolean = () => false) =>
    vpm.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], [{ clips: [], beatDurations: [], clipBeatIndices: [] }], look, { windowMs: 20, looksMs: 20_000 }, {
      videoIds: ids,
      serves: (id, _s, beat) => serves(id, beat.index),
      moments: (beat, sceneIndex, vids) => vpm.takeLateStockMoments(filmId, d, sceneIndex, beat, vids, dir),
    });

  it("five videos (two ready before the pictures), three open sentences: spread, each offered once, no download, looks within 5 per sentence", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const filmId = 64301;
    await stock(filmId, ["before_0001", "before_0002"]);
    const since = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    await stock(filmId, ["after_00001", "after_00002", "after_00003"]);
    const downloadsBefore = downloads.length;
    const d = state(3);
    const offer = vpm.lateStockToOffer(filmId, d as never, since);
    expect(offer.videoIds.sort()).toEqual(["after_00001", "after_00002", "after_00003", "before_0001", "before_0002"]);
    expect(offer.line).toContain("readyBeforePictures=2 readyAfter=3");
    const look = editor(d, () => false);
    await stage(filmId, d, look, offer.videoIds);
    /** every sentence looked, none twice */
    expect(look.mock.calls.map((c) => (c[0] as { index: number }).index).sort()).toEqual([0, 1, 2]);
    const perSentence = look.mock.calls.map((c) => new Set((c[2] as string[]).map((p) => videoOf(d, p))));
    /** no sentence holds more than two videos (5 looks ÷ 3 moments), the first sentence is not the dump */
    for (const vids of perSentence) expect(vids.size).toBeLessThanOrEqual(2);
    expect(perSentence.reduce((n, v) => n + v.size, 0)).toBe(5);
    /** each video offered to ONE sentence; every moment file once */
    const all = perSentence.flatMap((v) => [...v]);
    expect(new Set(all).size).toBe(all.length);
    const files = look.mock.calls.flatMap((c) => c[2] as string[]);
    expect(new Set(files).size).toBe(files.length);
    /** the Judge's ceilings: ≤ 5 per sentence, and every look counted */
    for (let b = 0; b < 3; b++) expect(d.beatRelevance.spendByBeat.get(`s0b${b}`) ?? 0).toBeLessThanOrEqual(5);
    expect(d.beatImageGate.judgementAttempts).toBe([...d.beatRelevance.spendByBeat.values()].reduce((a, b) => a + b, 0));
    /** nothing searched or downloaded */
    expect(downloads.length).toBe(downloadsBefore);
    /** and none of them offered again */
    expect(vpm.lateStockToOffer(filmId, d as never, since).videoIds).toEqual([]);
    stockMod.releaseYoutubeShotStock(filmId);
  }, 60_000);

  it("a MISMATCH in one sentence's turn does not hold the video's other shots from another sentence; the refused shot is not offered again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const filmId = 64302;
    await stock(filmId, ["shared_0001"]);
    /** sentence 0's own turn was handed the first shot (@0 s) and refused it */
    const handed = await stockMod.takeStockShots(filmId, "shared_0001", 0, (s) => s.sourceStartSec !== 0, 1);
    expect(handed.shots.map((s) => s.sourceStartSec)).toEqual([0]);
    const d = state(2);
    const offer = vpm.lateStockToOffer(filmId, d as never, 0);
    expect(offer.videoIds).toEqual(["shared_0001"]);
    expect(offer.line).toContain("withShotsOfferedBefore=1");
    const look = editor(d, (b) => b === 1);
    /** only sentence 1 is open: it gets the two shots sentence 0 never saw */
    await vpm.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], [{ clips: [], beatDurations: [], clipBeatIndices: [0] }], look, { windowMs: 20, looksMs: 20_000 }, {
      videoIds: offer.videoIds,
      serves: () => false,
      moments: (beat, sceneIndex, vids) => vpm.takeLateStockMoments(filmId, d, sceneIndex, beat, vids, dir),
    });
    expect(look).toHaveBeenCalledTimes(1);
    expect((look.mock.calls[0]![0] as { index: number }).index).toBe(1);
    const tags = (look.mock.calls[0]![2] as string[]).map((p) => /_(t\d+d\d+)__pid_/.exec(pathP.basename(p))?.[1]);
    expect(tags.length).toBe(2);
    expect(tags.some((t) => t?.startsWith("t0d"))).toBe(false);
    stockMod.releaseYoutubeShotStock(filmId);
  }, 60_000);

  it("permanently unusable stock (on-screen text or black in every shot, or under 3 s) is not offered; a video already in the film is not offered", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const filmId = 64303;
    await stock(filmId, ["textEvery01", "inFilm00001", "goodVideo01"]);
    await stock(filmId, ["tooShort001"], 2, 2);
    for (const start of [0, 6, 12]) fail.noteYoutubeFragmentRefusal(vpm.youtubeFragmentKeyFor("textEvery01", start, 4), start === 6 ? "mostly_black" : "baked_edit_text_before_vision");
    const d = state(1);
    d.usedContentKeys.add(vpm.providerAssetKey("youtube_cc", "inFilm00001"));
    const offer = vpm.lateStockToOffer(filmId, d as never, 0);
    expect(offer.videoIds).toEqual(["goodVideo01"]);
    expect(offer.line).toContain("skipped={");
    expect(offer.line).toContain("no_usable_shot:refused_fragment=1");
    expect(offer.line).toContain("no_usable_shot:too_short=1");
    expect(offer.line).toContain("in_film=1");
    stockMod.releaseYoutubeShotStock(filmId);
  }, 60_000);

  it("a sentence with one look left gets one: the late stock never lifts the Judge's per-sentence ceiling", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const filmId = 64304;
    await stock(filmId, ["oneLook0001"]);
    const d = state(1);
    d.beatRelevance.spendByBeat.set("s0b0", 4);
    const look = editor(d, () => false);
    await stage(filmId, d, look, vpm.lateStockToOffer(filmId, d as never, 0).videoIds);
    expect(d.beatRelevance.spendByBeat.get("s0b0")).toBe(5);
    expect((look.mock.calls[0]![2] as string[]).length).toBe(1);
    stockMod.releaseYoutubeShotStock(filmId);
  }, 60_000);

  /* ── FIX 2 — one claim per video, late downloads in this round, nothing after the render ── */

  it("FIX 2 — a video's late take is claimed once: a second take finds nothing, even with shots still unhanded", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const filmId = 64311;
    await stock(filmId, ["fiveShots01"], 5);
    const d = state(2);
    const first = await vpm.takeLateStockMoments(filmId, d, 0, { index: 0, text: "x" }, ["fiveShots01"], dir);
    expect(first.length).toBe(3);
    /** two of its five shots were never handed — still, the video is not taken (or offered) a second time */
    expect(stockMod.stockVideoState(filmId, "fiveShots01")).toEqual({ status: "ready", offered: true });
    expect(await vpm.takeLateStockMoments(filmId, d, 0, { index: 1, text: "y" }, ["fiveShots01"], dir)).toEqual([]);
    expect(vpm.lateStockToOffer(filmId, d as never, 0).videoIds).toEqual([]);
    expect(stockMod.claimLateStock(filmId, "fiveShots01")).toBe(false);
    stockMod.releaseYoutubeShotStock(filmId);
  }, 60_000);

  it("FIX 2 — two sentences' takes started together on the same five-shot video: one gets it, the other nothing, no file twice", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const filmId = 64312;
    await stock(filmId, ["fiveShots02"], 5);
    const d = state(3);
    const takes = await Promise.all([0, 1, 2].map((b) => vpm.takeLateStockMoments(filmId, d, 0, { index: b, text: `s${b}` }, ["fiveShots02"], dir)));
    const nonEmpty = takes.filter((t) => t.length > 0);
    expect(nonEmpty.length).toBe(1);
    expect(nonEmpty[0]!.length).toBeLessThanOrEqual(3);
    expect(new Set(takes.flat()).size).toBe(takes.flat().length);
    stockMod.releaseYoutubeShotStock(filmId);
  }, 60_000);

  it("FIX 2 — a stock download that finishes while the review window runs is offered in this round", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const filmId = 64313;
    let finish!: () => void;
    const arrives = new Promise<void>((r) => (finish = r));
    stockMod.startYoutubeShotStock(filmId, [{ videoId: "lateArrive1", title: "late", durationSec: 60, serves: 1 }], {
      workDir: dir,
      download: async (_id, _s, _d, out) => {
        await arrives;
        return fsP.existsSync(video(out, 18));
      },
      cut: async (file) => Array.from({ length: 3 }, (_, i) => ({ path: video(`${file}.shot${i}.mp4`, 6), startSec: i * 6, endSec: (i + 1) * 6 })),
      startFor: () => 0,
      log: () => {},
    });
    const d = state(1);
    /** a review of s0b0 is still running: the window waits for it, and the download lands meanwhile */
    vpm.noteReviewInFlight(d, vpm.youtubeTurnKey(0, 0), new Promise((r) => setTimeout(r, 400)));
    setTimeout(finish, 50);
    expect(vpm.lateStockToOffer(filmId, d as never, 0).videoIds).toEqual([]);
    const look = editor(d, () => false);
    await vpm.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], [{ clips: [], beatDurations: [], clipBeatIndices: [] }], look, { windowMs: 2_000, looksMs: 20_000 }, {
      videoIds: () => vpm.lateStockToOffer(filmId, d as never, 0).videoIds,
      serves: () => false,
      moments: (beat, sceneIndex, vids) => vpm.takeLateStockMoments(filmId, d, sceneIndex, beat, vids, dir),
    });
    expect(look).toHaveBeenCalledTimes(1);
    expect((look.mock.calls[0]![2] as string[]).every((p) => videoOf(d, p) === "lateArrive1")).toBe(true);
    stockMod.releaseYoutubeShotStock(filmId);
  }, 60_000);

  it("FIX 2 — after the render released its stock nothing can be claimed or offered; failed stock is never offered", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const filmId = 64314;
    await stock(filmId, ["readyVideo1"]);
    stockMod.startYoutubeShotStock(filmId, [{ videoId: "failedVid01", title: "f", durationSec: 60, serves: 1 }], {
      workDir: dir, download: async () => false, cut: async () => [], startFor: () => 0, log: () => {},
    });
    await stockMod.youtubeStockSettled(filmId);
    const d = state(1);
    expect(vpm.lateStockToOffer(filmId, d as never, 0).videoIds).toEqual(["readyVideo1"]);
    stockMod.releaseYoutubeShotStock(filmId);
    expect(stockMod.claimLateStock(filmId, "readyVideo1")).toBe(false);
    expect(vpm.lateStockToOffer(filmId, d as never, 0).videoIds).toEqual([]);
    expect(await vpm.takeLateStockMoments(filmId, d, 0, { index: 0, text: "x" }, ["readyVideo1"], dir)).toEqual([]);
  }, 60_000);

  it("FIX 1 — end to end: a targeted stock video whose sentence has no opening is not handed to s0b0", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const filmId = 64315;
    stockMod.startYoutubeShotStock(
      filmId,
      [{ videoId: "kendallVid1", title: "Kendall Jenner", durationSec: 60, serves: 1, targetLabel: 'subject="Kendall Jenner" search=#2' }],
      {
        workDir: dir,
        download: async (_id, _s, _d, out) => fsP.existsSync(video(out, 18)),
        cut: async (file) => Array.from({ length: 3 }, (_, i) => ({ path: video(`${file}.shot${i}.mp4`, 6), startSec: i * 6, endSec: (i + 1) * 6 })),
        startFor: () => 0,
        log: () => {},
      }
    );
    await stockMod.youtubeStockSettled(filmId);
    expect(stockMod.stockVideoTargeted(filmId, "kendallVid1")).toBe(true);
    const d = state(2);
    const look = editor(d, () => false);
    /** the pool could not be read: nothing serves — the destination is lost, not s0b0 */
    await vpm.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], [{ clips: [], beatDurations: [], clipBeatIndices: [] }], look, { windowMs: 20, looksMs: 20_000 }, {
      videoIds: ["kendallVid1"],
      serves: () => false,
      targeted: (id) => stockMod.stockVideoTargeted(filmId, id),
      moments: (beat, sceneIndex, vids) => vpm.takeLateStockMoments(filmId, d, sceneIndex, beat, vids, dir),
    });
    expect(look).not.toHaveBeenCalled();
    expect(stockMod.stockVideoState(filmId, "kendallVid1")).toEqual({ status: "ready", offered: false });
    expect(lines.some((l) => l.includes("[LateStock] video=kendallVid1 targeted"))).toBe(true);
    stockMod.releaseYoutubeShotStock(filmId);
  }, 60_000);
});

/* ═══════════════════════ P3 — the last Judge round, bounded ═══════════════════════ */

describe("P3 — the last looks: three at once, reserved against 120, the budget from executed looks", () => {
  let vpm: typeof import("./videoPipeline");
  let bvr: typeof import("./beatVisualRelevance");
  let jb: typeof import("./judgeBudget");
  let dir: string;
  beforeAll(async () => {
    vpm = await import("./videoPipeline");
    bvr = await import("./beatVisualRelevance");
    jb = await import("./judgeBudget");
    dir = fsP.mkdtempSync(pathP.join(osP.tmpdir(), "fastvid-p3-"));
  }, 60_000);
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let seq = 0;
  function sentences(n: number, momentsEach = 5) {
    const d = {
      lateYoutubeCandidates: [] as string[],
      beatRelevance: bvr.createBeatRelevanceLedger(),
      beatImageGate: { judgementAttempts: 0, judgementsFits: 0, judgementsMismatch: 0 },
      visionReviewPool: { beats: new Map() },
      usedContentKeys: new Set<string>(),
      sceneBeatsBySceneIndex: new Map([[0, Array.from({ length: n }, (_, index) => ({ index, text: `S${index}.`, holdSec: 4, keywords: [] as string[] }))]]),
    };
    vpm.openLatePlacement(d, 0, async () => ({ hold: 4 }));
    vpm.markSceneClosed(d, 0);
    for (let b = 0; b < n; b++) {
      for (let k = 0; k < momentsEach; k++) {
        const p = pathP.join(dir, `scene_0_ytfu_${b}m${k}_t${100 + 60 * k}d40__pid_youtube_cc-${(seq++).toString(16).padStart(16, "0")}.mp4`);
        fsP.writeFileSync(p, "m");
        vpm.noteLookaheadCandidateReady(d, vpm.youtubeTurnKey(0, b), p);
      }
    }
    return d;
  }
  type D = ReturnType<typeof sentences>;
  /** Judges like the real gate: one spend on the sentence and one render attempt per unjudged moment. */
  const judge = (d: D, b: number, paths: string[], fit: (p: string) => boolean = () => false): string | null => {
    for (const p of paths) {
      const k = bvr.beatRelevanceBeatKey(0, b, "path", p);
      if (!d.beatRelevance.byBeat.has(k)) {
        d.beatRelevance.spendByBeat.set(`s0b${b}`, (d.beatRelevance.spendByBeat.get(`s0b${b}`) ?? 0) + 1);
        d.beatImageGate.judgementAttempts++;
        if (fit(p)) d.beatImageGate.judgementsFits++;
        else d.beatImageGate.judgementsMismatch++;
        d.beatRelevance.byBeat.set(k, { decision: { verdict: fit(p) ? "fits" : "does_not_fit", evaluated: true } } as never);
      }
      if (fit(p)) {
        vpm.noteApprovedPickForBeat(d, 0, b, vpm.clipContentKey(p));
        return p;
      }
    }
    return null;
  };
  const stage = (d: D, look: (beat: { index: number }, s: number, paths: string[]) => Promise<string | null>, limits: Record<string, unknown>) =>
    vpm.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], [{ clips: [], beatDurations: [], clipBeatIndices: [] }], look, { windowMs: 10, ...limits });

  it("stuck looks give up their place after one turn: with all three places stuck the others are still judged, the stuck ones named", async () => {
    const d = sentences(5);
    const look = vi.fn(async (beat: { index: number }, _s: number, paths: string[]) => {
      if (beat.index < 3) return new Promise<string | null>(() => {});
      await sleep(10);
      return judge(d, beat.index, paths);
    });
    const budget = jb.createJudgeBudget({ baseMs: 300, perLookMs: 20, ceilingMs: 3_000 });
    const t0 = Date.now();
    await stage(d, look, { budget, slotMs: 30 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(look.mock.calls.map((c) => (c[0] as { index: number }).index).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(d.beatImageGate.judgementAttempts).toBe(10);
    for (const b of [0, 1, 2]) expect(vpm.judgeBudgetExhaustedFor(d, 0, b)).toBe(true);
    expect(lines.some((l) => l.includes("s0b0 review still running when the picture editor's own budget"))).toBe(true);
    expect(lines.some((l) => l.includes("stop=JUDGE_BUDGET_EXHAUSTED") && l.includes("notReviewed=[s0b0,s0b1,s0b2]"))).toBe(true);
  });

  it("FIX 3 — a render cancelled during a look starts no second round of that look (the 3 s rule's retry)", async () => {
    const { execFileSync } = await import("child_process");
    const d = sentences(1, 0);
    const short = (k: number) => {
      const p = pathP.join(dir, `scene_0_ytfu_0m${k}_t${100 + 60 * k}d20__pid_youtube_cc-${(9000 + seq++).toString(16).padStart(16, "0")}.mp4`);
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x36:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", p]);
      vpm.noteLookaheadCandidateReady(d, vpm.youtubeTurnKey(0, 0), p);
      return p;
    };
    short(0);
    short(1);
    let cancelled = false;
    const look = vi.fn(async (beat: { index: number }, _s: number, paths: string[]) => {
      cancelled = true;
      /** a FIT on a 2 s clip: refused by the 3 s rule, which would try the next moment */
      return judge(d, beat.index, paths.slice(0, 1), () => true);
    });
    const budget = jb.createJudgeBudget({ baseMs: 10_000, perLookMs: 0, ceilingMs: 10_000, stopWhen: () => cancelled });
    await stage(d, look, { budget });
    expect(look).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.includes("s0b0 not looked at — reason=RENDER_CANCELLED"))).toBe(true);
  });

  it("a cancelled render starts nothing more and does not wait for a look that never returns", async () => {
    const d = sentences(9);
    let cancelled = false;
    const look = vi.fn(async () => {
      cancelled = true;
      return new Promise<string | null>(() => {});
    });
    const budget = jb.createJudgeBudget({ baseMs: 60_000, perLookMs: 20, ceilingMs: 60_000, stopWhen: () => cancelled });
    const t0 = Date.now();
    await stage(d, look, { budget, slotMs: 20 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    /** the three that had a place started before the cancel was seen; nothing after it */
    expect(look.mock.calls.length).toBeLessThanOrEqual(3);
    await sleep(80);
    expect(look.mock.calls.length).toBeLessThanOrEqual(3);
    expect(lines.some((l) => l.includes("stop=RENDER_CANCELLED"))).toBe(true);
    expect(lines.some((l) => /last look not started — the render was cancelled first/.test(l))).toBe(true);
    const tally = lines.find((l) => l.startsWith("[FinalLooks]"))!;
    expect(tally).toMatch(/queued=9 started=\d skipped=\d/);
  });

  it("looks not started because the budget ended never start later and buy nothing; the budget equals the executed looks", async () => {
    const d = sentences(9);
    const look = vi.fn(async (beat: { index: number }, _s: number, paths: string[]) => {
      await sleep(60);
      return judge(d, beat.index, paths);
    });
    const budget = jb.createJudgeBudget({ baseMs: 100, perLookMs: 0, ceilingMs: 100 });
    await stage(d, look, { budget });
    await sleep(250);
    /** two waves of three started inside 100 ms; the third wave never did */
    expect(look).toHaveBeenCalledTimes(6);
    expect(budget.looks).toBe(d.beatImageGate.judgementAttempts);
    expect(d.beatImageGate.judgementAttempts).toBe(30);
    const tally = lines.find((l) => l.startsWith("[FinalLooks]"))!;
    expect(tally).toContain("sentences queued=9 started=6 skipped=0 notStarted=3");
    /** the three still waiting were named as never started, not as reviews that ran out */
    expect(lines.filter((l) => l.includes("last look not started")).length).toBe(3);
  });

  /* ── FIX 3 — supersede, late FIT, and the frame extractors ── */

  it("FIX 3 — a SUPERSEDED render (its run abandoned) starts nothing more and does not wait for a look that never returns", async () => {
    const { runWithActiveVideoId, throwIfActiveRenderCancelled } = await import("./videoGenerationCancel");
    const d = sentences(9);
    const run = { abandoned: false };
    const look = vi.fn(async () => {
      run.abandoned = true;
      return new Promise<string | null>(() => {});
    });
    const t0 = Date.now();
    await runWithActiveVideoId(96_401, async () => {
      const budget = jb.createJudgeBudget({
        baseMs: 60_000,
        perLookMs: 20,
        ceilingMs: 60_000,
        stopWhen: () => {
          try {
            throwIfActiveRenderCancelled();
            return false;
          } catch {
            return true;
          }
        },
      });
      await stage(d, look, { budget, slotMs: 20 });
    }, null, run);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(look.mock.calls.length).toBeLessThanOrEqual(3);
    await sleep(80);
    expect(look.mock.calls.length).toBeLessThanOrEqual(3);
    expect(lines.some((l) => l.includes("stop=RENDER_CANCELLED"))).toBe(true);
  });

  it("FIX 3 — a FIT that arrives after the film was assembled is not placed and not silent: named, counted as IN_REVIEW, the assembled scene untouched", async () => {
    const d = sentences(1);
    const placer = vi.fn(async () => ({ hold: 4 }));
    vpm.openLatePlacement(d, 0, placer);
    let fitNow!: () => void;
    const verdict = new Promise<void>((r) => (fitNow = r));
    const look = vi.fn(async (beat: { index: number }, _s: number, paths: string[]) => {
      await verdict;
      return judge(d, beat.index, paths, (p) => p === paths[0]);
    });
    const budget = jb.createJudgeBudget({ baseMs: 50, perLookMs: 0, ceilingMs: 50 });
    await stage(d, look, { budget });
    /** the stage ended on its budget; the film is assembled */
    expect(await vpm.placeApprovedAfterSceneClosed(d, 0, { sceneReturned: true, final: true })).toEqual([]);
    fitNow();
    await sleep(30);
    expect(placer).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("approved after the film was assembled — not placed (JUDGE_BUDGET_EXHAUSTED)"))).toBe(true);
    const check = vpm.formatFitPlacementCheck(d, [{ sceneIndex: 0, beatIndex: 0 }], () => 0);
    expect(check[0]).toBe("[FitPlacement] TOTAL approvedRealShots=1 placedRealShots=0 lost=1 causes={IN_REVIEW=1}");
  });

  it("FIX 3 — ten last looks never ask more than three frame extractions at once (the extractors' own width)", async () => {
    const d = sentences(10);
    let active = 0;
    let most = 0;
    const look = vi.fn(async (beat: { index: number }, _s: number, paths: string[]) => {
      active++;
      most = Math.max(most, active);
      await sleep(20);
      active--;
      return judge(d, beat.index, paths);
    });
    await stage(d, look, { budget: jb.createJudgeBudget({ baseMs: 5_000, perLookMs: 0, ceilingMs: 5_000 }) });
    expect(look).toHaveBeenCalledTimes(10);
    expect(most).toBe(vpm.FINAL_LOOK_CONCURRENCY);
    expect(vpm.FINAL_LOOK_CONCURRENCY).toBe(3);
  });

  it("two sentences side by side with 3 render looks left: the first reserves them, the second plans none — 120 never passed", async () => {
    const d = sentences(2);
    d.beatImageGate.judgementAttempts = 117;
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    const lookA = vpm.finalReadyYoutubeLook(d as never, 0, 0, async (paths) => {
      await gateOpen;
      return judge(d, 0, paths);
    });
    await sleep(5);
    expect(vpm.finalLooksOutstanding(d as never)).toBe(3);
    const lookB = vpm.finalReadyYoutubeLook(d as never, 0, 1, async (paths) => judge(d, 1, paths));
    expect(await lookB).toBeNull();
    release();
    await lookA;
    expect(d.beatImageGate.judgementAttempts).toBe(120);
    expect(d.beatRelevance.spendByBeat.get("s0b1")).toBeUndefined();
    expect(lines.some((l) => l.includes("s0b1 not looked at — reason=FILM_LOOK_CEILING"))).toBe(true);
    expect(vpm.finalLooksOutstanding(d as never)).toBe(0);
  });

  it("a look's reservation shrinks as it spends: another sentence can plan what it no longer holds", async () => {
    const d = sentences(2);
    d.beatImageGate.judgementAttempts = 110;
    let step!: () => void;
    let stepped = new Promise<void>((r) => (step = r));
    const lookA = vpm.finalReadyYoutubeLook(d as never, 0, 0, async (paths) => {
      /** judges two of its five, then waits */
      judge(d, 0, paths.slice(0, 2));
      await stepped;
      return judge(d, 0, paths);
    });
    await sleep(5);
    expect(vpm.finalLooksOutstanding(d as never)).toBe(3);
    step();
    await lookA;
    stepped = Promise.resolve();
    expect(vpm.finalLooksOutstanding(d as never)).toBe(0);
    expect(d.beatImageGate.judgementAttempts).toBe(115);
  });
});

/* ═══════════════════════ P4 — every lost FIT explained, or UNRECORDED ═══════════════════════ */

describe("P4 — [FitPlacement] explains in-scene losses too", () => {
  let vpm: typeof import("./videoPipeline");
  let jb: typeof import("./judgeBudget");
  beforeAll(async () => {
    vpm = await import("./videoPipeline");
    jb = await import("./judgeBudget");
  }, 60_000);
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  const clip = (b: number, k: number) => `/w/scene_0_ytfu_${b}m${k}_t${100 + k * 60}d40__pid_youtube_cc-${(b * 10 + k).toString(16).padStart(16, "0")}.mp4`;
  const approve = (d: object, b: number, k: number) => vpm.noteApprovedPickForBeat(d, 0, b, vpm.clipContentKey(clip(b, k)));
  /** A render's state with the one rejection registry every push refusal writes to. */
  const render = async () => ({ rejections: (await import("./rejectionRegistry")).createRejectionRegistry() });

  it("classes every recorded reason; a reason it cannot prove is UNRECORDED", () => {
    expect(vpm.fitLossCause("push:duplicate_clip_once_per_video")).toBe("DUPLICATE");
    expect(vpm.fitLossCause("push:archive not ready (not archived)")).toBe("PLACEMENT_RULE");
    expect(vpm.fitLossCause("push:IRRELEVANT_TO_BEAT")).toBe("PLACEMENT_RULE");
    expect(vpm.fitLossCause("refused at the push (reason logged by [PushTrace])")).toBe("PLACEMENT_RULE");
    expect(vpm.fitLossCause("extra FIT not placed by the late placement (reason logged above)")).toBe("PLACEMENT_RULE");
    expect(vpm.fitLossCause("approved after scene closed — not placed: the sentence already has its picture")).toBe("NO_TIME_LEFT");
    expect(vpm.fitLossCause("approved after scene closed — not placed")).toBe("LIMIT");
    expect(vpm.fitLossCause("approved, prepared 2.40s < 3s (3 s rule)")).toBe("TECHNICAL");
    expect(vpm.fitLossCause("technical check refused the approved picture: mostly_black")).toBe("TECHNICAL");
    expect(vpm.fitLossCause(jb.JUDGE_BUDGET_EXHAUSTED)).toBe("IN_REVIEW");
    expect(vpm.fitLossCause(vpm.REVIEW_TIMEOUT_BEFORE_FINALIZE)).toBe("IN_REVIEW");
    expect(vpm.fitLossCause("the sentence's ladder failed: boom")).toBe("UNRECORDED");
    expect(vpm.fitLossCause("approved picture never reached the scene — the sentence's ladder settled without a clip")).toBe("UNRECORDED");
  });

  it("643's case: a sentence WITH a picture loses a second approved shot at the push inside its scene — named, not UNRECORDED", async () => {
    const d = await render();
    approve(d, 0, 0);
    approve(d, 0, 1);
    /** the second approved shot was refused at the push as a repeat of footage already in the film */
    vpm.refuseAtPushForTest(d, clip(0, 1), 0, 0, "duplicate");
    /** and again by another door: the same clip is one loss */
    vpm.refuseAtPushForTest(d, clip(0, 1), 0, 0, "duplicate");
    const lines = vpm.formatFitPlacementCheck(d, [{ sceneIndex: 0, beatIndex: 0 }], () => 1, () => new Set([vpm.clipContentKey(clip(0, 0))]));
    expect(lines[0]).toBe("[FitPlacement] TOTAL approvedRealShots=2 placedRealShots=1 lost=1 causes={DUPLICATE=1}");
    expect(lines[1]).toContain("lost=1");
    expect(lines[1]).toContain("causes={DUPLICATE=1}");
  });

  it("a refusal of a picture that was NOT approved for this sentence is no loss of an approval", async () => {
    const d = await render();
    approve(d, 0, 0);
    vpm.refuseAtPushForTest(d, clip(0, 5), 0, 0, "duplicate");
    expect(vpm.formatFitPlacementCheck(d, [{ sceneIndex: 0, beatIndex: 0 }], () => 0)).toEqual([
      "[FitPlacement] TOTAL approvedRealShots=1 placedRealShots=0 lost=1 causes={UNRECORDED=1}",
      "[FitPlacement] s0b0 approved=1 placed=0 lost=1 reason=UNRECORDED causes={UNRECORDED=1}",
    ]);
  });

  it("a refused picture that is in the film after all is not counted against the sentence", async () => {
    const d = await render();
    approve(d, 0, 0);
    approve(d, 0, 1);
    vpm.refuseAtPushForTest(d, clip(0, 0), 0, 0, "archive");
    /** clip 0 got in by another door; clip 1 is the one missing, and nothing recorded why */
    const lines = vpm.formatFitPlacementCheck(d, [{ sceneIndex: 0, beatIndex: 0 }], () => 1, () => new Set([vpm.clipContentKey(clip(0, 0))]));
    expect(lines[0]).toBe("[FitPlacement] TOTAL approvedRealShots=2 placedRealShots=1 lost=1 causes={UNRECORDED=1}");
  });

  it("several losses on several sentences: one class per lost picture, the total adds up, nothing twice, nothing silent", async () => {
    const d = await render();
    for (const [b, n] of [[0, 3], [1, 2], [2, 1], [3, 2]] as const) for (let k = 0; k < n; k++) approve(d, b, k);
    /** s0: 3 approved, 1 placed: one push refusal (the archive rule at the montage boundary) + the 3 s rule */
    vpm.refuseAtPushForTest(d, clip(0, 1), 0, 0, "archive");
    vpm.notePlacementLoss(d, 0, 0, "approved, prepared 2.40s < 3s (3 s rule)");
    /** s1: 2 approved, 0 placed: approved after the close, and its review was cut off by the budget */
    vpm.noteApprovedNotPlaced(d, 0, 1, "approved after scene closed — not placed");
    vpm.noteJudgeBudgetExhausted(d, 0, 1);
    /** s2: 1 approved, 0 placed: the late placement found the sentence already had its picture */
    vpm.noteApprovedNotPlaced(d, 0, 2, "approved after scene closed — not placed: the sentence already has its picture");
    /** s3: 2 approved, 1 placed, nothing recorded */
    const placed: Record<number, number> = { 0: 1, 1: 0, 2: 0, 3: 1 };
    const lines = vpm.formatFitPlacementCheck(d, [0, 1, 2, 3].map((b) => ({ sceneIndex: 0, beatIndex: b })), (_s, b) => placed[b]!);
    expect(lines[0]).toBe(
      "[FitPlacement] TOTAL approvedRealShots=8 placedRealShots=2 lost=6 causes={PLACEMENT_RULE=1 NO_TIME_LEFT=1 LIMIT=1 TECHNICAL=1 IN_REVIEW=1 UNRECORDED=1}"
    );
    expect(lines.find((l) => l.includes(" s0b0 "))).toContain("causes={PLACEMENT_RULE=1 TECHNICAL=1}");
    expect(lines.find((l) => l.includes(" s0b1 "))).toContain("causes={LIMIT=1 IN_REVIEW=1}");
    expect(lines.find((l) => l.includes(" s0b2 "))).toContain("causes={NO_TIME_LEFT=1}");
    expect(lines.find((l) => l.includes(" s0b3 "))).toContain("causes={UNRECORDED=1}");
    /** the classes add up to the loss on every line */
    for (const l of lines) {
      const lost = Number(/lost=(\d+)/.exec(l)![1]);
      const sum = [...(l.match(/causes=\{([^}]*)\}/)?.[1] ?? "").matchAll(/=(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
      expect(sum, l).toBe(lost);
    }
  });

  it("more recorded facts than losses never count a picture twice", async () => {
    const d = await render();
    approve(d, 0, 0);
    approve(d, 0, 1);
    vpm.refuseAtPushForTest(d, clip(0, 0), 0, 0, "duplicate");
    vpm.notePlacementLoss(d, 0, 0, "approved, prepared 2.40s < 3s (3 s rule)");
    vpm.noteApprovedNotPlaced(d, 0, 0, "approved after scene closed — not placed");
    const lines = vpm.formatFitPlacementCheck(d, [{ sceneIndex: 0, beatIndex: 0 }], () => 1);
    expect(lines[0]).toBe("[FitPlacement] TOTAL approvedRealShots=2 placedRealShots=1 lost=1 causes={DUPLICATE=1}");
  });

  it("the chain line reads the check's totals and the lifecycle's own counts; UNKNOWN when either is missing", () => {
    const d = {};
    approve(d, 0, 0);
    vpm.formatFitPlacementCheck(d, [{ sceneIndex: 0, beatIndex: 0 }], () => 1);
    const yt = {
      youtubeTracked: 20, youtubeContentKeyNotAssetIdentity: 0,
      youtubeVisionFitForThisBeat: 3, youtubeAdopted: 3, youtubeCinematicSelected: 2, youtubeRenderInput: 2, youtubeFinalVideo: 2,
      youtubeVanishedAfterAdoption: 0, youtubeDownstreamGap: 1,
    };
    expect(vpm.formatFitChainLine(vpm.fitPlacementTotals(d), yt, 21)).toBe(
      "[FitChain] all sources: judgedMoments=21 approvedMoments=1 placedShots=1 | youtube rows: FIT=3 ADOPTED=3 TIMELINE=2 RENDER=2 FINAL_VIDEO=2 vanishedAfterAdoption=0 downstreamGap=1"
    );
    expect(vpm.formatFitChainLine(null, null)).toBe("[FitChain] all sources: judgedMoments=UNKNOWN approvedMoments=UNKNOWN placedShots=UNKNOWN | youtube rows: UNKNOWN");
    /** FIX 4 — 643: every row CONTENT_KEY_NOT_ASSET_IDENTITY, lifecycle FIT 0 next to three real FITs: UNKNOWN, not 0 */
    const in643 = { ...yt, youtubeContentKeyNotAssetIdentity: 20, youtubeVisionFitForThisBeat: 0 };
    const line = vpm.formatFitChainLine({ approved: 3, placed: 2 }, in643, 21);
    expect(line).toContain("approvedMoments=3 placedShots=2");
    expect(line).toContain("FIT=UNKNOWN(20 of 20 rows not linked to their verdict)");
    expect(line).not.toContain("FIT=0");
  });

  it("wired: the push records an approved picture's refusal; the pipeline passes the placed keys and prints the chain", async () => {
    const fsP = await import("fs");
    const pathP = await import("path");
    const PIPE = fsP.readFileSync(pathP.join(__dirname, "videoPipeline.ts"), "utf8");
    const trace = PIPE.slice(PIPE.indexOf("function tracePushOutcome("), PIPE.indexOf("function tracePushOutcome(") + 1500);
    expect(trace).toContain("if (!accepted && beatIndex != null) notePushLossOfApproved(dedup, sceneIndex, beatIndex, clipContentKey(clipPath), reason);");
    expect(PIPE).toContain("for (const line of formatFitPlacementCheck(visualDedup, allSentences, realShotsOf, realShotKeysOf)) console.log(line);");
    expect(PIPE).toContain('console.log(pipelineReport.add("summary", formatFitChainLine(fitPlacementTotals(visualDedup), totals, visualDedup.beatImageGate?.judgementAttempts ?? null)));');
  });
});

describe("P3 — the budget's refund keeps its floor and its ceiling", () => {
  it("refund never goes below zero looks; granted time stays between base and the hard ceiling", async () => {
    const jb = await import("./judgeBudget");
    let t = 0;
    const b = jb.createJudgeBudget({ baseMs: 100, perLookMs: 50, ceilingMs: 400, now: () => t });
    b.grant(5);
    expect(b.grantedMs()).toBe(250);
    b.refund(3);
    expect(b.looks).toBe(2);
    expect(b.grantedMs()).toBe(100);
    b.refund(10);
    expect(b.looks).toBe(0);
    b.grant(100);
    expect(b.grantedMs()).toBe(400);
    b.refund(-4);
    b.refund(Number.NaN);
    expect(b.looks).toBe(100);
    t = 500;
    expect(b.leftMs()).toBeLessThanOrEqual(0);
  });
});
