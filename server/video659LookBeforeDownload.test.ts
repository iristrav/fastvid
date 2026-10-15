/**
 * VIDEO 659 — ONE LOOK PER YOUTUBE VIDEO, BEFORE ANYTHING IS DOWNLOADED.
 *
 * The owner: "Kunnen we er niet voor zorgen dat voor een beeld wordt gedownload, hij echt gecheckt is
 * of het past? En dat op een goedkope manier." — "Je mag ook uit 1 beeldcontrole. Dus 1 youtube
 * heeeeel veel beelden knippen."
 *
 * Proven here: the storyboard arithmetic, the transcript hits, the sheet's seconds, the one look and
 * how its answer is read, the sections that are downloaded, the stock that downloads only those (and
 * nothing when nothing fits), and the approval that spares the sentence a second look.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import { afterEach, describe, expect, it } from "vitest";

import {
  chooseSheetSeconds,
  clearSheetApprovals,
  composeSheetWithFfmpeg,
  lookBeforeDownload,
  MAX_SECTIONS,
  sharpCandidateSeconds,
  SHARP_MAX_FRAMES,
  MAX_SECTION_TOTAL_SEC,
  parseSheetAnswer,
  parseYoutubeMomentKey,
  rememberSheetApprovals,
  sheetApprovalFor,
  SHEET_MAX_FRAMES,
  storyboardFrameAt,
  transcriptHits,
  transcriptSegmentsFromJson3,
  windowsAroundApprovals,
  type SheetDeps,
  type Storyboard,
} from "./youtubePreviewSheet";
import { releaseYoutubeShotStock, startYoutubeShotStock, takeStockShots, youtubeStockSettled, type StockDeps } from "./youtubeShotStock";
import { seedSheetApproval } from "./videoPipeline";

const FFMPEG = (ffmpegStatic as unknown as string) || "ffmpeg";
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** A 10-minute video, 160×90 frames, 5×5 per sprite, 25 frames per 120 s sprite (one every 4.8 s). */
const SB: Storyboard = {
  durationSec: 600,
  width: 160,
  height: 90,
  rows: 5,
  columns: 5,
  fragments: Array.from({ length: 5 }, (_, j) => ({ url: `https://i.ytimg.com/sb/x/L2/M${j}.jpg`, durationSec: 120 })),
  captionUrl: "https://www.youtube.com/api/timedtext?v=x&fmt=json3",
};

const SENTENCES = [
  "The factory in Fremont started building the Model 3 in 2017.",
  "Elon Musk slept on the factory floor during production hell.",
  "Investors worried the company would run out of money.",
];

describe("the storyboard arithmetic", () => {
  it("finds the sprite and the cell for a second", () => {
    expect(storyboardFrameAt(SB, 0)).toEqual({ fragment: 0, x: 0, y: 0 });
    /** 4.8 s per frame: 10 s is frame 2 → column 2, row 0. */
    expect(storyboardFrameAt(SB, 10)).toEqual({ fragment: 0, x: 320, y: 0 });
    /** 130 s is frame 27 → sprite 1, cell 2. */
    expect(storyboardFrameAt(SB, 130)).toEqual({ fragment: 1, x: 320, y: 0 });
    /** 119 s is the last cell of the first sprite. */
    expect(storyboardFrameAt(SB, 119)).toEqual({ fragment: 0, x: 4 * 160, y: 4 * 90 });
  });
  it("answers null past the storyboard or for a nonsense second", () => {
    expect(storyboardFrameAt(SB, 601)).toBeNull();
    expect(storyboardFrameAt(SB, -1)).toBeNull();
    expect(storyboardFrameAt({ ...SB, fragments: [] }, 10)).toBeNull();
  });
});

describe("the transcript finds where a sentence's subject is spoken", () => {
  const json3 = {
    events: [
      { tStartMs: 5_000, segs: [{ utf8: "welcome back to the channel" }] },
      { tStartMs: 95_000, segs: [{ utf8: "this is the Fremont factory where the Model 3 " }, { utf8: "is built" }] },
      { tStartMs: 300_000, segs: [{ utf8: "Musk said he slept on the factory floor" }] },
      { tStartMs: 480_000, segs: [{ utf8: "investors feared they would run out of money" }] },
    ],
  };
  it("reads json3", () => {
    const segs = transcriptSegmentsFromJson3(json3);
    expect(segs).toHaveLength(4);
    expect(segs[1]).toEqual({ startSec: 95, text: "this is the Fremont factory where the Model 3 is built" });
    expect(transcriptSegmentsFromJson3({})).toEqual([]);
    expect(transcriptSegmentsFromJson3(null)).toEqual([]);
  });
  it("each sentence gets the seconds where its words are said, and nothing where they are not", () => {
    const hits = transcriptHits(transcriptSegmentsFromJson3(json3), SENTENCES);
    expect(hits[0]).toContain(95);
    expect(hits[1]).toContain(300);
    expect(hits[2]).toContain(480);
    expect(hits.flat()).not.toContain(5);
  });
});

describe("the seconds on the sheet", () => {
  it("transcript hits first (a moment after they are said), then an even spread — never the intro or outro", () => {
    const secs = chooseSheetSeconds(600, [95, 300]);
    expect(secs.length).toBe(SHEET_MAX_FRAMES);
    expect(secs).toContain(96.5);
    expect(secs).toContain(301.5);
    expect(Math.min(...secs)).toBeGreaterThanOrEqual(600 * 0.04);
    expect(Math.max(...secs)).toBeLessThanOrEqual(600 * 0.96);
    /** In order, and no two the same moment. */
    expect([...secs].sort((a, b) => a - b)).toEqual(secs);
    for (let i = 1; i < secs.length; i++) expect(secs[i]! - secs[i - 1]!).toBeGreaterThanOrEqual(3);
  });
  it("a short video gets as many frames as fit, an unknown length none", () => {
    expect(chooseSheetSeconds(60, []).length).toBeLessThanOrEqual(19);
    expect(chooseSheetSeconds(0, [10])).toEqual([]);
  });
});

describe("STEP 1 — the whole video is searched, minute 12 included", () => {
  it("a sentence spoken at 12:00 of a 20-minute video gets that moment on the sheet", () => {
    const segs = [
      { startSec: 30, text: "hello and welcome" },
      { startSec: 720, text: "Elon Musk slept on the factory floor during production" },
    ];
    const hits = transcriptHits(segs, SENTENCES);
    expect(hits[1]).toEqual([720]);
    const secs = chooseSheetSeconds(1200, hits.flat());
    expect(secs).toContain(721.5);
  });
});

describe("which candidates get a sharp frame", () => {
  it("every sentence first, then a second for each, never more than the cap", () => {
    const c = [
      { sec: 10, sentences: [0] }, { sec: 20, sentences: [0] }, { sec: 30, sentences: [0] },
      { sec: 40, sentences: [1] }, { sec: 50, sentences: [2] },
    ];
    expect(sharpCandidateSeconds(c, 3)).toEqual([10, 40, 50]);
    expect(sharpCandidateSeconds(c, 4)).toEqual([10, 20, 40, 50]);
    const many = Array.from({ length: 40 }, (_, i) => ({ sec: i * 10, sentences: [i % 5] }));
    expect(sharpCandidateSeconds(many)).toHaveLength(SHARP_MAX_FRAMES);
  });
});

describe("the one look's answer", () => {
  it("is held to the sheet it was shown: unknown frames and sentences are dropped, duplicates once", () => {
    const raw = JSON.stringify({
      frames: [
        { frame: 1, depicts: "assembly line", sentences: [0, 7] },
        { frame: 1, depicts: "again", sentences: [1] },
        { frame: 99, depicts: "not on the sheet", sentences: [0] },
        { frame: 2, depicts: "presenter", sentences: [] },
      ],
    });
    expect(parseSheetAnswer(raw, 4, 3)).toEqual([
      { frame: 1, depicts: "assembly line", sentences: [0] },
      { frame: 2, depicts: "presenter", sentences: [] },
    ]);
  });
  it("an answer that is not JSON, or has no frames, is unreadable (null) — never an approval", () => {
    expect(parseSheetAnswer("sorry", 4, 3)).toBeNull();
    expect(parseSheetAnswer("{}", 4, 3)).toBeNull();
  });
});

describe("only the approved seconds are downloaded", () => {
  it("one section around each approved frame, merged where they touch, inside the video", () => {
    expect(windowsAroundApprovals([100], 600)).toEqual([{ startSec: 97, durationSec: 10 }]);
    expect(windowsAroundApprovals([100, 105], 600)).toEqual([{ startSec: 97, durationSec: 15 }]);
    expect(windowsAroundApprovals([1], 600)).toEqual([{ startSec: 0, durationSec: 8 }]);
    expect(windowsAroundApprovals([598], 600)).toEqual([{ startSec: 595, durationSec: 5 }]);
  });
  it("never more than the caps, the sections with the most approved frames first", () => {
    const many = Array.from({ length: 20 }, (_, i) => 30 + i * 25);
    const w = windowsAroundApprovals(many, 600);
    expect(w.length).toBeLessThanOrEqual(MAX_SECTIONS);
    expect(w.reduce((s, x) => s + x.durationSec, 0)).toBeLessThanOrEqual(MAX_SECTION_TOTAL_SEC);
    const dense = windowsAroundApprovals([100, 102, 104, 106, 400], 600);
    expect(dense[0]).toEqual({ startSec: 97, durationSec: 16 });
  });
});

/* ═══════════ the look, end to end with stand-ins ═══════════ */

function fakeDeps(answer: string | null, over: Partial<SheetDeps> = {}, sharpAnswer: string | null = null) {
  const calls = { ask: 0, sprites: 0, prompt: "", sharpPrompt: "", sharpAsked: [] as number[] };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "v659sheet-"));
  const deps: SheetDeps = {
    workDir,
    fetchStoryboard: async () => SB,
    fetchBytes: async () => {
      calls.sprites++;
      return Buffer.from("jpeg");
    },
    fetchTranscript: async () => [{ startSec: 95, text: "the Fremont factory building the Model 3" }],
    compose: async (_f, out) => {
      fs.writeFileSync(out, "sheet");
      return true;
    },
    ask: async (prompt) => {
      calls.ask++;
      if (prompt.includes("full-quality frames")) {
        calls.sharpPrompt = prompt;
        return sharpAnswer;
      }
      calls.prompt = prompt;
      return answer;
    },
    log: () => undefined,
    ...over,
  };
  return { deps, calls };
}

describe("lookBeforeDownload — one look for the whole video", () => {
  it("without sharp frames: one quick look, candidates downloaded, NOT confirmed (judged after the download)", async () => {
    const { deps, calls } = fakeDeps(JSON.stringify({ frames: [{ frame: 3, depicts: "Model 3 assembly line", sentences: [0] }, { frame: 4, depicts: "a presenter", sentences: [] }] }));
    const out = await lookBeforeDownload({ videoId: "abcdefghijk", title: "Inside the Fremont factory", sentences: SENTENCES, durationSec: 600, deps });
    expect(calls.ask).toBe(1);
    for (const s of SENTENCES) expect(calls.prompt).toContain(s);
    expect(calls.prompt).toMatch(/presenter or someone talking to camera/);
    /** Sprites are fetched once each, not once per frame. */
    expect(calls.sprites).toBeLessThanOrEqual(SB.fragments.length);
    expect(out.kind).toBe("approved");
    if (out.kind !== "approved") return;
    expect(out.picks).toHaveLength(1);
    expect(out.picks[0]!.sentences).toEqual([0]);
    expect(out.windows).toHaveLength(1);
    expect(out.windows[0]!.startSec).toBeLessThanOrEqual(out.picks[0]!.sec);
    expect(out.confirmed).toBe(false);
  });

  const quick = JSON.stringify({
    frames: [
      { frame: 3, depicts: "assembly line", sentences: [0] },
      { frame: 9, depicts: "man on factory floor", sentences: [1] },
      { frame: 20, depicts: "stock chart", sentences: [2] },
    ],
  });
  const sharpDeps = (sharpAnswer: string | null, kept?: (secs: readonly number[]) => number[]) =>
    fakeDeps(quick, {
      fetchSharpFrames: async (_id, secs, out) => {
        fs.writeFileSync(out, "sharp sheet");
        return { seconds: kept ? kept(secs) : [...secs] };
      },
    }, sharpAnswer);

  it("STEP 3: the candidates go to the picture editor as SHARP frames; only what it approves there is downloaded", async () => {
    /** The sharp look keeps the assembly line and refuses the other two (a presenter, a chart with text). */
    const { deps, calls } = sharpDeps(JSON.stringify({ frames: [{ frame: 1, depicts: "Model 3 bodies on the line", sentences: [0] }, { frame: 2, depicts: "presenter", sentences: [] }, { frame: 3, depicts: "chart", sentences: [] }] }));
    const out = await lookBeforeDownload({ videoId: "abcdefghijk", title: "t", sentences: SENTENCES, durationSec: 600, deps });
    expect(calls.ask).toBe(2);
    for (const s of SENTENCES) expect(calls.sharpPrompt).toContain(s);
    expect(calls.sharpPrompt).toMatch(/burned-in subtitles/);
    expect(out.kind).toBe("approved");
    if (out.kind !== "approved") return;
    expect(out.confirmed).toBe(true);
    expect(out.picks).toHaveLength(1);
    expect(out.picks[0]).toMatchObject({ sentences: [0], depicts: "Model 3 bodies on the line" });
    /** Only the approved frame's seconds: one section. */
    expect(out.windows).toHaveLength(1);
    expect(out.windows[0]!.startSec).toBeLessThanOrEqual(out.picks[0]!.sec);
    expect(out.windows[0]!.startSec + out.windows[0]!.durationSec).toBeGreaterThan(out.picks[0]!.sec);
  });

  it("STEP 3: the sharp look refuses every candidate → nothing is downloaded", async () => {
    const { deps } = sharpDeps(JSON.stringify({ frames: [{ frame: 1, depicts: "studio", sentences: [] }] }));
    expect((await lookBeforeDownload({ videoId: "abcdefghijk", title: "t", sentences: SENTENCES, durationSec: 600, deps })).kind).toBe("nothing_fits");
  });

  it("STEP 3: a second the stream could not give is left off; the numbering follows the frames that came back", async () => {
    const { deps } = sharpDeps(JSON.stringify({ frames: [{ frame: 1, depicts: "man on the floor", sentences: [1] }] }), (secs) => secs.slice(1));
    const out = await lookBeforeDownload({ videoId: "abcdefghijk", title: "t", sentences: SENTENCES, durationSec: 600, deps });
    if (out.kind !== "approved") throw new Error(out.kind);
    /** Frame 1 of the sharp sheet is the SECOND candidate (the first could not be read). */
    const quickSecs = chooseSheetSeconds(600, [95]);
    expect(out.picks[0]!.sec).toBe(quickSecs[8]);
  });

  it("STEP 3: an unreadable sharp answer → candidates downloaded but not confirmed", async () => {
    const { deps } = sharpDeps("garbage");
    const out = await lookBeforeDownload({ videoId: "abcdefghijk", title: "t", sentences: SENTENCES, durationSec: 600, deps });
    expect(out.kind === "approved" && out.confirmed).toBe(false);
  });

  it("nothing fits → nothing_fits (the video is not downloaded)", async () => {
    const { deps } = fakeDeps(JSON.stringify({ frames: [{ frame: 1, depicts: "studio", sentences: [] }] }));
    expect((await lookBeforeDownload({ videoId: "abcdefghijk", title: "t", sentences: SENTENCES, durationSec: 600, deps })).kind).toBe("nothing_fits");
  });

  it("no storyboard, unfetchable sprites, no sheet or an unreadable answer → no_sheet (the old way)", async () => {
    for (const over of [
      { fetchStoryboard: async () => null },
      { fetchBytes: async () => null },
      { compose: async () => false },
    ] as Partial<SheetDeps>[]) {
      const { deps, calls } = fakeDeps("{}", over);
      expect((await lookBeforeDownload({ videoId: "abcdefghijk", title: "t", sentences: SENTENCES, durationSec: 600, deps })).kind).toBe("no_sheet");
      expect(calls.ask).toBe(0);
    }
    const { deps } = fakeDeps("not json");
    expect((await lookBeforeDownload({ videoId: "abcdefghijk", title: "t", sentences: SENTENCES, durationSec: 600, deps })).kind).toBe("no_sheet");
  });
});

/* ═══════════ the stock downloads what the look approved, and nothing it refused ═══════════ */

describe("the stock and the look", () => {
  const FILM = 659_001;
  afterEach(() => releaseYoutubeShotStock(FILM));

  const run = async (look: StockDeps["look"]) => {
    const downloads: Array<{ start: number; dur: number }> = [];
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "v659stock-"));
    startYoutubeShotStock(FILM, [{ videoId: "abcdefghijk", title: "Inside the factory", durationSec: 600, serves: 1 }], {
      workDir,
      startFor: () => 280,
      log: () => undefined,
      look,
      download: async (_id, start, dur, out) => {
        downloads.push({ start, dur });
        fs.writeFileSync(out, "mp4");
        return true;
      },
      cut: async (_file, dir) => [{ path: path.join(dir, `shot_${downloads.length}.mp4`), startSec: 1, endSec: 5 }],
    });
    await youtubeStockSettled(FILM);
    return downloads;
  };

  it("approved → only the approved sections are downloaded, each cut into shots", async () => {
    const downloads = await run(async () => ({ kind: "approved", windows: [{ startSec: 97, durationSec: 10 }, { startSec: 400, durationSec: 10 }] }));
    expect(downloads).toEqual([{ start: 97, dur: 10 }, { start: 400, dur: 10 }]);
    const took = await takeStockShots(FILM, "abcdefghijk", 0, () => false, 5);
    expect(took.shots.map((s) => s.sourceStartSec).sort((a, b) => a - b)).toEqual([98, 401]);
  });

  it("the approved sections of one video are downloaded side by side, not one after another", async () => {
    let running = 0;
    let most = 0;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "v659par-"));
    startYoutubeShotStock(FILM, [{ videoId: "abcdefghijk", title: "t", durationSec: 600, serves: 1 }], {
      workDir,
      startFor: () => 0,
      log: () => undefined,
      look: async () => ({ kind: "approved", windows: [100, 200, 300, 400].map((s) => ({ startSec: s, durationSec: 10 })) }),
      download: async (_id, _start, _dur, out) => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 40));
        running--;
        fs.writeFileSync(out, "mp4");
        return true;
      },
      cut: async (_file, dir) => [{ path: path.join(dir, `shot_${Math.random()}.mp4`), startSec: 1, endSec: 5 }],
    });
    await youtubeStockSettled(FILM);
    expect(most).toBe(3);
    const took = await takeStockShots(FILM, "abcdefghijk", 0, () => false, 8);
    expect(took.shots).toHaveLength(4);
  });

  it("nothing fits → nothing is downloaded, and a sentence does not download it itself either", async () => {
    const downloads = await run(async () => ({ kind: "nothing_fits" }));
    expect(downloads).toEqual([]);
    expect(await takeStockShots(FILM, "abcdefghijk", 0)).toEqual({ shots: [], reason: "refused_before_download" });
  });

  it("no sheet → the one guessed section, exactly as before", async () => {
    const downloads = await run(async () => ({ kind: "no_sheet", reason: "no storyboard" }));
    expect(downloads).toEqual([{ start: 280, dur: 40 }]);
  });

  it("a look that throws is no_sheet, never a lost video", async () => {
    const downloads = await run(async () => {
      throw new Error("boom");
    });
    expect(downloads).toEqual([{ start: 280, dur: 40 }]);
  });

  it("the pipeline's per-sentence route does not download a video the look refused", () => {
    const at = PIPE.indexOf("const took = await takeStockShots(\n                poolVideoId!,");
    expect(at).toBeGreaterThan(0);
    expect(PIPE.slice(at, at + 2500)).toContain('if (took.reason && took.reason !== "download_failed") {');
  });
});

/* ═══════════ the approval spares the sentence a second look ═══════════ */

describe("a moment the sheet approved for this sentence is not looked at again", () => {
  const FILM = 659_002;
  const ASSET = "youtube_cc:0123456789abcdef";
  afterEach(() => clearSheetApprovals(FILM));

  const ctx = (beatText: string) => ({ sceneIndex: 1, beatIndex: 2, beatText, videoTitle: "Tesla" });

  it("reads a moment's key", () => {
    expect(parseYoutubeMomentKey(`${ASSET}@t970d40`)).toEqual({ assetKey: ASSET, startSec: 97, endSec: 101 });
    expect(parseYoutubeMomentKey("youtube_cc:0123456789abcdef")).toBeNull();
    expect(parseYoutubeMomentKey("pexels:123")).toBeNull();
  });

  it("the approved frame inside the moment, the same sentence → a 'fits' in the gate's own memory", () => {
    rememberSheetApprovals(FILM, ASSET, [{ sec: 99, sentence: SENTENCES[0]!, depicts: "Model 3 assembly line" }]);
    const state = { seen: new Map() } as never as { seen: Map<string, { verdict: string; evaluated: boolean }> };
    const seeded = seedSheetApproval({ contentKey: `${ASSET}@t970d40`, state } as never, ctx(SENTENCES[0]!), FILM);
    expect(seeded).toBe(true);
    const [entry] = [...state.seen.values()];
    expect(entry).toMatchObject({ verdict: "fits", evaluated: true });
  });

  it("the beat's text spelled slightly differently from the pool's sentence still matches", () => {
    rememberSheetApprovals(FILM, ASSET, [{ sec: 99, sentence: SENTENCES[0]!, depicts: "line" }]);
    expect(sheetApprovalFor(FILM, ASSET, 97, 101, "The factory in Fremont started building the Model 3 in 2017")).not.toBeNull();
  });

  it("another sentence, other seconds, another video or another film → nothing seeded (judged as before)", () => {
    rememberSheetApprovals(FILM, ASSET, [{ sec: 99, sentence: SENTENCES[0]!, depicts: "line" }]);
    const fresh = () => ({ seen: new Map() }) as never;
    expect(seedSheetApproval({ contentKey: `${ASSET}@t970d40`, state: fresh() } as never, ctx(SENTENCES[2]!), FILM)).toBe(false);
    expect(seedSheetApproval({ contentKey: `${ASSET}@t2000d40`, state: fresh() } as never, ctx(SENTENCES[0]!), FILM)).toBe(false);
    expect(seedSheetApproval({ contentKey: `youtube_cc:fedcba9876543210@t970d40`, state: fresh() } as never, ctx(SENTENCES[0]!), FILM)).toBe(false);
    expect(seedSheetApproval({ contentKey: `${ASSET}@t970d40`, state: fresh() } as never, ctx(SENTENCES[0]!), 1)).toBe(false);
  });

  it("the judge seeds BEFORE it asks, with the sentence it judges on (the own-sentence override included)", () => {
    const body = PIPE.slice(PIPE.indexOf("async function judgeBeatClipRelevance("));
    const seed = body.indexOf("seedSheetApproval(params, ownSentence?.trim() ? { ...params.ctx, beatText: ownSentence } : params.ctx);");
    const ask = body.indexOf("await judgePicture({");
    expect(seed).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(seed);
  });

  it("only a verdict given on SHARP frames is remembered for the sentences", () => {
    expect(PIPE).toContain('if (outcome.kind === "approved" && outcome.confirmed) {');
    expect(PIPE).toContain("fetchSharpFrames: (id, secs, outPath) => fetchSharpFramesFromService(id, secs, outPath),");
  });

  it("the stock is given the look, and it can be switched off", () => {
    expect(PIPE).toContain("...(youtubeLookBeforeDownloadEnabled() ? { look: (c: { videoId: string; title: string; durationSec: number }) => lookAtYoutubeVideoBeforeDownload(filmId, pool.sentences, c, workDir) } : {}),");
    expect(PIPE).toContain('process.env.YOUTUBE_LOOK_BEFORE_DOWNLOAD?.trim().toLowerCase() !== "false"');
  });
});

/* ═══════════ the sheet itself, with the real ffmpeg ═══════════ */

describe("the contact sheet is made with the real ffmpeg", () => {
  it("crops frames from a sprite, numbers them and tiles them six wide", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v659ffmpeg-"));
    const sprite = path.join(dir, "sprite.jpg");
    execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=480x270:rate=1", "-frames:v", "1", sprite]);
    const frames = Array.from({ length: 8 }, (_, i) => ({ sprite, x: (i % 3) * 160, y: Math.floor(i / 3) % 3 * 90, w: 160, h: 90, n: i + 1 }));
    const out = path.join(dir, "sheet.jpg");
    expect(await composeSheetWithFfmpeg(FFMPEG, frames, out)).toBe(true);
    const probe = execFileSync(FFMPEG.replace(/ffmpeg$/, "ffprobe").includes("ffprobe") ? "ffprobe" : "ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", out,
    ]).toString().trim();
    const [w, h] = probe.split(",").map(Number);
    /** Six frames of 320 wide plus padding, two rows of 180 high plus padding. */
    expect(w).toBeGreaterThanOrEqual(6 * 320);
    expect(h).toBeGreaterThanOrEqual(2 * 180);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
