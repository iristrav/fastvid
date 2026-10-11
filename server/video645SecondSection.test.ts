import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { pickLongVideoStartSec, pickSecondSectionStartSec } from "./beatSegmentChoice";
import { maxRelevanceLooksPerBeat } from "./beatVisualRelevance";
import { createJudgeBudget } from "./judgeBudget";
import {
  acquireTunelioSource,
  dropTunelioSources,
  keptTunelioSource,
  resetTunelioStateForTests,
  TUNELIO_SOURCE_TTL_MS,
  type TunelioDeps,
} from "./tunelioDownloader";
import { youtubeMomentsPerVideo } from "./youtubeMoments";
import {
  addStockSection,
  claimLateStock,
  releaseYoutubeShotStock,
  startYoutubeShotStock,
  STOCK_SECTION_SEC,
  stockSectionStarts,
  stockVideoState,
  stockedVideoIds,
  unofferedReadyStock,
  youtubeStockSettled,
} from "./youtubeShotStock";

/**
 * VIDEO 645 — A SECOND SECTION FROM A VIDEO ALREADY DOWNLOADED.
 *
 * 645 fetched eleven YouTube videos — nine of them whole, via Tunelio, 10 credits each — and cut ONE
 * 40 s section from every one: 40 candidate moments, 14 under 3 s, 10 without evidence, 19 refused by
 * the picture editor, 5 fits. When a section's moments were refused the video was spent: the stock had
 * nothing more to hand out, the sentence got a card, and the rest of the source sat on disk until the
 * 45 min sweep. One video (8_lfxPI5ObM) gave five shots, none usable, and was never offered at all.
 *
 * The fix: when a sentence's last looks end without a fit, one more section is cut from the KEPT
 * source (no request, no credits, no transfer), at a point clear of the sections already cut, scanned
 * into shots with the stock's own cutter, added to the video's stock, and handed to the sentence
 * through the same late-moment route to the same picture editor inside the same budget. Bounded:
 * once per video, at most `lateVideosPerSentence` cuts per sentence, `SECOND_SECTIONS_PER_RENDER`
 * per render, none once the budget is spent.
 */

type VP = typeof import("./videoPipeline");
type BVRM = typeof import("./beatVisualRelevance");
let vp: VP;
let bvr: BVRM;
let dir: string;
const FILM = 645_002;
beforeAll(async () => {
  vp = await import("./videoPipeline");
  bvr = await import("./beatVisualRelevance");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-645-second-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  releaseYoutubeShotStock(FILM);
  dropTunelioSources();
  resetTunelioStateForTests();
});

const PIPE = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const flat = (file: string, seconds: number): string => {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=gray:s=64x36:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  return file;
};
/** A source whose picture changes every six seconds: the real shot cutter finds the cuts. */
const colourSource = (file: string, seconds: number): string => {
  const colours = ["red", "blue", "green", "yellow", "white"];
  const inputs = colours.flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=64x36:d=6,format=yuv420p`]);
  const loops = Math.ceil(seconds / 30);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", `[0][1][2][3][4]concat=n=5:v=1:a=0,loop=loop=${loops}:size=750:start=0[v]`, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", String(seconds), file]);
  return file;
};

/* ═══════════════════════ the pieces: where, from what, into which stock ═══════════════════════ */

describe("pickSecondSectionStartSec — another point in the same video, clear of the sections already cut", () => {
  it("a 212 s video (645's typical Tunelio source): the second section does not overlap the first and stays inside the body", () => {
    const first = pickLongVideoStartSec(212.4, STOCK_SECTION_SEC, "qIF8gAZbvuM");
    const second = pickSecondSectionStartSec(212.4, STOCK_SECTION_SEC, "qIF8gAZbvuM", [first]);
    expect(second).not.toBeNull();
    expect(Math.abs(second! - first)).toBeGreaterThanOrEqual(STOCK_SECTION_SEC);
    expect(second!).toBeGreaterThanOrEqual(0);
    expect(second! + STOCK_SECTION_SEC).toBeLessThanOrEqual(212.4);
    /** deterministic: the same video gets the same second section every time */
    expect(pickSecondSectionStartSec(212.4, STOCK_SECTION_SEC, "qIF8gAZbvuM", [first])).toBe(second);
  });

  it("a third section is clear of BOTH earlier ones, or there is none — never one that overlaps", () => {
    for (const id of ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8"]) {
      const taken: number[] = [pickLongVideoStartSec(300, STOCK_SECTION_SEC, id)];
      for (let i = 0; i < 3; i++) {
        const s = pickSecondSectionStartSec(300, STOCK_SECTION_SEC, id, taken);
        if (s == null) break;
        for (const t of taken) expect(Math.abs(s - t)).toBeGreaterThanOrEqual(STOCK_SECTION_SEC);
        expect(s + STOCK_SECTION_SEC).toBeLessThanOrEqual(300);
        taken.push(s);
      }
    }
  });

  it("a video with room for one section only has no second: 60 s, 79 s, a non-number, a zero take", () => {
    expect(pickSecondSectionStartSec(60, STOCK_SECTION_SEC, "x", [10])).toBeNull();
    expect(pickSecondSectionStartSec(79.9, STOCK_SECTION_SEC, "x", [0])).toBeNull();
    expect(pickSecondSectionStartSec(Number.NaN, STOCK_SECTION_SEC, "x", [])).toBeNull();
    expect(pickSecondSectionStartSec(300, 0, "x", [])).toBeNull();
  });

  it("when the hash keeps landing on taken ground the slot after the last section is used, if it fits", () => {
    /** 100 s, sections at 0 and 40 cover the body's hash range; the slot after is 80 — but 80+40 > 100, so none */
    expect(pickSecondSectionStartSec(100, STOCK_SECTION_SEC, "x", [0, 40, 60])).toBeNull();
    /** 160 s with 0 and 40 taken: whatever the hash says, the answer is clear of both */
    const s = pickSecondSectionStartSec(160, STOCK_SECTION_SEC, "x", [0, 40]);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThanOrEqual(80);
  });
});

describe("keptTunelioSource — the whole video Tunelio delivered, named without any new request", () => {
  const KEY = "tk_test_secret_0123456789";
  const GOOD_URL = "https://cdn.tunelio.dev/tunnel/abc123?sig=xyz";
  let clock = 1_000_000;
  const calls: string[] = [];
  const deps = (file: string, durationSec: number): TunelioDeps => ({
    env: { TUNELIO_API_KEY: KEY, TUNELIO_ENABLED: "true" },
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const body = url.includes("/credits")
        ? { credits: 100 }
        : { status: "ok", url: GOOD_URL, filename: "v.mp4", quality: "720p", mode: "video", file_size: fs.statSync(file).size };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    download: async (_url, outPath) => {
      fs.copyFileSync(file, outPath);
      return { ok: true, status: 200, bytes: fs.statSync(file).size };
    },
    probe: async () => ({ width: 64, height: 36, durationSec, hasAudio: true }),
    lookup: async () => ["203.0.113.10"],
    now: () => clock,
    sourceDir: dir,
    log: () => {},
  });

  it("nothing kept → null; after one paid fetch the source is kept and named; gone after the TTL or when the file is deleted", async () => {
    clock = 1_000_000;
    calls.length = 0;
    expect(keptTunelioSource("vidKept01", clock)).toBeNull();
    const src = colourSource(path.join(dir, "kept-src.mp4"), 30);
    const got = await acquireTunelioSource("vidKept01", deps(src, 212.4), { timeoutMs: 30_000 });
    expect(got.ok).toBe(true);
    const kept = keptTunelioSource("vidKept01", clock);
    expect(kept).not.toBeNull();
    expect(kept!.durationSec).toBe(212.4);
    expect(fs.existsSync(kept!.path)).toBe(true);
    const creates = calls.filter((u) => u.includes("/create")).length;
    expect(creates).toBe(1);
    /** naming it is not fetching it */
    keptTunelioSource("vidKept01", clock);
    keptTunelioSource("vidKept01", clock);
    expect(calls.filter((u) => u.includes("/create")).length).toBe(1);
    /** the file deleted under it: null, not a stale path */
    fs.rmSync(kept!.path);
    expect(keptTunelioSource("vidKept01", clock)).toBeNull();
    /** past the TTL: swept, null */
    const again = await acquireTunelioSource("vidKept02", deps(src, 100), { timeoutMs: 30_000 });
    expect(again.ok).toBe(true);
    expect(keptTunelioSource("vidKept02", clock)).not.toBeNull();
    expect(keptTunelioSource("vidKept02", clock + TUNELIO_SOURCE_TTL_MS + 1)).toBeNull();
  });
});

describe("addStockSection — a later section's shots join the video's stock", () => {
  async function stockOne(videoId: string, pieces: Array<{ path: string; startSec: number; endSec: number }>, durationSec = 212.4) {
    const workDir = path.join(dir, `stock-${videoId}`);
    fs.mkdirSync(workDir, { recursive: true });
    startYoutubeShotStock(FILM, [{ videoId, title: `Video ${videoId}`, durationSec, serves: 1 }], {
      workDir,
      download: async (_id, _start, _dur, outPath) => {
        fs.writeFileSync(outPath, "x");
        return true;
      },
      cut: async () => pieces,
      startFor: (d, take, id) => pickLongVideoStartSec(d, take, id),
      log: () => {},
    });
    await youtubeStockSettled(FILM);
    return workDir;
  }

  it("645's 8_lfxPI5ObM replayed: a video whose only section gave no usable shot is 'failed' — a second section makes it ready, with its own shots, for the late take", async () => {
    await stockOne("lfx8", []);
    expect(stockVideoState(FILM, "lfx8")?.status).toBe("failed");
    expect(stockedVideoIds(FILM)).toEqual(["lfx8"]);
    const first = stockSectionStarts(FILM, "lfx8");
    expect(first).toHaveLength(1);
    const added = addStockSection(FILM, "lfx8", 150, [
      { path: "/tmp/s2/shot_1.mp4", startSec: 0, endSec: 5.5 },
      { path: "/tmp/s2/shot_2.mp4", startSec: 6, endSec: 11 },
    ]);
    expect(added).toBe(2);
    expect(stockVideoState(FILM, "lfx8")?.status).toBe("ready");
    expect(stockSectionStarts(FILM, "lfx8")).toEqual([first![0], 150]);
    const unoffered = unofferedReadyStock(FILM).find((x) => x.videoId === "lfx8");
    expect(unoffered?.shots.map((s) => [s.sourceStartSec, s.sourceEndSec, s.handedOut])).toEqual([
      [150, 155.5, 0],
      [156, 161, 0],
    ]);
    expect(unoffered?.shots.every((s) => s.title === "Video lfx8")).toBe(true);
    /** the late take may claim it once for these shots — and once only */
    expect(claimLateStock(FILM, "lfx8")).toBe(true);
    expect(claimLateStock(FILM, "lfx8")).toBe(false);
  });

  it("a video already claimed by the late take is free to be claimed once more for the NEW shots; the old shots keep their hand-out count", async () => {
    await stockOne("vidA", [{ path: "/tmp/s1/shot_1.mp4", startSec: 0, endSec: 4 }]);
    expect(claimLateStock(FILM, "vidA")).toBe(true);
    expect(claimLateStock(FILM, "vidA")).toBe(false);
    expect(addStockSection(FILM, "vidA", 120, [{ path: "/tmp/s2/shot_1.mp4", startSec: 1, endSec: 5 }])).toBe(1);
    expect(claimLateStock(FILM, "vidA")).toBe(true);
    expect(unofferedReadyStock(FILM)).toEqual([]);
  });

  it("nothing joins a video the film does not stock, a pending one, or a section without pieces", async () => {
    expect(addStockSection(FILM, "unknown", 10, [{ path: "/x.mp4", startSec: 0, endSec: 4 }])).toBe(0);
    await stockOne("vidB", [{ path: "/tmp/s1/shot_1.mp4", startSec: 0, endSec: 4 }]);
    expect(addStockSection(FILM, "vidB", 120, [])).toBe(0);
    expect(stockSectionStarts(FILM, "vidB")).toHaveLength(1);
    expect(stockVideoState(FILM, "vidB")?.status).toBe("ready");
  });
});

/* ═══════════════════ the helper: a real cut of a real kept source, no download ═══════════════════ */

describe("secondSectionFromKeptSource — one more section from the file on disk", () => {
  const KEY = "tk_test_secret_0123456789";
  const keep = async (videoId: string, file: string, durationSec: number) => {
    const d: TunelioDeps = {
      env: { TUNELIO_API_KEY: KEY, TUNELIO_ENABLED: "true" },
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        const body = url.includes("/credits")
          ? { credits: 100 }
          : { status: "ok", url: "https://cdn.tunelio.dev/tunnel/abc123?sig=xyz", filename: "v.mp4", quality: "720p", mode: "video", file_size: fs.statSync(file).size };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      download: async (_url, outPath) => {
        fs.copyFileSync(file, outPath);
        return { ok: true, status: 200, bytes: fs.statSync(file).size };
      },
      probe: async () => ({ width: 64, height: 36, durationSec, hasAudio: true }),
      lookup: async () => ["203.0.113.10"],
      sourceDir: dir,
      log: () => {},
    };
    const got = await acquireTunelioSource(videoId, d, { timeoutMs: 30_000 });
    expect(got.ok).toBe(true);
  };
  const stockWithFirstSection = async (videoId: string, durationSec: number, firstStart: number) => {
    const workDir = path.join(dir, `work-${videoId}`);
    fs.mkdirSync(workDir, { recursive: true });
    startYoutubeShotStock(FILM, [{ videoId, title: `Video ${videoId}`, durationSec, serves: 1 }], {
      workDir,
      download: async (_id, _start, _dur, outPath) => {
        fs.writeFileSync(outPath, "x");
        return true;
      },
      cut: async () => [{ path: path.join(workDir, "first_shot.mp4"), startSec: 0, endSec: 2.5 }],
      startFor: () => firstStart,
      log: () => {},
    });
    await youtubeStockSettled(FILM);
    return workDir;
  };

  it("nothing kept (the yt-dlp route fetched the section only): 'no_kept_source', nothing is cut and nothing is fetched", async () => {
    const workDir = await stockWithFirstSection("noKept", 212, 20);
    const out = await vp.secondSectionFromKeptSource(FILM, "noKept", workDir);
    expect(out).toEqual({ shots: 0, detail: "no_kept_source" });
    expect(fs.readdirSync(workDir).filter((f) => f.includes("_s2"))).toEqual([]);
    expect(stockSectionStarts(FILM, "noKept")).toEqual([20]);
  });

  it("a kept source that is not in the film's stock: 'not_stocked'", async () => {
    const src = colourSource(path.join(dir, "unstocked.mp4"), 30);
    await keep("unstocked", src, 212);
    const out = await vp.secondSectionFromKeptSource(FILM, "unstocked", dir);
    expect(out).toEqual({ shots: 0, detail: "not_stocked" });
  });

  it("a kept source with room for one section only: 'no_room_in_source', no cut", async () => {
    const src = colourSource(path.join(dir, "short.mp4"), 30);
    await keep("shortOne", src, 70);
    const workDir = await stockWithFirstSection("shortOne", 70, 10);
    const out = await vp.secondSectionFromKeptSource(FILM, "shortOne", workDir);
    expect(out).toEqual({ shots: 0, detail: "no_room_in_source" });
    expect(fs.readdirSync(workDir).filter((f) => f.includes("_s2"))).toEqual([]);
  });

  it("645 replayed with a real source: the second section is cut from the kept file at a point clear of the first, scanned by the real shot cutter, and its shots join the stock — no request, no credits", async () => {
    const src = colourSource(path.join(dir, "real-src.mp4"), 120);
    const fetchSpy = vi.fn();
    await keep("realOne", src, 120);
    const workDir = await stockWithFirstSection("realOne", 120, 12);
    const creditsBefore = fs.readdirSync(dir).length;
    const out = await vp.secondSectionFromKeptSource(FILM, "realOne", workDir);
    expect(out.shots).toBeGreaterThan(0);
    expect(out.detail).toBe(`${out.shots}_shots`);
    expect(out.startSec).toBeDefined();
    expect(Math.abs(out.startSec! - 12)).toBeGreaterThanOrEqual(STOCK_SECTION_SEC);
    expect(out.startSec! + STOCK_SECTION_SEC).toBeLessThanOrEqual(120 + 0.01);
    /** the shots are real files, inside the second section's seconds of the source */
    const stock = unofferedReadyStock(FILM).find((x) => x.videoId === "realOne");
    expect(stock).toBeDefined();
    const fresh = stock!.shots.filter((s) => s.path.includes("_shots_s2"));
    expect(fresh.length).toBe(out.shots);
    for (const s of fresh) {
      expect(fs.existsSync(s.path)).toBe(true);
      expect(s.sourceStartSec).toBeGreaterThanOrEqual(out.startSec! - 0.01);
      expect(s.sourceEndSec).toBeLessThanOrEqual(out.startSec! + STOCK_SECTION_SEC + 0.5);
      expect(s.handedOut).toBe(0);
    }
    expect(stockSectionStarts(FILM, "realOne")).toEqual([12, out.startSec]);
    /** the kept source is still there and was not fetched again; no network was touched at all */
    expect(keptTunelioSource("realOne")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir).length).toBe(creditsBefore);
    /** a third call for the same video: another clear section or none — never the same start twice */
    const third = await vp.secondSectionFromKeptSource(FILM, "realOne", workDir);
    if (third.shots > 0) expect(third.startSec).not.toBe(out.startSec);
    else expect(third.detail).toBe("no_room_in_source");
  }, 120_000);

  it("pinned: the helper reads the kept source and the stock's own cutter — it never asks a download route or Tunelio for anything", () => {
    const src = PIPE();
    const fn = src.slice(src.indexOf("export async function secondSectionFromKeptSource("), src.indexOf("export async function downloadYouTubeCCClip("));
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).toContain("keptTunelioSource(videoId)");
    expect(fn).toContain("pickSecondSectionStartSec(kept.durationSec, STOCK_SECTION_SEC, videoId, taken)");
    expect(fn).toContain("cutTunelioWindow(kept.path, outPath, startSec, STOCK_SECTION_SEC, kept.durationSec)");
    expect(fn).toContain("cutLocalVideoIntoShots(outPath, pieceDir, await productionLocalShotCutter())");
    expect(fn).toContain("addStockSection(filmId, videoId, cut.start, list)");
    for (const forbidden of ["acquireTunelioSource", "downloadYouTubeCCClip", "fetch(", "downloadToFile", "ytdlp"]) expect(fn).not.toContain(forbidden);
  });
});

/* ═══════════════════ the stage: when, for whom, how often — through the same editor ═══════════════════ */

describe("runFinalReadyYoutubeStage — a second section after a sentence's looks end without a fit", () => {
  const sentence = (index: number, text: string) => ({ index, text, holdSec: 3.5, keywords: [] as string[], searchQuery: "", powerWord: "" });
  function dedupFor(sentences: Array<{ sceneIndex: number; beats: ReturnType<typeof sentence>[] }>) {
    return {
      lateYoutubeCandidates: [] as string[],
      beatRelevance: bvr.createBeatRelevanceLedger(),
      beatImageGate: { judgementAttempts: 0 },
      visionReviewPool: { beats: new Map() },
      usedContentKeys: new Set<string>(),
      sourcingCache: vp.createSourcingCache(FILM),
      sceneBeatsBySceneIndex: new Map(sentences.map((s) => [s.sceneIndex, s.beats])),
    };
  }
  type D = ReturnType<typeof dedupFor>;
  const hashOf = (id: string) => Buffer.from(id.padEnd(8, "_")).toString("hex").slice(0, 16).padEnd(16, "0");
  const videoOfPath = (ids: string[], p: string) => ids.find((id) => path.basename(p).includes(`__pid_youtube_cc-${hashOf(id)}`)) ?? null;
  /** a moment's section: the first section's moments are `…m<n>_t1xx…`, a second section's `…m<n>_t5xx…` */
  const sectionOfPath = (p: string): 1 | 2 => (/_t5\d\d/.test(path.basename(p)) ? 2 : 1);
  const cap = Math.max(1, Math.ceil(maxRelevanceLooksPerBeat() / youtubeMomentsPerVideo()));

  /**
   * The late stock of the test. Every id has one 4 s shot of its FIRST section; `secondSection.cut`
   * gives `secondShots(id)` more, and after it `moments` hands out a moment of the second section.
   */
  function lateStockOf(
    ids: string[],
    opts: {
      serves?: (id: string, beatIndex: number) => boolean;
      candidates?: (beatIndex: number) => string[];
      secondShots?: (id: string) => number;
      secondDetail?: (id: string) => string;
    } = {}
  ) {
    const momentCalls: string[][] = [];
    const cutCalls: string[] = [];
    const cutDone = new Set<string>();
    let n = 0;
    const file = (sceneIndex: number, beatIndex: number, id: string, section: 1 | 2) =>
      flat(path.join(dir, `scene_${sceneIndex}_ytfu_late${beatIndex}m${n++}_t${(section === 1 ? 100 : 500) + n}d40__pid_youtube_cc-${hashOf(id)}.mp4`), 4);
    return {
      momentCalls,
      cutCalls,
      videoIds: ids,
      serves: (id: string, _s: number, beat: { index: number }) => opts.serves?.(id, beat.index) ?? true,
      targeted: () => false,
      moments: async (beat: { index: number }, sceneIndex: number, wanted: string[]) => {
        momentCalls.push([...wanted]);
        return wanted.map((id) => file(sceneIndex, beat.index, id, cutDone.has(id) ? 2 : 1));
      },
      secondSection: {
        candidates: (_sceneIndex: number, beat: { index: number }) => opts.candidates?.(beat.index) ?? ids,
        cut: async (id: string) => {
          cutCalls.push(id);
          const shots = opts.secondShots?.(id) ?? 2;
          if (shots > 0) cutDone.add(id);
          return { shots, detail: opts.secondDetail?.(id) ?? (shots ? `${shots}_shots` : "no_room_in_source"), ...(shots ? { startSec: 150 } : {}) };
        },
      },
    };
  }
  /** The picture editor of the test: `fits(videoId, section)` decides; every verdict recorded like the real one. */
  function editor(d: D, ids: string[], fits: (id: string | null, section: 1 | 2) => boolean) {
    return vi.fn(async (beat: { index: number }, sceneIndex: number, paths: string[]) => {
      for (const p of paths) {
        d.beatImageGate.judgementAttempts++;
        const ok = fits(videoOfPath(ids, p), sectionOfPath(p));
        d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(sceneIndex, beat.index, "path", p), { decision: { verdict: ok ? "fits" : "does_not_fit", evaluated: true } } as never);
        if (ok) {
          vp.noteApprovedPickForBeat(d, sceneIndex, beat.index, vp.clipContentKey(p));
          return p;
        }
      }
      return null;
    });
  }
  const results = () => [{ clips: [] as string[], beatDurations: [] as number[], clipBeatIndices: [] as number[] }];
  const quiet = () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    return logs;
  };

  it("SCENARIO 1+2+4 — 645's s1b1 replayed: the first section's moment is refused; a second section of the SAME video is cut, its moment handed to the sentence, approved by the editor and placed while the scene is open", async () => {
    const logs = quiet();
    const ids = ["teslaFactory"];
    const d = dedupFor([{ sceneIndex: 1, beats: [sentence(1, "Inside the factory, robots assemble the cars.")] }]);
    const stock = lateStockOf(ids);
    const look = editor(d, ids, (_id, section) => section === 2);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 1 }], results(), look, { windowMs: 50, looksMs: 20_000 }, stock);
    /** the first look saw the first section only and refused it … */
    expect(look).toHaveBeenCalledTimes(2);
    expect((look.mock.calls[0]![2] as string[]).every((p) => sectionOfPath(p) === 1)).toBe(true);
    /** … then ONE second section was cut from the same video, no other video, no download … */
    expect(stock.cutCalls).toEqual(["teslaFactory"]);
    expect(stock.momentCalls).toEqual([["teslaFactory"], ["teslaFactory"]]);
    expect(logs.some((l) => l.startsWith("[SecondSection] s1b1 video=teslaFactory") && l.includes("2_shots @150s") && l.includes("no download"))).toBe(true);
    /** … and its moment went to the same editor, who approved it: placed for this sentence */
    const second = look.mock.calls[1]![2] as string[];
    expect(second.some((p) => sectionOfPath(p) === 2 && videoOfPath(ids, p) === "teslaFactory")).toBe(true);
    expect(vp.approvedPicksForBeat(d as never, 1, 1)).toBe(1);
  });

  it("SCENARIO 3 — the same fragment is not offered again: a refused first-section moment is never re-handed, and a video's second section is cut once per render even when two sentences lack a fit", async () => {
    quiet();
    const ids = ["onlyOne"];
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "First sentence."), sentence(1, "Second sentence.")] }]);
    const stock = lateStockOf(ids);
    const look = editor(d, ids, () => false);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results(), look, { windowMs: 50, looksMs: 30_000 }, stock);
    expect(stock.cutCalls).toEqual(["onlyOne"]);
    /** no sentence sees the same moment twice (another sentence may still judge it for itself, as before) */
    const seen = look.mock.calls.flatMap((c) => (c[2] as string[]).map((p) => `${(c[0] as { index: number }).index}:${p}`));
    expect(new Set(seen).size).toBe(seen.length);
    /** the second section's moments: handed out exactly once */
    const second = look.mock.calls.flatMap((c) => (c[2] as string[]).filter((p) => sectionOfPath(p) === 2));
    expect(second.length).toBeGreaterThan(0);
    expect(new Set(second).size).toBe(second.length);
    expect(vp.approvedPicksForBeat(d as never, 0, 0)).toBe(0);
    expect(vp.approvedPicksForBeat(d as never, 0, 1)).toBe(0);
  });

  it("SCENARIO 5 — no fit in the second section either: the sentence ends without a picture, the stage ends, nothing loops (the card fallback follows as before)", async () => {
    const logs = quiet();
    const ids = ["noFit"];
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "A sentence nothing fits.")] }]);
    const stock = lateStockOf(ids);
    const look = editor(d, ids, () => false);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results(), look, { windowMs: 50, looksMs: 20_000 }, stock);
    expect(stock.cutCalls).toEqual(["noFit"]);
    expect(look).toHaveBeenCalledTimes(2);
    expect(vp.approvedPicksForBeat(d as never, 0, 0)).toBe(0);
    expect(logs.some((l) => l.includes("[SecondSection] s0b0 video=noFit"))).toBe(true);
  });

  it("SCENARIO 5b — a source with no room, or a second section without a usable shot, is passed over: no moment is asked for it, the next candidate is tried within the per-sentence cap", async () => {
    quiet();
    const ids = ["noRoom", "noShot", "good", "spare"];
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "A sentence.")] }]);
    const stock = lateStockOf(ids, {
      candidates: () => ["noRoom", "noShot", "good", "spare"],
      secondShots: (id) => (id === "good" || id === "spare" ? 2 : 0),
      secondDetail: (id) => (id === "noRoom" ? "no_room_in_source" : id === "noShot" ? "no_usable_shot:no_clean_shot" : "2_shots"),
    });
    const look = editor(d, ids, (_id, section) => section === 2);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results(), look, { windowMs: 50, looksMs: 20_000 }, stock);
    /** at most `cap` cuts for one sentence — and the render cap — whatever they yield */
    expect(stock.cutCalls.length).toBeLessThanOrEqual(Math.min(cap, vp.SECOND_SECTIONS_PER_RENDER));
    expect(stock.cutCalls.slice(0, 2)).toEqual(["noRoom", "noShot"].slice(0, stock.cutCalls.length));
    /** nothing was asked for a video that gave no shots */
    const secondRoundMoments = stock.momentCalls.slice(1);
    expect(secondRoundMoments.every((m) => !m.includes("noRoom") && !m.includes("noShot"))).toBe(true);
  });

  it("SCENARIO 1b — a first look that finds a fit asks for no second section at all", async () => {
    quiet();
    const ids = ["fitsFirst"];
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "A sentence.")] }]);
    const stock = lateStockOf(ids);
    const look = editor(d, ids, () => true);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results(), look, { windowMs: 50, looksMs: 20_000 }, stock);
    expect(stock.cutCalls).toEqual([]);
    expect(look).toHaveBeenCalledTimes(1);
    expect(vp.approvedPicksForBeat(d as never, 0, 0)).toBe(1);
  });

  it("SCENARIO 6 — no double downloads, no paid calls: the stage's only extra act is `secondSection.cut`, and the pipeline wires that to the kept-source helper", () => {
    const src = PIPE();
    const stage = src.slice(src.indexOf("export async function runFinalReadyYoutubeStage("), src.indexOf("export function formatFinalLookTally("));
    const round = stage.slice(stage.indexOf("const secondSectionRound = async"), stage.indexOf("/** STEP 0 — every sentence queued"));
    expect(round.length).toBeGreaterThan(200);
    expect(round).toContain("await second.cut(id)");
    expect(round).toContain("await lateStock.moments(beat, sceneIndex, [id])");
    expect(round).toContain("noteYoutubeAssigned(dedup, youtubeTurnKey(sceneIndex, beatIndex), moments)");
    expect(round).toContain("await finalReadyYoutubeLook(dedup, sceneIndex, beatIndex, (ready) => look(beat, sceneIndex, ready), undefined, inventory?.(beat, sceneIndex))");
    for (const forbidden of ["acquireTunelioSource", "downloadYouTubeCCClip", "fetchYouTube", "searchYoutube", "startYoutubeShotStock"]) expect(round).not.toContain(forbidden);
    /** the wiring: stocked videos that serve the sentence, are not in the film, and have a kept source; the cut is the kept-source helper */
    const wiringStart = src.indexOf("/** VIDEO 645 — one more section from a stocked video's kept source");
    const wiring = src.slice(wiringStart, src.indexOf("cut: (id) => secondSectionFromKeptSource(videoId, id, workDir)", wiringStart) + 80);
    expect(wiringStart).toBeGreaterThan(src.indexOf("export async function runFinalReadyYoutubeStage("));
    expect(wiring).toContain("stockedVideoIds(videoId).filter(");
    expect(wiring).toContain('!providerAssetAlreadyUsed(visualDedup.usedContentKeys, visualDedup.sourcingCache, "youtube_cc", id)');
    expect(wiring).toContain("keptTunelioSource(id) != null");
    expect(wiring).toContain("r.servesBeat === true");
    expect(wiring).toContain("cut: (id) => secondSectionFromKeptSource(videoId, id, workDir)");
    /** the round runs after the first look AND the extra targeted round both ended without a fit */
    expect(stage).toContain("const extra = first == null ? await extraTargetedStockRound(sceneIndex, beatIndex, beat) : first;");
    expect(stage).toContain("if (extra == null) await secondSectionRound(sceneIndex, beatIndex, beat);");
  });

  it("SCENARIO 7a — the picture editor's budget binds: with the budget spent no second section is cut", async () => {
    quiet();
    const ids = ["late"];
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "A sentence.")] }]);
    const stock = lateStockOf(ids);
    let t = 0;
    const budget = createJudgeBudget({ baseMs: 1_000, ceilingMs: 1_000, now: () => t });
    const look = vi.fn(async (beat: { index: number }, sceneIndex: number, paths: string[]) => {
      for (const p of paths) {
        d.beatImageGate.judgementAttempts++;
        d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(sceneIndex, beat.index, "path", p), { decision: { verdict: "does_not_fit", evaluated: true } } as never);
      }
      /** the first look used up the whole budget */
      t = 5_000;
      return null;
    });
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results(), look, { windowMs: 50, looksMs: 20_000, budget }, stock);
    expect(look).toHaveBeenCalledTimes(1);
    expect(stock.cutCalls).toEqual([]);
  });

  it("SCENARIO 7b — the render cap binds: four sentences without a fit, four candidates — exactly SECOND_SECTIONS_PER_RENDER cuts, each video once", async () => {
    quiet();
    expect(vp.SECOND_SECTIONS_PER_RENDER).toBe(3);
    const ids = ["v1", "v2", "v3", "v4"];
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "One."), sentence(1, "Two."), sentence(2, "Three."), sentence(3, "Four.")] }]);
    /** each sentence's own candidate; the first assignment gives every video to one sentence */
    const stock = lateStockOf(ids, { candidates: (beatIndex) => [ids[beatIndex]!] });
    const look = editor(d, ids, () => false);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results(), look, { windowMs: 50, looksMs: 30_000, slotMs: 30_000 }, stock);
    expect(stock.cutCalls.length).toBe(vp.SECOND_SECTIONS_PER_RENDER);
    expect(new Set(stock.cutCalls).size).toBe(stock.cutCalls.length);
  });

  it("SCENARIO 7c — the per-sentence cap binds: five candidates that all give shots, every one refused — at most ceil(looks per sentence / moments per video) cuts for the one sentence", async () => {
    quiet();
    const ids = ["c1", "c2", "c3", "c4", "c5"];
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "One.")] }]);
    const stock = lateStockOf(ids, { candidates: () => ids });
    const look = editor(d, ids, () => false);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results(), look, { windowMs: 50, looksMs: 30_000, slotMs: 30_000 }, stock);
    expect(stock.cutCalls.length).toBeLessThanOrEqual(Math.min(cap, vp.SECOND_SECTIONS_PER_RENDER));
    expect(stock.cutCalls.length).toBeGreaterThan(0);
  });

  it("without `secondSection` wired (another caller of the stage) nothing changes: no cut, one look", async () => {
    quiet();
    const ids = ["plain"];
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "A sentence.")] }]);
    const { secondSection: _unused, ...stock } = lateStockOf(ids);
    void _unused;
    const look = editor(d, ids, () => false);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results(), look, { windowMs: 50, looksMs: 20_000 }, stock);
    expect(look).toHaveBeenCalledTimes(1);
    expect(stock.cutCalls).toEqual([]);
  });
});
