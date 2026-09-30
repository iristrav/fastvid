/**
 * Video 618, points 3 and 4.
 *
 * 3. The transition graph failed with `[auto_scale_10] Failed to configure output pad`, every
 *    segment measured identical, and the log cut ffmpeg's message at 200 characters — most of them
 *    the command. The other lines ffmpeg wrote now travel with the failure and are logged.
 * 4. With the video pool empty, the beats searched YouTube themselves and downloaded ten videos
 *    without asking what they show; eight were refused afterwards for on-screen text. The pool's
 *    thumbnail look now runs on that route too.
 *
 * No network: ffmpeg runs locally on a lavfi source; the look is a stand-in.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import { execFileSync } from "child_process";
import { ffmpegStderrSummary, oddSegmentsOut, probeSegmentShape } from "./timelineRenderer";
import { withSceneFetchTimeout, youtubeRowsWithoutNonFootage, type YoutubeSearchRow } from "./videoPipeline";

const RENDERER = fs.readFileSync(path.join(__dirname, "timelineRenderer.ts"), "utf8");
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const POOL = fs.readFileSync(path.join(__dirname, "youtubeVideoPoolProduction.ts"), "utf8");

describe("Video 618 (3) — every line ffmpeg said, not only the first", () => {
  it("keeps each line once, in order, without the pointer noise, up to the cap", () => {
    const stderr = [
      "[Parsed_xfade_27 @ 0x55c8f4df8ac0] First input link main timebase (1/1000000) do not match",
      "[auto_scale_10 @ 0x55c8f4df8ac0] Failed to configure output pad on auto_scale_10",
      "Error reinitializing filters!",
      "Error reinitializing filters!",
      "",
      "Failed to inject frame into filter network: Invalid argument",
    ].join("\n");
    const said = ffmpegStderrSummary({ stderr });
    expect(said).toBe(
      "[Parsed_xfade_27] First input link main timebase (1/1000000) do not match | " +
        "[auto_scale_10] Failed to configure output pad on auto_scale_10 | " +
        "Error reinitializing filters! | " +
        "Failed to inject frame into filter network: Invalid argument"
    );
    expect(ffmpegStderrSummary({ stderr }, 2).split(" | ")).toHaveLength(2);
    expect(ffmpegStderrSummary({})).toBe("");
    expect(ffmpegStderrSummary(new Error("Command failed: /usr/bin/ffmpeg -i a.mp4"))).toBe("");
  });

  it("with a real ffmpeg failure, the reason line is there and the command is not", async () => {
    const run = promisify(execFile);
    const err = await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=1",
      "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=30:duration=1",
      "-filter_complex", "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=0.2[v]",
      "-map", "[v]", "-f", "null", "-",
    ]).then(() => null, (e: unknown) => e);
    expect(err, "the mismatched xfade should fail").not.toBeNull();
    const said = ffmpegStderrSummary(err);
    expect(said.length).toBeGreaterThan(0);
    expect(said).not.toContain("testsrc2=size");
    expect(said).not.toMatch(/@ 0x[0-9a-f]+/);
  }, 30_000);

  it("wiring: the failure keeps ffmpeg's stderr, and the ladder prints it next to its own line", () => {
    const run = RENDERER.slice(RENDERER.indexOf("async function runFfmpeg("), RENDERER.indexOf("export function ffmpegStderrSummary("));
    expect(run).toContain("stderr: (err as { stderr?: unknown } | null)?.stderr,");
    /** The message the classifier and the ladder already read is unchanged. */
    expect(run).toContain("said ? `${what}: ${said} — ${original}` : `${what}: ${original}`");
    const ladder = RENDERER.slice(RENDERER.indexOf("for (const step of TRANSITION_LADDER) {"));
    expect(ladder).toContain("const said = ffmpegStderrSummary(graphErr);");
    expect(ladder).toContain("[TransitionLadder] ${step} ffmpeg said: ${said}");
    /** A diagnosed failure still fails, and still walks down the ladder. */
    expect(ladder).toContain("throw firstFailure;");
  });
});

describe("Video 618 (3) — the segment check also measures colour and the first decoded frame", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v618-shape-"));
  const make = (name: string, extra: string[]) => {
    const out = path.join(dir, name);
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1",
      ...extra, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-video_track_timescale", "15360", out,
    ]);
    return out;
  };

  it("a normal segment reports its header, its colour tags and its first frame", async () => {
    const a = make("a.mp4", ["-colorspace", "bt709", "-color_range", "tv"]);
    const shape = (await probeSegmentShape(a))!;
    expect(shape).toContain("width=320 height=180");
    expect(shape).toContain("color_range=tv");
    expect(shape).toContain("color_space=bt709");
    expect(shape).toContain("first_frame_width=320");
    expect(shape).toContain("first_frame_pix_fmt=yuv420p");
  });

  it("a segment that matches in size but not in colour is named as the odd one", async () => {
    const same = [0, 1, 2].map((i) => make(`s${i}.mp4`, ["-colorspace", "bt709", "-color_range", "tv"]));
    const fullRange = make("full.mp4", ["-vf", "scale=out_range=pc", "-colorspace", "bt709", "-color_range", "pc"]);
    const bt601 = make("bt601.mp4", ["-colorspace", "smpte170m", "-color_range", "tv"]);
    const shapes = await Promise.all(
      [...same, fullRange, bt601].map(async (f) => ({ name: path.basename(f), shape: await probeSegmentShape(f) }))
    );
    const { odd } = oddSegmentsOut(shapes);
    expect(odd.map((o) => o.name).sort()).toEqual(["bt601.mp4", "full.mp4"]);
    /** Before this round these two measured identical to the rest. */
    const header = (s: string | null) => s!.split(" ").filter((kv) => /^(width|height|sample_aspect_ratio|time_base|r_frame_rate)=/.test(kv)).join(" ");
    expect(new Set(shapes.map((s) => header(s.shape))).size).toBe(1);
  }, 30_000);

  it("a file that cannot be probed is still null, and colour is never a verdict on its own", async () => {
    expect(await probeSegmentShape(path.join(dir, "missing.mp4"))).toBeNull();
    const src = fs.readFileSync(path.join(__dirname, "timelineRenderer.ts"), "utf8");
    const probe = src.slice(src.indexOf("export async function probeSegmentShape("), src.indexOf("export function oddSegmentsOut("));
    expect(probe).toContain('"-read_intervals", "%+#1"');
    expect(probe).toContain('["first_frame=NONE"]');
    expect(probe).not.toContain("scale=");
    expect(probe).not.toContain("setsar");
  });
});

const row = (videoId: string, title: string): YoutubeSearchRow =>
  ({
    item: { id: { videoId }, snippet: { title, description: "", thumbnails: { high: { url: `https://i.ytimg.com/vi/${videoId}/hq.jpg` } } } },
    title,
    desc: "",
    thumb: `https://i.ytimg.com/vi/${videoId}/hq.jpg`,
    rel: 1,
  }) as YoutubeSearchRow;

const beat = { beatText: "Kylie Jenner turned lip kits into a fortune.", beatIndex: 0, videoTitle: "Kardashians" } as never;

describe("Video 618 (4) — the pool's look on the route that runs without a pool", () => {
  /**
   * VIDEO 624 — first look, then download: a row the look did not judge, or judged as footage that
   * does not serve the sentence, is not downloaded; nor is a row past the five looked at.
   */
  it("commentary and text videos are not downloaded; only judged footage that serves the sentence is, in order", async () => {
    const verdicts: Record<string, { footageType: string; servesBeats: number[] } | null> = {
      aaaaaaaaaa1: { footageType: "text_or_graphic", servesBeats: [0] },
      aaaaaaaaaa2: { footageType: "real_footage", servesBeats: [0] },
      aaaaaaaaaa3: { footageType: "talking_head", servesBeats: [0] },
      aaaaaaaaaa4: null,
      aaaaaaaaaa5: { footageType: "archival_footage", servesBeats: [0] },
    };
    const look = vi.fn(async (item: { videoId: string }) => verdicts[item.videoId] ?? null);
    const rows = [
      row("aaaaaaaaaa1", "Kris Jenner Lifestyle: How Rich Is the Momager Queen?"),
      row("aaaaaaaaaa2", "Kim Kardashian And Mom Kris Jenner Cause A Frenzy At LAX"),
      row("aaaaaaaaaa3", "Kylie Jenner Lists Another Mansion - Here's What's Going On"),
      row("aaaaaaaaaa4", "Kylie Jenner at the Met Gala"),
      row("aaaaaaaaaa5", "Kris Jenner 1991 home video"),
      row("aaaaaaaaaa6", "beyond the five rows looked at"),
    ];
    const kept = await youtubeRowsWithoutNonFootage(rows, beat, 2, look);
    expect(kept.map((r) => r.item.id!.videoId)).toEqual(["aaaaaaaaaa2", "aaaaaaaaaa5"]);
    expect(look).toHaveBeenCalledTimes(5);
  });

  it("real footage the look says does not serve this sentence is not downloaded", async () => {
    const look = vi.fn(async () => ({ footageType: "real_footage", servesBeats: [] as number[] }));
    expect(await youtubeRowsWithoutNonFootage([row("eeeeeeeeee1", "a street")], beat, 0, look)).toEqual([]);
  });

  it("the same video is looked at once per process, whichever beat asks", async () => {
    const look = vi.fn(async () => ({ footageType: "talking_head" }));
    const rows = [row("bbbbbbbbbb1", "a commentary video")];
    expect(await youtubeRowsWithoutNonFootage(rows, beat, 0, look)).toEqual([]);
    expect(await youtubeRowsWithoutNonFootage(rows, beat, 1, look)).toEqual([]);
    expect(look).toHaveBeenCalledTimes(1);
  });

  /** VIDEO 624 — nothing is downloaded unseen: a look that fails downloads nothing. */
  it("a look that fails downloads nothing unseen", async () => {
    const look = vi.fn(async () => {
      throw new Error("vision provider down");
    });
    const rows = [row("cccccccccc1", "x")];
    expect(await youtubeRowsWithoutNonFootage(rows, beat, 0, look)).toEqual([]);
  });

  it("it never spends the download's time: out of budget nothing is downloaded unseen", async () => {
    const look = vi.fn(() => new Promise<null>(() => {}));
    const rows = [row("dddddddddd1", "x"), row("dddddddddd2", "y")];
    const kept = await withSceneFetchTimeout(
      () => youtubeRowsWithoutNonFootage(rows, beat, 0, look),
      12_300,
      "a beat with 0.3s beyond the download floor"
    );
    expect(kept).toEqual([]);
  }, 20_000);

  it("wiring: only off the pool, after the ranking and before the loop; the pool's own look is the same function", () => {
    const at = PIPE.indexOf("const ordered = await youtubeRowsRankedByThumbnail(");
    const loop = PIPE.indexOf("for (const row of ordered.slice(0, 5)) {");
    const call = PIPE.indexOf("(poolMode ? rows : youtubeRowsWithoutNonFootage(rows, scriptGuided, sceneIndex))");
    expect(at).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(at);
    expect(call).toBeLessThan(loop);
    expect(POOL).toContain("triageYoutubeThumbnail(item, title, sentences, llm, clipFilter);");
    expect(POOL).toContain("export async function triageYoutubeThumbnail(");
    expect(POOL).toContain("text: youtubeTriagePrompt(item, title, sentences),");
  });
});
