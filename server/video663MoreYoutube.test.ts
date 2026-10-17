/**
 * VIDEO 663 — "Je moet gewoon meer youtube beelden ophalen."
 *
 * Render 72 (video 662) still showed pictures twice and pictures that stood still. The YouTube shots
 * the picture editor approved were cut to 4 s (the beat clip length) from 12 s sections, under
 * sentences of 6–9 s: "the source holds 1 distinct 2.18s window(s) for 4 piece(s) — 3 hold the last
 * frame". Three changes, all of them more YouTube footage:
 *
 *   1. a moment is its whole shot, up to `youtubeMomentMaxSec` (10 s), not 4 s;
 *   2. the look before the download fetches 20 s around each approved frame (was 12 s), and a
 *      sentence's own section is 30 s (was 20 s);
 *   3. a sentence its shots still leave short gets more shots of its OWN YouTube video from the
 *      film's stock (`sameVideoStockMoments`) before a generic clip or a held frame.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { youtubeMomentCutSec, youtubeMomentMaxSec, youtubeMomentSpanSec } from "./youtubeMoments";
import { MAX_SECTION_TOTAL_SEC, windowsAroundApprovals } from "./youtubePreviewSheet";
import { releaseYoutubeShotStock, startYoutubeShotStock, takeStockShots, youtubeStockSettled } from "./youtubeShotStock";
import { planYoutubePieces } from "./youtubeShotLimit";
import type { CoverRestIo } from "./videoPipeline";

type VP = typeof import("./videoPipeline");
let vp: VP;
let dir: string;
beforeAll(async () => {
  vp = await import("./videoPipeline");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-663-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.YOUTUBE_MOMENT_MAX_SEC;
});

const video = (file: string, seconds: number): string => {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=gray:s=64x36:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  return file;
};

/** Stocks `ids` for `filmId`; each video is cut into `shots` shots of `shotSec` seconds. */
async function stock(filmId: number, ids: string[], shotSec: number, shots: number): Promise<void> {
  startYoutubeShotStock(
    filmId,
    ids.map((videoId) => ({ videoId, title: `title ${videoId}`, durationSec: 120, serves: 1 })),
    {
      workDir: dir,
      download: async (_id, _s, _d, out) => fs.existsSync(video(out, shotSec * shots)),
      cut: async (file) =>
        Array.from({ length: shots }, (_, i) => ({ path: video(`${file}.shot${i}.mp4`, shotSec), startSec: i * shotSec, endSec: (i + 1) * shotSec })),
      startFor: () => 0,
      log: () => {},
    }
  );
  await youtubeStockSettled(filmId);
}

const tagOf = (p: string) => /_t(\d+)d(\d+)__pid_/.exec(path.basename(p));

describe("1 — a YouTube moment is its whole shot, up to ten seconds", () => {
  it("ten seconds by default; the operator may set 4–20", () => {
    expect(youtubeMomentMaxSec()).toBe(10);
    process.env.YOUTUBE_MOMENT_MAX_SEC = "6";
    expect(youtubeMomentMaxSec()).toBe(6);
    process.env.YOUTUBE_MOMENT_MAX_SEC = "60";
    expect(youtubeMomentMaxSec()).toBe(10);
  });

  it("a moment is cut at its shot, never longer than the cap", () => {
    expect(youtubeMomentCutSec({ sourceStartSec: 100, sourceEndSec: 114 }, 10)).toBe(10);
    expect(youtubeMomentCutSec({ sourceStartSec: 100, sourceEndSec: 106.5 }, 10)).toBe(6.5);
  });

  it("render 72's arithmetic: a 4 s source over an 8.7 s sentence holds frames; a 10 s source does not", () => {
    const facts = (sec: number) => ({ sourceDurationSec: sec, cutsSec: [], measured: true });
    const short = planYoutubePieces({ inSec: 0, durationSec: 8.7, facts: facts(4), slowRatherThanRepeat: true });
    expect(short.pieces.some((p) => p.hold)).toBe(true);
    const long = planYoutubePieces({ inSec: 0, durationSec: 8.7, facts: facts(10), slowRatherThanRepeat: true });
    expect(long.pieces.length).toBe(2);
    expect(long.pieces.some((p) => p.hold)).toBe(false);
    /** two different windows of the one shot, no second shown twice */
    expect(long.pieces[1]!.inSec).toBeGreaterThanOrEqual(long.pieces[0]!.inSec + long.pieces[0]!.durationSec - 0.001);
  });

  it("a late stock moment of a 9 s shot is 9 s, not 4", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const filmId = 66301;
    await stock(filmId, ["nineSecShot"], 9, 2);
    const d = { usedContentKeys: new Set<string>(), sourcingCache: vp.createSourcingCache(663) };
    const made = await vp.takeLateStockMoments(filmId, d as never, 0, { index: 0, text: "x" }, ["nineSecShot"], dir);
    expect(made.length).toBe(2);
    for (const p of made) expect(tagOf(p)?.[2]).toBe("90");
    releaseYoutubeShotStock(filmId);
  }, 60_000);

  it("the sentence's own turn cuts its moments with the same cap", () => {
    const pipe = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(pipe).toContain("const momentCap = capYoutubeClipDuration(Math.max(duration, youtubeMomentMaxSec()), pass.fileTag);");
    expect(pipe).toContain("const momentDur = (s: { sourceStartSec: number; sourceEndSec: number }) => youtubeMomentCutSec(s, momentCap);");
  });
});

describe("2 — more seconds are downloaded around what fits", () => {
  it("twenty seconds around each approved frame (was twelve), six sections, 120 s in all", () => {
    expect(windowsAroundApprovals([100], 600)).toEqual([{ startSec: 95, durationSec: 20 }]);
    expect(MAX_SECTION_TOTAL_SEC).toBe(120);
  });

  it("a sentence's own section is thirty seconds (was twenty)", () => {
    expect(youtubeMomentSpanSec(4, 600)).toBe(30);
  });
});

describe("3 — more of the sentence's own YouTube video from the film's stock", () => {
  it("the other shots of the video, never the seconds already placed; a non-YouTube clip asks for nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const filmId = 66302;
    await stock(filmId, ["ownVideo001", "otherVid001"], 6, 3);
    const d = { usedContentKeys: new Set<string>(), sourcingCache: vp.createSourcingCache(663) };
    /** the sentence's own, placed shot: the video's first */
    const first = (await takeStockShots(filmId, "ownVideo001", 0, (s) => s.sourceStartSec !== 0, 1)).shots[0]!;
    const own = await vp.writeStockMoment(
      d.sourcingCache,
      { videoId: "ownVideo001", title: first.title, path: first.path, sourceStartSec: 0, sourceEndSec: 6 },
      6,
      path.join(dir, `scene_0_ytfu_0m0_${vp.youtubeFragmentFileTag(0, 6)}.mp4`),
      { sceneIndex: 0, beatIndex: 1 }
    );
    expect(own).not.toBeNull();
    d.usedContentKeys.add(vp.clipContentKey(own!));

    const more = await vp.sameVideoStockMoments(filmId, d as never, 0, { index: 1, text: "x" }, [own!], dir);
    expect(more.length).toBe(2);
    const videoOf = (p: string) => d.sourcingCache.lineage.resolve(p)?.providerAssetId?.split("@t")[0];
    for (const p of more) expect(videoOf(p)).toBe("ownVideo001");
    expect(more.map((p) => Number(tagOf(p)![1]) / 10).sort((a, b) => a - b)).toEqual([6, 12]);

    const curated = path.join(dir, "scene_0_b1_curated_a58618.mp4");
    fs.writeFileSync(curated, "x");
    expect(await vp.sameVideoStockMoments(filmId, d as never, 0, { index: 1, text: "x" }, [curated], dir)).toEqual([]);
    releaseYoutubeShotStock(filmId);
  }, 60_000);

  function fixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v663-rest-"));
    const real = (name: string) => {
      const f = path.join(tmp, name);
      fs.writeFileSync(f, "x");
      return f;
    };
    const own = real("scene_0_ytfu_0m0_t1000d40__pid_youtube_cc-aaaaaaaaaaaaaaaa.mp4");
    const stocked = real("scene_0_ytfu_rest1m0_t1060d90__pid_youtube_cc-aaaaaaaaaaaaaaaa.mp4");
    const beat = { index: 1, text: "Brussels wakes up under a grey sky.", holdSec: 8.7 };
    const vr = { clips: [own], beatDurations: [4], clipBeatIndices: [1], beats: [beat] };
    const dedup = {
      sceneBeatsBySceneIndex: new Map([[0, [beat]]]),
      /** the sentence was handed only its own shot: no other moment of the video to fall back on */
      beatCandidateCalls: new Map([["0:1", [{ paths: [own], beatText: beat.text, sourceQuery: "", opts: {} }]]]),
      usedPaths: new Set<string>(),
      usedContentKeys: new Set<string>(),
      usedCuratedAssetIds: new Set<number>(),
      usedCuratedStorageUrls: new Set<string>(),
      refusedAssetsThisRender: new Set<string>(),
    };
    return { vr, dedup, own, stocked };
  }
  const okChecks = { valid: async () => true, durationSec: async () => 9, black: async () => false };

  it("render 72's sentence (8.7 s, one 4 s shot, nothing else handed): the video's next shot goes behind it, no generic clip, no held frame", async () => {
    const { vr, dedup, own, stocked } = fixture();
    const generic = vi.fn(async () => null);
    const asked = vi.fn(async () => [stocked]);
    const io: CoverRestIo = { checks: okChecks, check: async () => true, genericClip: generic, sameVideoStock: asked };
    const t = await vp.coverRestOfSentences([{ index: 0, text: "" } as never], [vr as never], dedup as never, "/tmp", io);
    expect(t).toEqual({ sameVideo: 1, generic: 0, held: 0 });
    expect(asked).toHaveBeenCalledWith(0, { index: 1, text: "Brussels wakes up under a grey sky." }, [own]);
    expect(generic).not.toHaveBeenCalled();
    expect(vr.clips).toEqual([own, stocked]);
    expect(vr.beatDurations[1]).toBeCloseTo(4.7, 2);
  });

  it("a stocked shot that fails the sentence's mandatory checks is not placed; the generic library is next", async () => {
    const { vr, dedup, stocked } = fixture();
    const io: CoverRestIo = {
      checks: okChecks,
      check: async (_scene, _beat, p) => p !== stocked,
      genericClip: async (_s, _b, needed) => ({ path: "/w/scene_0_generic_rest_b1_1__pid_generic_footage-cccccccccccccccc.mp4", durationSec: Math.max(needed, 6) }),
      sameVideoStock: async () => [stocked],
    };
    const t = await vp.coverRestOfSentences([{ index: 0, text: "" } as never], [vr as never], dedup as never, "/tmp", io);
    expect(t).toEqual({ sameVideo: 0, generic: 1, held: 0 });
  });

  it("production asks the film's stock", () => {
    const pipe = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(pipe).toContain("sameVideoStock: (sceneIndex, beat, own) => sameVideoStockMoments(getActiveVideoId() ?? 0, dedup, sceneIndex, beat, own, workDir),");
  });
});
