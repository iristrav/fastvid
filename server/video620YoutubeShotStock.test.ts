/**
 * VIDEO 620 — the film's YouTube videos are fetched and cut before the beats need them.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  isStocked,
  releaseYoutubeShotStock,
  startYoutubeShotStock,
  stockOrder,
  stockSummary,
  takeStockShot,
  STOCK_CONCURRENCY,
  STOCK_SECTION_SEC,
  type StockDeps,
} from "./youtubeShotStock";
import * as pipeline from "./videoPipeline";

const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const FILM = 99_620;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ytstock-test-"));
}

/** A download that writes a file, and a cutter that makes `shots` pieces of 3 s each. */
function deps(dir: string, over: Partial<StockDeps> & { shots?: number } = {}): StockDeps & { calls: string[] } {
  const calls: string[] = [];
  const shots = over.shots ?? 3;
  return {
    calls,
    workDir: dir,
    startFor: () => 100,
    download: async (videoId, _start, _dur, outPath) => {
      calls.push(videoId);
      fs.writeFileSync(outPath, "section");
      return true;
    },
    cut: async (_file, pieceDir) =>
      Array.from({ length: shots }, (_, i) => {
        const p = path.join(pieceDir, `shot_${i + 1}.mp4`);
        fs.writeFileSync(p, `shot ${i}`);
        return { path: p, startSec: i * 3, endSec: i * 3 + 3 };
      }),
    log: () => {},
    ...over,
  };
}

const cand = (videoId: string, serves = 1, durationSec = 600) => ({ videoId, title: `t ${videoId}`, durationSec, serves });

afterEach(() => releaseYoutubeShotStock(FILM));

describe("Video 620 — the stock", () => {
  it("stocks the videos that serve the most sentences first, at most six", () => {
    const order = stockOrder([cand("a", 1), cand("b", 4), cand("c", 2), cand("d", 4), cand("e"), cand("f"), cand("g"), cand("h")]);
    expect(order.map((c) => c.videoId)).toEqual(["b", "d", "c", "a", "e", "f"]);
  });

  it("a beat gets a ready shot with its seconds in the YouTube video, without downloading", async () => {
    const d = deps(tmpDir());
    startYoutubeShotStock(FILM, [cand("vid1")], d);
    expect(isStocked(FILM, "vid1")).toBe(true);
    const took = await takeStockShot(FILM, "vid1", 5_000);
    expect(took.shot?.sourceStartSec).toBe(100);
    expect(took.shot?.sourceEndSec).toBe(103);
    expect(fs.existsSync(took.shot!.path)).toBe(true);
    expect(d.calls).toEqual(["vid1"]);
  });

  it("the section is at most forty seconds, and never longer than the video", async () => {
    const asked: number[] = [];
    const d = deps(tmpDir(), {
      download: async (_v, _s, dur, outPath) => {
        asked.push(dur);
        fs.writeFileSync(outPath, "x");
        return true;
      },
    });
    startYoutubeShotStock(FILM, [cand("long", 1, 3600), cand("short", 1, 25)], d);
    await takeStockShot(FILM, "long", 5_000);
    await takeStockShot(FILM, "short", 5_000);
    expect(asked.sort((a, b) => a - b)).toEqual([25, STOCK_SECTION_SEC]);
  });

  it("a beat waits for a section still on its way, and gets nothing when its wait ends first", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = deps(tmpDir(), {
      download: async (_v, _s, _d, outPath) => {
        await gate;
        fs.writeFileSync(outPath, "x");
        return true;
      },
    });
    startYoutubeShotStock(FILM, [cand("slow")], d);
    expect(await takeStockShot(FILM, "slow", 20)).toEqual({ shot: null, reason: "still_downloading" });
    const waiting = takeStockShot(FILM, "slow", 5_000);
    release();
    expect((await waiting).shot?.videoId).toBe("slow");
  });

  it("a failed download, or a section without a clean shot, says so", async () => {
    const d = deps(tmpDir(), { download: async () => false });
    startYoutubeShotStock(FILM, [cand("dead")], d);
    expect(await takeStockShot(FILM, "dead", 5_000)).toEqual({ shot: null, reason: "download_failed" });
    releaseYoutubeShotStock(FILM);
    startYoutubeShotStock(FILM, [cand("messy")], deps(tmpDir(), { shots: 0 }));
    expect(await takeStockShot(FILM, "messy", 5_000)).toEqual({ shot: null, reason: "download_failed" });
  });

  it("a video not in the stock is not waited for", async () => {
    expect(await takeStockShot(FILM, "never", 5_000)).toEqual({ shot: null, reason: "not_stocked" });
  });

  it("a shot handed to a beat that moved on is offered again; beats at the same time get different shots", async () => {
    startYoutubeShotStock(FILM, [cand("v")], deps(tmpDir(), { shots: 2 }));
    const a = await takeStockShot(FILM, "v", 5_000);
    const b = await takeStockShot(FILM, "v", 5_000);
    const c = await takeStockShot(FILM, "v", 5_000);
    expect(a.shot!.path).not.toBe(b.shot!.path);
    expect([a.shot!.path, b.shot!.path]).toContain(c.shot!.path);
  });

  it("a shot the picture editor refused is not offered again", async () => {
    startYoutubeShotStock(FILM, [cand("v")], deps(tmpDir(), { shots: 2 }));
    const refused = (s: { sourceStartSec: number }) => s.sourceStartSec === 100;
    expect((await takeStockShot(FILM, "v", 5_000, refused)).shot?.sourceStartSec).toBe(103);
    expect(await takeStockShot(FILM, "v", 5_000, () => true)).toEqual({ shot: null, reason: "all_refused" });
  });

  it("two videos' shots never overwrite each other", async () => {
    startYoutubeShotStock(FILM, [cand("x"), cand("y")], deps(tmpDir(), { shots: 1 }));
    const x = await takeStockShot(FILM, "x", 5_000);
    const y = await takeStockShot(FILM, "y", 5_000);
    expect(x.shot!.path).not.toBe(y.shot!.path);
  });

  it(`downloads at most ${STOCK_CONCURRENCY} at a time, and each video once`, async () => {
    let running = 0;
    let peak = 0;
    const d = deps(tmpDir(), {
      download: async (_v, _s, _d, outPath) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
        fs.writeFileSync(outPath, "x");
        return true;
      },
    });
    const ids = ["a", "b", "c", "d", "e", "f"];
    startYoutubeShotStock(FILM, ids.map((i) => cand(i)), d);
    startYoutubeShotStock(FILM, ids.map((i) => cand(i)), d);
    await Promise.all(ids.map((i) => takeStockShot(FILM, i, 5_000)));
    expect(peak).toBeLessThanOrEqual(STOCK_CONCURRENCY);
    expect(stockSummary(FILM)).toMatchObject({ videos: 6, ready: 6, failed: 0 });
  });
});

describe("Video 620 — the render uses the stock", () => {
  const src = read("server/videoPipeline.ts");

  it("the stock starts the moment the pool is decided, and again when it is topped up", () => {
    const reg = src.slice(src.indexOf("registerVideoYoutubePool(\n        videoId,"), src.indexOf("registerVideoYoutubePool(\n        videoId,") + 1400);
    expect(reg.match(/stockYoutubePool\(videoId, pool, workDir\)/g)?.length).toBe(2);
  });

  it("only videos YouTube's search found, the pool judged usable, and nobody wrote off", () => {
    const fn = src.slice(src.indexOf("function stockYoutubePool("), src.indexOf("async function stockShotToBeatFile("));
    expect(fn).toContain("c.usable && c.from !== 0 && !youtubeDownloadRefusal(c.videoId)");
    expect(fn).toContain("withoutUnusableYoutubeVideos(");
    expect(fn).toContain("noteYoutubeDownloadRefusal(ytId, dl.status, dl.reason)");
  });

  it("a beat takes the stock before any download slot is claimed, and never downloads a stocked video twice", () => {
    const stockAt = src.indexOf("if (poolMode && isStocked(poolVideoId!, videoId))");
    const claimAt = src.indexOf("if (!claimDownloadSlot()) {");
    expect(stockAt).toBeGreaterThan(0);
    expect(stockAt).toBeLessThan(claimAt);
    const block = src.slice(stockAt, src.indexOf("let clipStart =", stockAt));
    expect(block).toContain('if (took.reason !== "download_failed")');
    expect(block).toContain("youtubeFragmentRefusal(youtubeFragmentKeyFor(videoId, s.sourceStartSec, shotDur(s)))");
    expect(block).toContain("recordProviderDownloadOutcome(sourcingCache, stockPath, ok");
    expect(block).toContain("results.push(stockPath)");
  });

  it("the stock is let go with the render", () => {
    expect(src).toContain("releaseYoutubeShotStock(videoId);");
  });
});

describe("Video 620 — another shot of the same YouTube video may join the film; the same seconds never", () => {
  const pipe = async () => pipeline;

  it("a YouTube clip is known by its seconds, so two shots of one video are two pictures", async () => {
    const { clipContentKey, tagPathWithProviderAsset, youtubeFragmentFileTag } = await pipe();
    const a = tagPathWithProviderAsset(`/w/scene_0_ytfu_0_${youtubeFragmentFileTag(100, 4)}.mp4`, "youtube_cc", "vidA");
    const b = tagPathWithProviderAsset(`/w/scene_1_ytfu_0_${youtubeFragmentFileTag(110, 4)}.mp4`, "youtube_cc", "vidA");
    expect(clipContentKey(a)).not.toBe(clipContentKey(b));
    expect(clipContentKey(a)).toMatch(/^youtube_cc:[0-9a-f]{16}@t1000d40$/);
    expect(clipContentKey(a.replace(".mp4", "_transformed.mp4"))).toBe(clipContentKey(a));
  });

  it("overlapping seconds count as used; touching ones, and another video's, do not", async () => {
    const { youtubeSecondsAlreadyUsed, youtubeFragmentKeyFor } = await pipe();
    const used = new Set([youtubeFragmentKeyFor("vidA", 100, 4)]);
    expect(youtubeSecondsAlreadyUsed(used, "vidA", 100, 4)).toBe(true);
    expect(youtubeSecondsAlreadyUsed(used, "vidA", 102, 4)).toBe(true);
    expect(youtubeSecondsAlreadyUsed(used, "vidA", 98, 3)).toBe(true);
    expect(youtubeSecondsAlreadyUsed(used, "vidA", 104.1, 4)).toBe(false);
    expect(youtubeSecondsAlreadyUsed(used, "vidA", 96, 4.1)).toBe(false);
    expect(youtubeSecondsAlreadyUsed(used, "vidB", 100, 4)).toBe(false);
  });

  it("a YouTube video held without its seconds counts as wholly used", async () => {
    const { youtubeSecondsAlreadyUsed, providerAssetKey } = await pipe();
    expect(youtubeSecondsAlreadyUsed(new Set([providerAssetKey("youtube_cc", "vidA")]), "vidA", 500, 4)).toBe(true);
  });

  it("a clip is never blocked by its own mark, only by other seconds that overlap", async () => {
    const { youtubeClipSecondsAlreadyUsed, tagPathWithProviderAsset, youtubeFragmentFileTag, clipContentKey } = await pipe();
    const own = tagPathWithProviderAsset(`/w/s_${youtubeFragmentFileTag(100, 4)}.mp4`, "youtube_cc", "vidA");
    const overlapping = tagPathWithProviderAsset(`/w/s_${youtubeFragmentFileTag(103, 4)}.mp4`, "youtube_cc", "vidA");
    const other = tagPathWithProviderAsset(`/w/s_${youtubeFragmentFileTag(120, 4)}.mp4`, "youtube_cc", "vidA");
    const used = new Set([clipContentKey(own)]);
    expect(youtubeClipSecondsAlreadyUsed(used, own)).toBe(false);
    expect(youtubeClipSecondsAlreadyUsed(used, overlapping)).toBe(true);
    expect(youtubeClipSecondsAlreadyUsed(used, other)).toBe(false);
    expect(youtubeClipSecondsAlreadyUsed(used, "/w/not_a_youtube_clip.mp4")).toBe(false);
  });

  it("the adopt point, the push, the stock and the beat's own download all ask about the seconds", () => {
    const src = read("server/videoPipeline.ts");
    expect(src).toContain("if (dedup.usedContentKeys.has(contentKey) || youtubeClipSecondsAlreadyUsed(dedup.usedContentKeys, p)) {");
    expect(src).toContain("if (youtubeClipSecondsAlreadyUsed(dedup.usedContentKeys, clipPath)) {");
    expect(src).toContain("youtubeSecondsAlreadyUsed(usedProviderKeys, videoId, s.sourceStartSec, shotDur(s))");
    expect(src).toContain("if (youtubeSecondsAlreadyUsed(usedProviderKeys, videoId, clipStart, clipDur)) {");
    const claim = src.indexOf("if (youtubeSecondsAlreadyUsed(usedProviderKeys, videoId, clipStart, clipDur)) {");
    expect(claim).toBeLessThan(src.indexOf("if (!claimDownloadSlot()) {"));
  });
});
