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
import { ffmpegStderrSummary } from "./timelineRenderer";
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
  it("commentary and text videos are not downloaded; real footage and unjudged rows keep their order", async () => {
    const verdicts: Record<string, string | null> = {
      aaaaaaaaaa1: "text_or_graphic",
      aaaaaaaaaa2: "real_footage",
      aaaaaaaaaa3: "talking_head",
      aaaaaaaaaa4: null,
      aaaaaaaaaa5: "archival_footage",
    };
    const look = vi.fn(async (item: { videoId: string }) => {
      const t = verdicts[item.videoId];
      return t ? { footageType: t } : null;
    });
    const rows = [
      row("aaaaaaaaaa1", "Kris Jenner Lifestyle: How Rich Is the Momager Queen?"),
      row("aaaaaaaaaa2", "Kim Kardashian And Mom Kris Jenner Cause A Frenzy At LAX"),
      row("aaaaaaaaaa3", "Kylie Jenner Lists Another Mansion - Here's What's Going On"),
      row("aaaaaaaaaa4", "Kylie Jenner at the Met Gala"),
      row("aaaaaaaaaa5", "Kris Jenner 1991 home video"),
      row("aaaaaaaaaa6", "beyond the five rows looked at"),
    ];
    const kept = await youtubeRowsWithoutNonFootage(rows, beat, 2, look);
    expect(kept.map((r) => r.item.id!.videoId)).toEqual(["aaaaaaaaaa2", "aaaaaaaaaa4", "aaaaaaaaaa5", "aaaaaaaaaa6"]);
    expect(look).toHaveBeenCalledTimes(5);
  });

  it("the same video is looked at once per process, whichever beat asks", async () => {
    const look = vi.fn(async () => ({ footageType: "talking_head" }));
    const rows = [row("bbbbbbbbbb1", "a commentary video")];
    expect(await youtubeRowsWithoutNonFootage(rows, beat, 0, look)).toEqual([]);
    expect(await youtubeRowsWithoutNonFootage(rows, beat, 1, look)).toEqual([]);
    expect(look).toHaveBeenCalledTimes(1);
  });

  it("a look that fails is not a refusal", async () => {
    const look = vi.fn(async () => {
      throw new Error("vision provider down");
    });
    const rows = [row("cccccccccc1", "x")];
    expect(await youtubeRowsWithoutNonFootage(rows, beat, 0, look)).toEqual(rows);
  });

  it("it never spends the download's time: out of budget the rows go out unjudged", async () => {
    const look = vi.fn(() => new Promise<null>(() => {}));
    const rows = [row("dddddddddd1", "x"), row("dddddddddd2", "y")];
    const kept = await withSceneFetchTimeout(
      () => youtubeRowsWithoutNonFootage(rows, beat, 0, look),
      12_300,
      "a beat with 0.3s beyond the download floor"
    );
    expect(kept).toEqual(rows);
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
